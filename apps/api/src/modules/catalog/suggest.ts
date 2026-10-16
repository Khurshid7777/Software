import { desc, eq } from "drizzle-orm";
import { ReplySuggestionsSchema, scrubPii, type ConditionChecklist, type Lang } from "@ishonch/shared";
import { AiLimitExceededError, AiOutputError, type AiService } from "../../ai/aiService.js";
import type { Repo } from "../../db/repo.js";
import { conversationMessages, conversations, listings, type User } from "../../db/schema.js";
import { CatalogRejected, type CatalogService } from "./service.js";

/** AI reply drafts per user per day (each is one fast-model call). */
export const SUGGESTIONS_PER_DAY = 30;
/** Drafts can be sent from the bot buttons for this long. */
const SUGGESTION_TTL_MS = 30 * 60_000;
const LANG_NAME: Record<Lang, string> = { ru: "Russian", uz: "Uzbek" };

interface Stored {
  userId: string;
  items: string[];
  at: string;
}

/**
 * "💡 Варианты ответа" for sellers in the masked chat (Avito's нейро-подсказки): three ready replies drafted
 * from the listing and the last messages; the seller sends one with a tap. Faster answers → better
 * "обычно отвечает за…" and more deals.
 */
export class ReplySuggestions {
  constructor(
    private repo: Repo,
    private ai: Pick<AiService, "structured">,
    private catalog: Pick<CatalogService, "relay">,
  ) {}

  private get db() {
    return this.repo.db;
  }

  async suggest(user: User, conversationId: string): Promise<{ items: string[] }> {
    const [conv] = await this.db.select().from(conversations).where(eq(conversations.id, conversationId));
    if (!conv || conv.sellerUserId !== user.id) throw new CatalogRejected("not_found", 404);
    const [l] = await this.db.select().from(listings).where(eq(listings.id, conv.listingId));
    if (!l) throw new CatalogRejected("not_found", 404);
    const messages = (
      await this.db
        .select()
        .from(conversationMessages)
        .where(eq(conversationMessages.conversationId, conversationId))
        .orderBy(desc(conversationMessages.id))
        .limit(8)
    ).reverse();
    if (!messages.some((m) => m.senderUserId === conv.buyerUserId)) throw new CatalogRejected("bad_request", 400);

    const reservation = await this.repo.reserveDaily(user.id, "reply_suggest", SUGGESTIONS_PER_DAY);
    if (reservation == null) throw new CatalogRejected("suggest_limit", 429);
    const lang = user.language as Lang;
    let replies: string[];
    try {
      const res = await this.ai.structured({
        feature: "chat.suggest",
        promptId: "chat_suggest",
        vars: { lang_name: LANG_NAME[lang] },
        content: [
          {
            type: "text",
            text: JSON.stringify({
              listing: {
                title: lang === "ru" ? l.titleRu || l.titleUz : l.titleUz || l.titleRu,
                price_uzs: l.price,
                condition: l.condition,
                checklist: l.checklist as ConditionChecklist,
                delivery_modes: l.allowedDeliveryModes,
                status: l.status,
              },
              chat: messages.map((m) => ({ from: m.senderUserId === conv.buyerUserId ? "buyer" : "seller", text: m.text })),
            }),
          },
        ],
        schema: ReplySuggestionsSchema,
      });
      replies = res.data.replies;
    } catch (err) {
      await this.repo.refundDaily(reservation);
      if (err instanceof AiLimitExceededError || err instanceof AiOutputError) throw new CatalogRejected("ai_unavailable", 503);
      throw err;
    }
    // The prompt forbids contacts; the scrubber makes sure (a reply with a phone would be blocked anyway).
    const items = [...new Set(replies.map((r) => scrubPii(r).trim().slice(0, 300)).filter(Boolean))].slice(0, 3);
    if (!items.length) throw new CatalogRejected("ai_unavailable", 503);
    const stored: Stored = { userId: user.id, items, at: new Date().toISOString() };
    await this.db.update(conversations).set({ suggestions: stored }).where(eq(conversations.id, conversationId));
    await this.repo.event(user.id, "reply_suggested", { conversationId });
    return { items };
  }

  /** Sends draft `index` as the seller's message (bot button); a draft is used once. */
  async send(user: User, conversationId: string, index: number) {
    const [conv] = await this.db.select().from(conversations).where(eq(conversations.id, conversationId));
    const s = conv?.suggestions as Stored | null | undefined;
    if (!conv || !s || s.userId !== user.id) throw new CatalogRejected("not_found", 404);
    const text = s.items[index];
    if (!text || Date.now() - new Date(s.at).getTime() > SUGGESTION_TTL_MS) throw new CatalogRejected("suggest_expired", 410);
    // Relay first: if delivery fails the drafts stay and the seller can tap again.
    await this.catalog.relay(conversationId, user, text);
    await this.db.update(conversations).set({ suggestions: null }).where(eq(conversations.id, conversationId));
    await this.repo.event(user.id, "reply_suggestion_sent", { conversationId, index });
    return { ok: true, text };
  }
}
