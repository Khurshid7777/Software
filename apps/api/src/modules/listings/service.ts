import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, avg, count, desc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import {
  BUMP_INTERVAL_DAYS,
  CONDITIONS,
  DELIVERY_MODES,
  EXPIRY_REMINDER_DAYS,
  FEE_PAYERS,
  LISTING_TTL_DAYS,
  MVP_DELIVERY_MODES,
  PRIVATE_SELLER_ACTIVE_LIMIT,
  TASHKENT_DISTRICTS,
  formatUzs,
  listingDescription,
  listingTitle,
  suggestPrice,
  t,
  type Condition,
  type DeliveryMode,
  type District,
  type FeePayer,
  type Lang,
  type ListingAnalysis,
  type ListingDto,
  type ListingStatus,
  type ModerationRecord,
  type PriceSuggestion,
} from "@ishonch/shared";
import type { Repo } from "../../db/repo.js";
import { channels, listingPhotos, listings, reviews, shops, users, type Listing, type User } from "../../db/schema.js";
import { AiLimitExceededError, AiOutputError, type AiService } from "../../ai/aiService.js";
import { processImage } from "../../storage/images.js";
import type { Storage } from "../../storage/storage.js";
import { SttUnavailableError, type SpeechToText } from "../../stt/speechToText.js";
import { buildCaption, type ChannelPublisher, type Notifier } from "../../telegram/publisher.js";
import type { StaffNotifier } from "../../telegram/staff.js";
import { hasContactInfo, type ModerationService } from "../moderation/service.js";
import { analyzeListing, generateListingText } from "./ai.js";

export const MAX_PHOTOS = 10;
const DAY = 24 * 3600_000;

export type ListingError =
  | "need_photo_or_voice"
  | "too_many_photos"
  | "voice_unavailable"
  | "ai_unavailable"
  | "not_found"
  | "forbidden"
  | "bad_state"
  | "phone_required"
  | "need_photo"
  | "fill_required"
  | "limit_reached"
  | "bump_too_soon"
  | "bad_image"
  | "contact_info"
  | "duplicate";

export class ListingRejected extends Error {
  constructor(
    public code: ListingError,
    public status: number,
    public params: Record<string, string | number> = {},
  ) {
    super(code);
  }
}

interface AiDraft {
  analysis?: ListingAnalysis;
  transcript?: string;
  answers?: Record<string, string>;
}

export const ListingPatchSchema = z
  .object({
    titleRu: z.string().trim().max(120),
    titleUz: z.string().trim().max(120),
    descriptionRu: z.string().trim().max(4000),
    descriptionUz: z.string().trim().max(4000),
    price: z.number().int().positive().max(10_000_000_000).nullable(),
    condition: z.enum(CONDITIONS).nullable(),
    district: z.enum(TASHKENT_DISTRICTS).nullable(),
    allowedDeliveryModes: z.array(z.enum(DELIVERY_MODES)).min(1),
    feePayer: z.enum(FEE_PAYERS),
  })
  .partial();
export type ListingPatch = z.infer<typeof ListingPatchSchema>;

export interface UploadedFile {
  data: Buffer;
  mimeType: string;
}

export interface ListingServiceDeps {
  repo: Repo;
  ai: Pick<AiService, "structured">;
  storage: Storage;
  stt: SpeechToText;
  publisher: ChannelPublisher | null;
  /** Direct messages to sellers (moderation results, expiry reminders). */
  notifier?: Notifier | null;
  staff?: StaffNotifier;
  /** Duplicate search + AI pre-moderation; null = publish without moderation. */
  moderation?: ModerationService | null;
  photoSecret: string;
  usdRate: number;
  /** Feature flag: `cod_platform` stays off until there is a legal entity and a courier contract. */
  codPlatformEnabled: boolean;
  /** Hook for saved-search alerts (module A). Failures never block publication. */
  onPublished?: (listingId: string) => Promise<unknown>;
}

export class ListingService {
  constructor(private d: ListingServiceDeps) {}

  private get db() {
    return this.d.repo.db;
  }

