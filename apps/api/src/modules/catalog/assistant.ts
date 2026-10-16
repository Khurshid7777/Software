import {
  AssistantCompareSchema,
  AssistantQuerySchema,
  AssistantRecommendSchema,
  CONDITION_RANK,
  CONDITIONS,
  formatUzs,
  listingDescription,
  listingTitle,
  t,
  type AssistantMessage,
  type AssistantResponse,
  type CatalogFilters,
  type CatalogItem,
  type CompareResponse,
  type Lang,
} from "@ishonch/shared";
import type { AiService } from "../../ai/aiService.js";
import { AiLimitExceededError, AiOutputError } from "../../ai/aiService.js";
import type { Repo } from "../../db/repo.js";
import type { User } from "../../db/schema.js";
import type { CatalogService } from "./service.js";

const LANG_NAME: Record<Lang, string> = { ru: "Russian", uz: "Uzbek (Latin script)" };
export const MAX_QUESTIONS = 2;
const CANDIDATES = 12;
export const MAX_OPTIONS = 5;

export class AssistantRejected extends Error {
  constructor(
    public code: "limit_reached" | "ai_unavailable" | "bad_request",
    public status: number,
  ) {
    super(code);
  }
}

/** Plain-language market label used in AI context and the compare table. */
function marketLabel(lang: Lang, item: CatalogItem) {
  const m = item.market;
  if (!m || m.verdict === "unknown" || m.diffPct == null) return "—";
  return t(lang, `market.${m.verdict}`, { pct: Math.abs(m.diffPct) });
}

export class AssistantService {
  constructor(
    private repo: Repo,
    private catalog: CatalogService,
    private ai: Pick<AiService, "structured">,
    private defaults: { perDay: number; usdRate: number },
  ) {}

  private async remaining(user: User) {
    const perDay = await this.repo.getSetting("assistant_per_day", this.defaults.perDay);
    return Math.max(0, perDay - (await this.repo.usedToday(user.id, "assistant_query")));
  }

  /** One unit of the daily assistant quota (questions and comparisons share it), reserved before any AI call. */
  private async reserve(user: User): Promise<number> {
    const perDay = await this.repo.getSetting("assistant_per_day", this.defaults.perDay);
    const id = await this.repo.reserveDaily(user.id, "assistant_query", perDay);
    if (id === null) throw new AssistantRejected("limit_reached", 429);
    return id;
  }