  // ---------- photos ----------
  photoUrl(photoId: number, key: string) {
    return `/photos/${photoId}?s=${this.sign(`${photoId}:${key}`)}`;
  }

  private sign(v: string) {
    return createHmac("sha256", this.d.photoSecret).update(v).digest("base64url").slice(0, 22);
  }

  async readPhoto(photoId: number, sig: string): Promise<Buffer | null> {
    const [p] = await this.db.select().from(listingPhotos).where(eq(listingPhotos.id, photoId));
    if (!p) return null;
    const expected = Buffer.from(this.sign(`${p.id}:${p.storageKey}`));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    return this.d.storage.get(p.storageKey);
  }

  private async storePhotos(listingId: string, files: UploadedFile[], startPosition: number) {
    const aiImages: Buffer[] = [];
    for (const [i, f] of files.entries()) {
      let img;
      try {
        img = await processImage(f.data);
      } catch {
        throw new ListingRejected("bad_image", 400);
      }
      const key = `listings/${listingId}/${Date.now()}-${randomBytes(6).toString("hex")}.jpg`;
      await this.d.storage.put(key, img.full, "image/jpeg");
      await this.db.insert(listingPhotos).values({
        listingId,
        storageKey: key,
        phash: img.phash,
        width: img.width,
        height: img.height,
        position: startPosition + i,
      });
      aiImages.push(img.ai);
    }
    return aiImages;
  }

  // ---------- creation ----------
  async createDraft(user: User, input: { photos: UploadedFile[]; audio?: UploadedFile; text?: string }) {
    const text = input.text?.trim() || undefined;
    if (input.photos.length === 0 && !input.audio && !text) throw new ListingRejected("need_photo_or_voice", 400);
    if (input.photos.length > MAX_PHOTOS) throw new ListingRejected("too_many_photos", 400);

    let transcript: string | undefined;
    if (input.audio) {
      try {
        transcript = await this.d.stt.transcribe(input.audio.data, { mimeType: input.audio.mimeType });
      } catch (err) {
        if (!(err instanceof SttUnavailableError)) throw err;
        if (input.photos.length === 0 && !text) throw new ListingRejected("voice_unavailable", 503);
      }
    }

    const [row] = await this.db
      .insert(listings)
      .values({ sellerUserId: user.id, status: "draft", sourceText: text ?? null })
      .returning();
    const listing = row!;

    try {
      const aiImages = await this.storePhotos(listing.id, input.photos, 0);
      const { analysis, priceSuggestion } = await this.withAi(() =>
        analyzeListing(
          { images: aiImages, transcript, text },
          {
            ai: this.d.ai,
            usdRate: this.d.usdRate,
            findReferencePrice: (k) => this.d.repo.findReferencePrice(k),
          },
        ),
      );
      const aiDraft: AiDraft = { analysis, transcript, answers: {} };
      await this.db
        .update(listings)
        .set({
          category: analysis.category,
          attributes: { brand: analysis.brand, model: analysis.model, modelKey: analysis.model_key, specs: analysis.specs },
          condition: analysis.condition === "unknown" ? null : analysis.condition,
          price: priceSuggestion?.market ?? null,
          priceSuggestion,
          aiDraft,
          updatedAt: new Date(),
        })
        .where(eq(listings.id, listing.id));
    } catch (err) {
      await this.deleteListing(listing.id);
      throw err;
    }
    await this.d.repo.event(user.id, "listing_draft_created", { photos: input.photos.length, voice: !!input.audio });
    return this.dto(listing.id, user.id);
  }

  async generate(user: User, id: string, answers: Record<string, string>) {
    const l = await this.own(user, id);
    if (!["draft", "active"].includes(l.status)) throw new ListingRejected("bad_state", 409);
    const draft = l.aiDraft as AiDraft;
    if (!draft.analysis) throw new ListingRejected("bad_state", 409);

    const merged = { ...(draft.answers ?? {}), ...answers };
    const sellerWords = [draft.transcript, l.sourceText].filter(Boolean).join("\n");
    const { text } = await this.withAi(() =>
      generateListingText({ analysis: draft.analysis!, answers: merged, sellerWords }, { ai: this.d.ai }),
    );

    // Answers can change the model key (e.g. storage) → refresh the price suggestion.
    let priceSuggestion = l.priceSuggestion as PriceSuggestion | null;
    const oldMarket = priceSuggestion?.market ?? null;
    const storage = merged.storage?.match(/\d+\s*(gb|гб|tb|тб)/i)?.[0];
    const modelKey = draft.analysis.model_key;
    if (storage && modelKey && !/\d+\s*(gb|tb)/.test(modelKey)) {
      const ref = await this.d.repo.findReferencePrice(`${modelKey} ${storage}`);
      if (ref) priceSuggestion = suggestPrice(ref, "reference");
    }

    await this.db
      .update(listings)
      .set({
        titleRu: text.title_ru,
        titleUz: text.title_uz,
        descriptionRu: text.description_ru,
        descriptionUz: text.description_uz,
        aiDraft: { ...draft, answers: merged },
        priceSuggestion,
        // Keep a price the seller typed; otherwise follow the (possibly refreshed) suggestion.
        price: l.price == null || l.price === oldMarket ? (priceSuggestion?.market ?? l.price) : l.price,
        updatedAt: new Date(),
      })
      .where(eq(listings.id, id));
    return this.dto(id, user.id);
  }

  async update(user: User, id: string, patch: ListingPatch) {
    const l = await this.own(user, id);
    if (!["draft", "active", "pending", "rejected", "reserved"].includes(l.status)) throw new ListingRejected("bad_state", 409);
    const modes = patch.allowedDeliveryModes?.filter((m) => this.d.codPlatformEnabled || MVP_DELIVERY_MODES.includes(m));
    if (modes && modes.length === 0) throw new ListingRejected("fill_required", 400);
    const textChanged = (["titleRu", "titleUz", "descriptionRu", "descriptionUz"] as const).some(
      (k) => patch[k] !== undefined && patch[k] !== l[k],
    );
    if (textChanged && l.status !== "draft" && hasContactInfo({ ...l, ...patch })) throw new ListingRejected("contact_info", 400);
    await this.db
      .update(listings)
      .set({ ...patch, ...(modes ? { allowedDeliveryModes: modes } : {}), updatedAt: new Date() })
      .where(eq(listings.id, id));
    // A live listing whose text changed goes through moderation again (it could be swapped for something else).
    if (textChanged && l.status === "active" && this.d.moderation) {
      const [fresh] = await this.db.select().from(listings).where(eq(listings.id, id));
      const record = await this.d.moderation.review(fresh!);
      if (record.decision !== "approved") await this.holdForModeration(fresh!, record);
      else await this.db.update(listings).set({ moderation: record }).where(eq(listings.id, id));
    }
    return this.dto(id, user.id);
  }

  async addPhotos(user: User, id: string, files: UploadedFile[]) {
    const l = await this.own(user, id);
    if (!["draft", "active", "pending", "rejected"].includes(l.status)) throw new ListingRejected("bad_state", 409);
    const [{ n }] = (await this.db
      .select({ n: count() })
      .from(listingPhotos)
      .where(eq(listingPhotos.listingId, id))) as [{ n: number }];
    if (n + files.length > MAX_PHOTOS) throw new ListingRejected("too_many_photos", 400);
    await this.storePhotos(id, files, n);
    return this.dto(id, user.id);
  }

  async deletePhoto(user: User, id: string, photoId: number) {
    await this.own(user, id);
    const [p] = await this.db
      .delete(listingPhotos)
      .where(and(eq(listingPhotos.id, photoId), eq(listingPhotos.listingId, id)))
      .returning();
    if (p) await this.d.storage.delete(p.storageKey);
    return this.dto(id, user.id);
  }