  /** An AI failure is not the user's fault: the reserved quota unit is given back. */
  private async withAi<T>(fn: () => Promise<T>, reservation: number) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AiLimitExceededError || err instanceof AiOutputError) {
        await this.repo.refundDaily(reservation);
        throw new AssistantRejected("ai_unavailable", 503);
      }
      throw err;
    }
  }

  async ask(user: User, lang: Lang, messages: AssistantMessage[]): Promise<AssistantResponse> {
    const history = messages.slice(-10);
    if (!history.length || history.at(-1)!.role !== "user") throw new AssistantRejected("bad_request", 400);
    const reservation = await this.reserve(user);

    // Count questions the assistant has already asked (each assistant turn with "?" lines).
    const asked = history
      .filter((m) => m.role === "assistant")
      .reduce((n, m) => n + (m.content.match(/\?/g)?.length ?? 0), 0);

    // 1. Understand (economical model).
    const q = await this.withAi(() =>
      this.ai.structured({
        feature: "assistant.query",
        promptId: "assistant_query",
        vars: { lang_name: LANG_NAME[lang], usd_rate: this.defaults.usdRate, asked: Math.min(asked, MAX_QUESTIONS) },
        content: [{ type: "text", text: history.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n") }],
        schema: AssistantQuerySchema,
      }), reservation);
    const parsed = q.data;
    const base = { remainingToday: await this.remaining(user) };

    if (parsed.action === "off_topic") {
      return { ...base, kind: "off_topic", reply: parsed.reply, questions: [], options: [], filters: null };
    }
    if (parsed.action === "ask" && asked < MAX_QUESTIONS) {
      return {
        ...base,
        kind: "ask",
        reply: parsed.reply,
        questions: parsed.questions.slice(0, MAX_QUESTIONS - asked),
        options: [],
        filters: null,
      };
    }

    // 2. Search the real catalog.
    const f = parsed.filters;
    const minRank = f.min_condition ? CONDITION_RANK[f.min_condition] : null;
    const filters: CatalogFilters = {
      q: f.keywords ?? undefined,
      category: f.category ?? undefined,
      priceMin: f.price_min_uzs ? Math.round(f.price_min_uzs) : undefined,
      priceMax: f.price_max_uzs ? Math.round(f.price_max_uzs) : undefined,
      conditions: minRank != null ? CONDITIONS.filter((c) => CONDITION_RANK[c] >= minRank) : undefined,
      district: f.district ?? undefined,
      verifiedOnly: f.verified_only || undefined,
    };
    let ids = await this.catalog.searchIds(filters, "relevance", 0, CANDIDATES);
    if (ids.length === 0 && filters.q && filters.category) {
      // Keywords can be too narrow ("для монтажа"): fall back to the category + budget.
      ids = await this.catalog.searchIds({ ...filters, q: undefined }, "newest", 0, CANDIDATES);
    }
    if (ids.length === 0) {
      return { ...base, kind: "no_results", reply: t(lang, "assistant.no_results"), questions: [], options: [], filters };
    }
    const candidates = await this.catalog.items(ids, user);

    // 3. Recommend from real candidates only (strong model).
    const context = candidates.map((c) => ({
      id: c.listing.id,
      title: listingTitle(c.listing, lang),
      price: c.listing.price ? formatUzs(c.listing.price) : null,
      price_vs_market: marketLabel(lang, c),
      condition: c.listing.condition,
      specs: c.listing.attributes.specs,
      description: listingDescription(c.listing, lang).slice(0, 400),
      district: c.listing.district,
      seller_trust: c.trust,
      verified_shop: !!c.listing.seller?.shop?.verified,
    }));
    const rec = await this.withAi(() =>
      this.ai.structured({
        feature: "assistant.recommend",
        promptId: "assistant_recommend",
        vars: { lang_name: LANG_NAME[lang] },
        content: [{ type: "text", text: JSON.stringify({ buyer_needs: parsed.needs, request: history.at(-1)!.content, candidates: context }) }],
        schema: AssistantRecommendSchema,
      }), reservation);

    // Never show a listing the model made up: keep only ids from the candidate set.
    const byId = new Map(candidates.map((c) => [c.listing.id, c]));
    const seen = new Set<string>();
    let options = rec.data.options
      .filter((o) => byId.has(o.listing_id) && !seen.has(o.listing_id) && seen.add(o.listing_id))
      .slice(0, MAX_OPTIONS)
      .map((o) => ({ item: byId.get(o.listing_id)!, pros: o.pros.slice(0, 4), cons: o.cons.slice(0, 4), fit: o.fit }));
    if (options.length === 0) options = candidates.slice(0, 3).map((item) => ({ item, pros: [], cons: [], fit: "" }));

    return { ...base, kind: "results", reply: rec.data.summary, questions: [], options, filters };
  }

  async compare(user: User, lang: Lang, ids: string[], needs?: string): Promise<CompareResponse> {
    const unique = [...new Set(ids)];
    if (unique.length < 2 || unique.length > 3) throw new AssistantRejected("bad_request", 400);
    const items = await this.catalog.items(unique, user);
    if (items.length !== unique.length) throw new AssistantRejected("bad_request", 400);
    const reservation = await this.reserve(user);

    // The table is built from data, not by the AI.
    const rows: CompareResponse["rows"] = [
      { label: t(lang, "compare.price"), values: items.map((i) => (i.listing.price ? formatUzs(i.listing.price) : "—")) },
      { label: t(lang, "compare.market"), values: items.map((i) => marketLabel(lang, i)) },
      { label: t(lang, "compare.condition"), values: items.map((i) => (i.listing.condition ? t(lang, `condition.${i.listing.condition}`) : "—")) },
      { label: t(lang, "compare.district"), values: items.map((i) => (i.listing.district ? t(lang, `district.${i.listing.district}`) : "—")) },
      { label: t(lang, "compare.seller"), values: items.map((i) => t(lang, `trust.${i.trust}`) + (i.listing.seller?.shop?.verified ? " ✔️" : "")) },
    ];
    const specNames = [...new Set(items.flatMap((i) => i.listing.attributes.specs.map((s) => s.name)))].slice(0, 10);
    for (const name of specNames) {
      rows.push({
        label: name.replace(/_/g, " "),
        values: items.map((i) => i.listing.attributes.specs.find((s) => s.name === name)?.value ?? "—"),
      });
    }

    const res = await this.withAi(() =>
      this.ai.structured({
        feature: "assistant.compare",
        promptId: "assistant_compare",
        vars: { lang_name: LANG_NAME[lang] },
        content: [
          {
            type: "text",
            text: JSON.stringify({
              buyer_needs: needs ?? null,
              listings: items.map((i) => ({
                id: i.listing.id,
                title: listingTitle(i.listing, lang),
                description: listingDescription(i.listing, lang).slice(0, 400),
              })),
              table: rows,
            }),
          },
        ],
        schema: AssistantCompareSchema,
      }), reservation);
    const bestFor: Record<string, string> = {};
    for (const v of res.data.verdicts) if (unique.includes(v.listing_id)) bestFor[v.listing_id] = v.best_for;
    return { rows, items, summary: res.data.summary, bestFor };
  }
}