  // ---------- publication ----------
  /**
   * Draft / archived / rejected → moderation → active (or pending for a moderator, or rejected).
   * Order: required fields → contact info in text → own duplicates → limit → duplicates of others + AI review.
   */
  async publish(user: User, id: string, channelIds: number[] = []) {
    const l = await this.own(user, id);
    if (!["draft", "archived", "rejected"].includes(l.status)) throw new ListingRejected("bad_state", 409);
    if (!user.phone) throw new ListingRejected("phone_required", 409);
    if (!l.titleRu || !l.titleUz || !l.descriptionRu || !l.descriptionUz || !l.price) {
      throw new ListingRejected("fill_required", 400);
    }
    const [{ photos }] = (await this.db
      .select({ photos: count() })
      .from(listingPhotos)
      .where(eq(listingPhotos.listingId, id))) as [{ photos: number }];
    if (photos === 0) throw new ListingRejected("need_photo", 400);
    if (hasContactInfo(l)) throw new ListingRejected("contact_info", 400);

    const shop = await this.shopOf(user.id);
    const duplicates = this.d.moderation ? await this.d.moderation.findDuplicates(l) : null;
    // The same photos in another live listing of this seller: bump that one instead (shops may sell identical stock).
    if (duplicates?.own.length && !shop) throw new ListingRejected("duplicate", 409, { id: duplicates.own[0]! });
    await this.assertUnderLimit(user);

    const record: ModerationRecord = this.d.moderation
      ? await this.d.moderation.review(l, duplicates!)
      : { decision: "approved", source: "rules", reasons: [], at: new Date().toISOString() };
    await this.db.update(listings).set({ shopId: shop?.id ?? null }).where(eq(listings.id, id));
    if (user.role === "buyer") await this.db.update(users).set({ role: "seller" }).where(eq(users.id, user.id));

    if (record.decision !== "approved") {
      await this.holdForModeration({ ...l, shopId: shop?.id ?? null }, { ...record, pendingChannelIds: channelIds }, { notifySeller: false });
      await this.d.repo.event(user.id, "listing_moderation", { listingId: id, decision: record.decision, source: record.source });
      return { listing: await this.dto(id, user.id), postedChannels: 0, failedChannels: 0, moderation: record.decision };
    }
    const posted = await this.activate(id, channelIds, record);
    await this.d.repo.event(user.id, "listing_published", { listingId: id, channels: posted.length });
    return {
      listing: await this.dto(id, user.id),
      postedChannels: posted.length,
      failedChannels: channelIds.length - posted.length,
      moderation: record.decision,
    };
  }

  /** Makes a listing live: 30 days from now, channel posts, saved-search alerts. Used by publish and admin approval. */
  async activate(id: string, channelIds: number[], record: ModerationRecord) {
    const [l] = await this.db.select().from(listings).where(eq(listings.id, id));
    if (!l) throw new ListingRejected("not_found", 404);
    const now = new Date();
    await this.db
      .update(listings)
      .set({
        status: "active",
        moderation: record,
        moderationReason: null,
        publishedAt: l.publishedAt ?? now,
        bumpedAt: now,
        expiresAt: new Date(now.getTime() + LISTING_TTL_DAYS * DAY),
        expiryRemindedAt: null,
        updatedAt: now,
      })
      .where(eq(listings.id, id));
    const [seller] = await this.db.select().from(users).where(eq(users.id, l.sellerUserId));
    const posted = seller ? await this.postToChannels(seller, id, channelIds) : [];
    await this.d.onPublished?.(id).catch((err) => console.error("onPublished failed", err));
    return posted;
  }

  /** needs_review → pending (moderators are asked), rejected → rejected (the seller is told why). */
  async holdForModeration(l: Listing, record: ModerationRecord, opts: { notifySeller?: boolean } = {}) {
    const status = record.decision === "rejected" ? "rejected" : "pending";
    const reason = record.reasons[0]?.code ?? "other";
    await this.db
      .update(listings)
      .set({ status, moderation: record, moderationReason: reason, updatedAt: new Date() })
      .where(eq(listings.id, l.id));
    if (status === "pending") {
      const notes = record.reasons.map((r) => `• ${r.code}: ${r.note}`).join("\n");
      const url = this.d.publisher ? await this.d.publisher.miniAppLink(`listing_${l.id}`).catch(() => null) : null;
      await this.d.staff?.moderators(
        t("ru", "staff.moderation_pending", { title: l.titleRu || l.titleUz, price: l.price ? formatUzs(l.price) : "—", notes }),
        [
          [
            { text: "✅ Одобрить", callbackData: `mod:approve:${l.id}` },
            { text: "⛔️ Отклонить", callbackData: `mod:reject:${l.id}` },
          ],
          ...(url ? [[{ text: "Открыть", url }]] : []),
        ],
      );
    }
    if (opts.notifySeller !== false) await this.notifySeller(l, status === "pending" ? "moderation.hidden" : "moderation.rejected", record);
  }

  /** Seller DM about a moderation outcome; the AI's own advice is appended when present. */
  async notifySeller(l: Listing, key: "moderation.hidden" | "moderation.rejected" | "moderation.approved", record?: ModerationRecord | null) {
    if (!this.d.notifier) return;
    const [seller] = await this.db.select().from(users).where(eq(users.id, l.sellerUserId));
    if (!seller) return;
    const lang = seller.language as Lang;
    const advice = record?.sellerMessage?.[lang];
    const text = t(lang, key, { title: listingTitle(l, lang) }) + (advice ? `\n\n${advice}` : "");
    const url = this.d.publisher ? await this.d.publisher.miniAppLink("screen_my").catch(() => null) : null;
    await this.d.notifier
      .send(seller.telegramId, text, url ? [[{ text: t(lang, "home.my.title"), url }]] : [])
      .catch((err) => console.error("seller notification failed", err));
  }

  private async assertUnderLimit(user: User) {
    if (user.role === "shop" || user.role === "admin") return;
    const [{ n }] = (await this.db
      .select({ n: count() })
      .from(listings)
      .where(and(eq(listings.sellerUserId, user.id), inArray(listings.status, ["active", "pending", "reserved"])))) as [
      { n: number },
    ];
    if (n >= PRIVATE_SELLER_ACTIVE_LIMIT) throw new ListingRejected("limit_reached", 409, { n: PRIVATE_SELLER_ACTIVE_LIMIT });
  }

  private async postToChannels(user: User, id: string, channelIds: number[]) {
    if (!this.d.publisher || channelIds.length === 0) return [];
    const own = await this.db
      .select()
      .from(channels)
      .where(and(eq(channels.userId, user.id), inArray(channels.id, channelIds)));
    if (own.length === 0) return [];

    const dto = await this.dto(id, user.id);
    const lang = user.language as Lang;
    const [first] = await this.db
      .select()
      .from(listingPhotos)
      .where(eq(listingPhotos.listingId, id))
      .orderBy(asc(listingPhotos.position))
      .limit(1);
    const photo = first ? await this.d.storage.get(first.storageKey) : null;
    const meta = [
      dto.condition ? `${t(lang, "sell.field.condition")}: ${t(lang, `condition.${dto.condition}`)}` : null,
      `📍 ${lang === "ru" ? "Ташкент" : "Toshkent"}${dto.district ? `, ${t(lang, `district.${dto.district}`)}` : ""}`,
    ].filter((x): x is string => !!x);
    const caption = buildCaption({
      title: listingTitle(dto, lang),
      price: dto.price ? formatUzs(dto.price) : null,
      meta,
      description: listingDescription(dto, lang),
      footer: "#Ishonch",
    });
    const url = await this.d.publisher.miniAppLink(`listing_${id}`);

    const posted: Array<{ channelId: number; messageId: number; at: string }> = [];
    await Promise.all(
      own.map(async (ch) => {
        try {
          const { messageId } = await this.d.publisher!.post(ch.telegramChannelId, {
            photo,
            caption,
            button: { text: t(lang, "listing.buy_delivery"), url },
          });
          posted.push({ channelId: ch.id, messageId, at: new Date().toISOString() });
        } catch (err) {
          console.error("channel post failed", ch.telegramChannelId, err);
        }
      }),
    );
    if (posted.length) {
      await this.db
        .update(listings)
        .set({ channelPosts: sql`${listings.channelPosts} || ${JSON.stringify(posted)}::jsonb` })
        .where(eq(listings.id, id));
    }
    return posted;
  }

  // ---------- management ----------
  async markSold(user: User, id: string, via: "platform" | "elsewhere") {
    const l = await this.own(user, id);
    // A reserved listing is sold through its delivery order (or the order is cancelled first).
    if (!["active", "pending", "archived"].includes(l.status)) throw new ListingRejected("bad_state", 409);
    await this.db.update(listings).set({ status: "sold", soldVia: via, soldAt: new Date(), updatedAt: new Date() }).where(eq(listings.id, id));
    await this.d.repo.event(user.id, "listing_sold", { listingId: id, via });
    return this.dto(id, user.id);
  }

  async archive(user: User, id: string) {
    const l = await this.own(user, id);
    if (!["active", "pending", "draft", "rejected"].includes(l.status)) throw new ListingRejected("bad_state", 409);
    await this.db.update(listings).set({ status: "archived", moderationReason: null, updatedAt: new Date() }).where(eq(listings.id, id));
    return this.dto(id, user.id);
  }

  async bump(user: User, id: string) {
    const l = await this.own(user, id);
    if (l.status !== "active") throw new ListingRejected("bad_state", 409);
    const next = l.bumpedAt ? new Date(l.bumpedAt.getTime() + BUMP_INTERVAL_DAYS * DAY) : null;
    if (next && next > new Date()) throw new ListingRejected("bump_too_soon", 429, { date: next.toISOString() });
    await this.db.update(listings).set({ bumpedAt: new Date() }).where(eq(listings.id, id));
    return this.dto(id, user.id);
  }

  /** Extends an active listing (or one archived on expiry) by another 30 days. */
  async renew(user: User, id: string) {
    const l = await this.own(user, id);
    const expired = l.status === "archived" && l.moderationReason === "expired";
    if (l.status !== "active" && !expired) throw new ListingRejected("bad_state", 409);
    if (expired) await this.assertUnderLimit(user);
    const now = new Date();
    await this.db
      .update(listings)
      .set({
        status: "active",
        moderationReason: null,
        expiresAt: new Date(now.getTime() + LISTING_TTL_DAYS * DAY),
        expiryRemindedAt: null,
        ...(expired ? { bumpedAt: now } : {}),
        updatedAt: now,
      })
      .where(eq(listings.id, id));
    await this.d.repo.event(user.id, "listing_renewed", { listingId: id, expired });
    return this.dto(id, user.id);
  }

  /**
   * Hourly job: reminds sellers 3 days before expiry (button "Renew") and archives expired listings.
   * Returns counts for logs/tests.
   */
  async runExpiry(now = new Date()) {
    const soon = new Date(now.getTime() + EXPIRY_REMINDER_DAYS * DAY);
    const toRemind = await this.db
      .select()
      .from(listings)
      .where(and(eq(listings.status, "active"), lte(listings.expiresAt, soon), gt(listings.expiresAt, now), isNull(listings.expiryRemindedAt)))
      .limit(500);
    let reminded = 0;
    for (const l of toRemind) {
      // Claim first so a second API instance does not send the same reminder.
      const claimed = await this.db
        .update(listings)
        .set({ expiryRemindedAt: now })
        .where(and(eq(listings.id, l.id), isNull(listings.expiryRemindedAt)))
        .returning({ id: listings.id });
      if (!claimed.length) continue;
      if (await this.dmSeller(l, "expiry.reminder", [{ key: "expiry.renew", callbackData: `renew:${l.id}` }])) reminded++;
    }

    const expired = await this.db
      .update(listings)
      .set({ status: "archived", moderationReason: "expired", updatedAt: now })
      .where(and(eq(listings.status, "active"), lte(listings.expiresAt, now)))
      .returning();
    for (const l of expired) await this.dmSeller(l, "expiry.archived", [{ key: "expiry.renew", callbackData: `renew:${l.id}` }]);
    return { reminded, archived: expired.length };
  }

  private async dmSeller(l: Listing, key: "expiry.reminder" | "expiry.archived", buttons: Array<{ key: "expiry.renew"; callbackData: string }>) {
    if (!this.d.notifier) return false;
    const [seller] = await this.db.select().from(users).where(eq(users.id, l.sellerUserId));
    if (!seller || seller.bannedAt) return false;
    const lang = seller.language as Lang;
    const date = l.expiresAt ? l.expiresAt.toLocaleDateString(lang === "ru" ? "ru-RU" : "uz-UZ", { timeZone: "Asia/Tashkent" }) : "";
    try {
      await this.d.notifier.send(
        seller.telegramId,
        t(lang, key, { title: listingTitle(l, lang), date }),
        [buttons.map((b) => ({ text: t(lang, b.key), callbackData: b.callbackData }))],
      );
      return true;
    } catch (err) {
      console.error("expiry notification failed", err);
      return false;
    }
  }

  /** Tabs: "active" also shows reserved listings, "pending" also shows rejected ones. */
  async mine(user: User, status?: ListingStatus) {
    const statuses = status === "active" ? ["active", "reserved"] : status === "pending" ? ["pending", "rejected"] : status ? [status] : null;
    const rows = await this.db
      .select({ id: listings.id })
      .from(listings)
      .where(and(eq(listings.sellerUserId, user.id), statuses ? inArray(listings.status, statuses) : undefined))
      .orderBy(desc(listings.updatedAt));
    return Promise.all(rows.map((r) => this.dto(r.id, user.id)));
  }

  /** Public card. Counts a view when the viewer is not the seller. */
  async view(id: string, viewer: User | null) {
    const [l] = await this.db.select().from(listings).where(eq(listings.id, id));
    if (!l) throw new ListingRejected("not_found", 404);
    const isOwner = viewer?.id === l.sellerUserId;
    // Staff open any listing (moderation queue, complaints, orders) without counting a view.
    const isStaff = viewer?.role === "admin" || viewer?.role === "operator";
    if (!isOwner && !isStaff && !["active", "reserved", "sold"].includes(l.status)) throw new ListingRejected("not_found", 404);
    if (!isOwner && !isStaff && l.status === "active") {
      await this.db.update(listings).set({ views: sql`${listings.views} + 1` }).where(eq(listings.id, id));
      if (viewer) await this.d.repo.event(viewer.id, "listing_viewed", { listingId: id });
    }
    return this.dto(id, viewer?.id ?? null, { withSeller: true });
  }

  async deleteDraft(user: User, id: string) {
    const l = await this.own(user, id);
    if (l.status !== "draft") throw new ListingRejected("bad_state", 409);
    await this.deleteListing(id);
  }

  // ---------- helpers ----------
  private async withAi<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AiLimitExceededError || err instanceof AiOutputError) throw new ListingRejected("ai_unavailable", 503);
      throw err;
    }
  }

  private async deleteListing(id: string) {
    const photos = await this.db.select().from(listingPhotos).where(eq(listingPhotos.listingId, id));
    await Promise.all(photos.map((p) => this.d.storage.delete(p.storageKey).catch(() => undefined)));
    await this.db.delete(listings).where(eq(listings.id, id));
  }

  private async own(user: User, id: string): Promise<Listing> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ListingRejected("not_found", 404);
    const [l] = await this.db.select().from(listings).where(eq(listings.id, id));
    if (!l) throw new ListingRejected("not_found", 404);
    if (l.sellerUserId !== user.id) throw new ListingRejected("forbidden", 403);
    return l;
  }

  private async shopOf(userId: string) {
    const [s] = await this.db.select().from(shops).where(eq(shops.ownerUserId, userId));
    return s ?? null;
  }

  async sellerRating(sellerId: string) {
    const [r] = await this.db
      .select({ avg: avg(reviews.rating), n: count() })
      .from(reviews)
      .where(eq(reviews.sellerUserId, sellerId));
    return { avg: r?.n ? Math.round(Number(r.avg) * 10) / 10 : null, count: r?.n ?? 0 };
  }

  private async langOf(userId: string): Promise<Lang | null> {
    const [u] = await this.db.select({ language: users.language }).from(users).where(eq(users.id, userId));
    return (u?.language as Lang | undefined) ?? null;
  }

  async dto(id: string, viewerId: string | null, opts: { withSeller?: boolean } = {}): Promise<ListingDto> {
    const [l] = await this.db.select().from(listings).where(eq(listings.id, id));
    if (!l) throw new ListingRejected("not_found", 404);
    const photos = await this.db
      .select()
      .from(listingPhotos)
      .where(eq(listingPhotos.listingId, id))
      .orderBy(asc(listingPhotos.position), asc(listingPhotos.id));
    const draft = l.aiDraft as AiDraft;
    const isOwner = viewerId === l.sellerUserId;
    const attrs = l.attributes as ListingDto["attributes"];

    const dto: ListingDto = {
      id: l.id,
      status: l.status as ListingStatus,
      category: l.category as ListingDto["category"],
      titleRu: l.titleRu,
      titleUz: l.titleUz,
      descriptionRu: l.descriptionRu,
      descriptionUz: l.descriptionUz,
      attributes: { brand: attrs.brand ?? null, model: attrs.model ?? null, modelKey: attrs.modelKey ?? null, specs: attrs.specs ?? [] },
      condition: (l.condition as Condition | null) ?? null,
      price: l.price,
      currency: "UZS",
      district: (l.district as District | null) ?? null,
      allowedDeliveryModes: l.allowedDeliveryModes as DeliveryMode[],
      feePayer: l.feePayer as FeePayer,
      photos: photos.map((p) => ({ id: p.id, url: this.photoUrl(p.id, p.storageKey), position: p.position })),
      priceSuggestion: (l.priceSuggestion as PriceSuggestion | null) ?? null,
      questions: isOwner ? (draft.analysis?.questions ?? []) : [],
      photoHints: isOwner ? (draft.analysis?.photo_hints ?? []) : [],
      stats: { views: l.views, favorites: l.favoritesCount, requests: l.requestsCount },
      createdAt: l.createdAt.toISOString(),
      publishedAt: l.publishedAt?.toISOString() ?? null,
      bumpedAt: l.bumpedAt?.toISOString() ?? null,
      canBumpAt: l.bumpedAt ? new Date(l.bumpedAt.getTime() + BUMP_INTERVAL_DAYS * DAY).toISOString() : null,
      expiresAt: l.expiresAt?.toISOString() ?? null,
      soldVia: (l.soldVia as ListingDto["soldVia"]) ?? null,
      moderation: null,
    };
    if (isOwner && l.moderationReason) {
      const record = l.moderation as ModerationRecord | null;
      const lang = (await this.langOf(l.sellerUserId)) ?? "ru";
      dto.moderation = { reason: l.moderationReason, message: record?.sellerMessage?.[lang] ?? null };
    }

    if (opts.withSeller) {
      const [seller] = await this.db.select().from(users).where(eq(users.id, l.sellerUserId));
      const [{ sales }] = (await this.db
        .select({ sales: count() })
        .from(listings)
        .where(and(eq(listings.sellerUserId, l.sellerUserId), eq(listings.soldVia, "platform")))) as [{ sales: number }];
      const shop = await this.shopOf(l.sellerUserId);
      dto.seller = {
        id: l.sellerUserId,
        registeredAt: seller!.createdAt.toISOString(),
        platformSales: sales,
        rating: await this.sellerRating(l.sellerUserId),
        shop: shop ? { id: shop.id, name: shop.name, verified: shop.verified, marketLocation: shop.marketLocation } : null,
      };
    }
    if (!isOwner) {
      dto.stats = { views: 0, favorites: 0, requests: 0 };
      dto.priceSuggestion = null;
    }
    return dto;
  }
}
