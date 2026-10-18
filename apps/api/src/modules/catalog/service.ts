import { and, asc, count, desc, eq, gte, inArray, lt, ne, sql, type SQL } from "drizzle-orm";
import {
  ACCOUNT_CATEGORIES,
  GOOD_GRADES,
  computeGrade,
  type ItemHistory,
  type ItemPassport,
  type PassportCheck,
  CONDITION_FACTOR,
  VALUATION_HISTORY_MONTHS,
  normalizeModelKey,
  suggestPrice,
  type Condition,
  type Valuation,
  canonicalQuery,
  canonicalWord,
  IMEI_CATEGORIES,
  checklistEmpty,
  checklistFields,
  SELLER_PAGE_LIMIT,
  formatUzs,
  listingTitle,
  priceVerdict,
  sameModel,
  sellerTrust,
  t,
  type CatalogFilters,
  type CatalogItem,
  type CatalogPage,
  type CatalogSort,
  type ConditionChecklist,
  type Lang,
  type ListingInsights,
  type ListingDto,
  type MarketRange,
  type PriceSource,
  type PriceVerdict,
} from "@ishonch/shared";
import type { Repo } from "../../db/repo.js";
import { startOfTashkentDay } from "../../db/repo.js";
import {
  botPendingReplies,
  conversationMessages,
  conversations,
  favorites,
  listings,
  orders,
  savedSearches,
  searchNotifications,
  shops,
  users,
  type User,
} from "../../db/schema.js";
import type { ChannelPublisher, Notifier, NotifyButton } from "../../telegram/publisher.js";
import { unsubscribeRow, type ListingService } from "../listings/service.js";

export const PAGE_SIZE = 20;
/** Statuses anyone may see. */
export const PUBLIC_STATUSES = ["active", "reserved", "sold"];
export const MAX_NEW_CONVERSATIONS_PER_DAY = 20;
export const MAX_SEARCH_ALERTS_PER_DAY = 3;
export const MAX_SAVED_SEARCHES = 20;
/** Messages one participant may send in one conversation per hour (the other side gets a DM for each). */
export const MAX_MESSAGES_PER_HOUR = 30;
const DAY = 24 * 3600_000;

/** True when either user blocked the other (stage 19, user_blocks). */
export async function blockedBetween(db: Repo["db"], a: string, b: string) {
  const rows = await db.execute(sql`
    select 1 from user_blocks
    where (blocker_user_id = ${a} and blocked_user_id = ${b}) or (blocker_user_id = ${b} and blocked_user_id = ${a}) limit 1`);
  return (rows as unknown as unknown[]).length > 0;
}

export class CatalogRejected extends Error {
  constructor(
    public code:
      | "blocked"
      | "not_found"
      | "own_listing"
      | "contact_limit"
      | "seller_unreachable"
      | "bad_request"
      | "too_many_searches"
      | "message_limit"
      | "suggest_limit"
      | "suggest_expired"
      | "ai_unavailable",
    public status: number,
  ) {
    super(code);
  }
}

interface MarketCacheEntry {
  range: MarketRange | null;
  source: PriceSource;
  at: number;
}

/** Quantile on a sorted array (linear interpolation). */
function quantile(sorted: number[], q: number) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return Math.round(sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo));
}

/**
 * Text → tsquery parts. Russian: stemmed (plainto_tsquery). Uzbek has no stemmer in PostgreSQL,
 * so for the "simple" dictionary every word becomes a prefix match: "noutbuk" finds "noutbuki".
 */
export function prefixQuery(q: string): string | null {
  const words = q
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .map((w) => w.replace(/'/g, ""))
    .filter((w) => w.length >= 2)
    .slice(0, 8);
  return words.length
    ? words
        .map((w) => {
          const c = canonicalWord(w);
          return c ? `(${w}:* | ${c.replace(/[^\p{L}\p{N}]/gu, "")}:*)` : `${w}:*`;
        })
        .join(" & ")
    : null;
}

function tsQuery(q: string) {
  const prefix = prefixQuery(q);
  return prefix
    ? sql`(plainto_tsquery('russian', ${q}) || to_tsquery('simple', ${prefix}))`
    : sql`plainto_tsquery('russian', ${q})`;
}

export class CatalogService {
  private marketCache = new Map<string, MarketCacheEntry>();

  constructor(
    private repo: Repo,
    private listingsSvc: ListingService,
    private notifier: (Notifier & Pick<ChannelPublisher, "miniAppLink">) | null,
  ) {}

  private get db() {
    return this.repo.db;
  }

  // ---------- search ----------
  private conditions(f: CatalogFilters): SQL[] {
    const c: SQL[] = [
      sql`${listings.status} = 'active'`,
      sql`(${listings.expiresAt} is null or ${listings.expiresAt} > now())`,
    ];
    if (f.category) c.push(eq(listings.category, f.category));
    if (f.priceMin != null) c.push(gte(listings.price, f.priceMin));
    if (f.priceMax != null) c.push(sql`${listings.price} <= ${f.priceMax}`);
    if (f.conditions?.length) c.push(inArray(listings.condition, f.conditions));
    if (f.district) c.push(eq(listings.district, f.district));
    if (f.goodGrade) c.push(inArray(listings.grade, GOOD_GRADES));
    if (f.verifiedOnly) {
      c.push(sql`exists (select 1 from ${shops} where ${shops.id} = ${listings.shopId} and ${shops.verified})`);
    }
    const q = f.q?.trim().toLowerCase();
    if (q) {
      // Full text (Russian stemming + "simple" for Uzbek/model names) OR fuzzy title match for typos.
      // The fuzzy branch forgives typos in words, never in model numbers: every token with a digit
      // ("13", "s23", "a54") must appear as a whole word, so "iphone 13" does not match "iPhone 10".
      const canon = canonicalQuery(q);
      const numbered = [...new Set(canon.split(/[^\p{L}\p{N}]+/u).filter((w) => /\d/.test(w)))].slice(0, 4);
      const title = sql`lower(${listings.titleRu} || ' ' || ${listings.titleUz})`;
      const numbersMatch = numbered.length
        ? sql.join(
            numbered.map((w) => sql`${title} ~ ${`(^|[^[:alnum:]])${w}([^[:alnum:]]|$)`}`),
            sql` and `,
          )
        : sql`true`;
      c.push(sql`("listings"."search_vector" @@ ${tsQuery(q)}
        or (${canon} <% ${title} and ${numbersMatch}))`);
    }
    return c;
  }

  async searchIds(f: CatalogFilters, sort: CatalogSort, offset: number, limit: number, extra: SQL[] = []) {
    const q = f.q?.trim().toLowerCase();
    const rank = q
      ? sql`ts_rank("listings"."search_vector", ${tsQuery(q)})
          + word_similarity(${canonicalQuery(q)}, lower(${listings.titleRu} || ' ' || ${listings.titleUz}))`
      : sql`0`;
    const order =
      sort === "price_asc"
        ? [asc(listings.price)]
        : sort === "price_desc"
          ? [desc(listings.price)]
          : sort === "relevance" && q
            ? [desc(rank), desc(listings.bumpedAt)]
            : [desc(listings.bumpedAt)];
    const rows = await this.db
      .select({ id: listings.id })
      .from(listings)
      .where(and(...this.conditions(f), ...extra))
      .orderBy(...order, desc(listings.id))
      .limit(limit)
      .offset(offset);
    return rows.map((r) => r.id);
  }

  async search(f: CatalogFilters, sort: CatalogSort, offset: number, viewer: User | null): Promise<CatalogPage> {
    const ids = await this.searchIds(f, sort, offset, PAGE_SIZE + 1);
    const items = await this.items(ids.slice(0, PAGE_SIZE), viewer);
    return { items, nextOffset: ids.length > PAGE_SIZE ? offset + PAGE_SIZE : null };
  }

  /** Builds catalog cards (listing + market label + seller trust + favorite flag). */
  async items(ids: string[], viewer: User | null): Promise<CatalogItem[]> {
    if (ids.length === 0) return [];
    const staff = viewer?.role === "admin" || viewer?.role === "operator";
    // Only public listings, unless the viewer owns them or is staff (compare/assistant take arbitrary ids).
    const dtos = (await this.listingsSvc.dtos(ids, viewer?.id ?? null, { withSeller: true })).filter(
      (l) => PUBLIC_STATUSES.includes(l.status) || l.seller?.id === viewer?.id || staff,
    );
    const favs = viewer
      ? new Set(
          (
            await this.db
              .select({ id: favorites.listingId })
              .from(favorites)
              .where(and(eq(favorites.userId, viewer.id), inArray(favorites.listingId, ids)))
          ).map((r) => r.id),
        )
      : new Set<string>();
    return Promise.all(dtos.map(async (l) => ({ listing: l, market: await this.market(l), trust: this.trust(l), favorite: favs.has(l.id) })));
  }

  /** Public card with market label/trust/favorite; counts a view (via ListingService.view). */
  async viewItem(id: string, viewer: User | null): Promise<CatalogItem> {
    const listing = await this.listingsSvc.view(id, viewer);
    const [fav] = viewer
      ? await this.db.select().from(favorites).where(and(eq(favorites.userId, viewer.id), eq(favorites.listingId, id)))
      : [];
    const market = await this.market(listing);
    return { listing, market, trust: this.trust(listing), favorite: !!fav, passport: await this.passport(listing, market) };
  }

  /**
   * «Паспорт товара» (docs/plan.md §2): the grade, checks that name who confirmed them, and the device's
   * history on Ishonch by IMEI — counts, dates and prices only, never who sold it before.
   */
  async passport(l: ListingDto, market: PriceVerdict | null): Promise<ItemPassport> {
    const { grade, reasons } = computeGrade(l.condition, l.checklist ?? {});
    const c = l.checklist ?? {};
    const fields = checklistFields(l.category);
    // The courier's photos from the passed inspection that gave the badge (the latest one).
    let inspectionPhotos: string[] = [];
    if (l.verified?.passed && this.listingsSvc.evidence) {
      const [last] = await this.db
        .select({ id: orders.id })
        .from(orders)
        .where(and(eq(orders.listingId, l.id), sql`(${orders.inspection}->>'passed')::boolean`))
        .orderBy(desc(orders.updatedAt))
        .limit(1);
      if (last) inspectionPhotos = (await this.listingsSvc.evidence.orderPhotos([last.id], "inspection_photo")).get(last.id) ?? [];
    }
    const checks: PassportCheck[] = [
      {
        code: "inspection",
        source: "courier",
        status: l.verified?.passed ? "ok" : "unknown",
        ...(inspectionPhotos.length ? { params: { photos: inspectionPhotos.length } } : {}),
      },
      { code: "video", source: "seller", status: l.video ? "ok" : "unknown" },
    ];
    let history: ItemHistory | null = null;

    if ((IMEI_CATEGORIES as readonly string[]).includes(l.category)) {
      const [row] = await this.db
        .select({ imei: listings.imei, seller: listings.sellerUserId, registry: listings.imeiRegistry })
        .from(listings)
        .where(eq(listings.id, l.id));
      if (!row?.imei) checks.push({ code: "imei", source: "ishonch", status: "unknown" });
      else {
        const others = await this.db
          .select({ id: listings.id, seller: listings.sellerUserId, status: listings.status, price: listings.price, publishedAt: listings.publishedAt })
          .from(listings)
          .where(and(eq(listings.imei, row.imei), ne(listings.id, l.id)));
        const clash = others.some((o) => o.seller !== row.seller && ["active", "pending", "reserved"].includes(o.status));
        checks.push({ code: "imei", source: "ishonch", status: clash ? "fail" : "ok" });
        // Only when a registry answered for this very IMEI: without access there is nothing to show.
        if (row.registry?.imei === row.imei) {
          checks.push({ code: "imei_registry", source: "registry", status: row.registry.status === "clean" ? "ok" : "fail" });
        }
        const past = others.filter((o) => o.publishedAt).sort((a, b) => b.publishedAt!.getTime() - a.publishedAt!.getTime());
        if (past.length) {
          const [insp] = (await this.db
            .select({
              passed: sql<number>`count(*) filter (where (${orders.inspection}->>'passed')::boolean)::int`,
              failed: sql<number>`count(*) filter (where not (${orders.inspection}->>'passed')::boolean)::int`,
            })
            .from(orders)
            .where(and(inArray(orders.listingId, past.map((o) => o.id)), sql`${orders.inspection} is not null`))) as [{ passed: number; failed: number }];
          history = {
            listings: past.length,
            sold: past.filter((o) => o.status === "sold").length,
            prices: past
              .filter((o) => o.price)
              .slice(0, 5)
              .map((o) => ({ at: o.publishedAt!.toISOString(), price: o.price! })),
            inspections: { passed: insp?.passed ?? 0, failed: insp?.failed ?? 0 },
          };
        }
      }
    }
    if ((ACCOUNT_CATEGORIES as readonly string[]).includes(l.category)) {
      checks.push({ code: "account", source: "seller", status: c.accountUnlocked === true ? "ok" : c.accountUnlocked === false ? "fail" : "unknown" });
    }
    if (fields.includes("batteryPct")) {
      checks.push(
        c.batteryPct == null
          ? { code: "battery", source: "seller", status: "unknown" }
          : { code: "battery", source: "seller", status: c.batteryPct >= 80 ? "ok" : "warn", params: { pct: c.batteryPct } },
      );
    }
    if (fields.includes("repairs")) {
      const repairs = c.repairs ?? [];
      checks.push({ code: "repairs", source: "seller", status: !repairs.length ? "unknown" : repairs.every((r) => r === "none") ? "ok" : "warn" });
    }
    checks.push({ code: "photos", source: "ishonch", status: l.photos.length >= 3 ? "ok" : "warn", params: { n: l.photos.length } });
    // A price far below the market is the classic bait: it is a warning, not a bargain.
    const price: PassportCheck["status"] = !market || market.verdict === "unknown"
      ? "unknown"
      : market.verdict === "above" || (market.verdict === "below" && (market.diffPct ?? 0) <= -30)
        ? "warn"
        : "ok";
    checks.push({ code: "price", source: "ishonch", status: price, params: market?.diffPct != null ? { pct: market.diffPct } : undefined });
    if (fields.includes("kit")) {
      const docs = (c.kit ?? []).filter((k) => k === "box" || k === "receipt" || k === "warranty");
      checks.push({ code: "documents", source: "seller", status: docs.length ? "ok" : "unknown" });
    }
    return { grade, reasons, checks, passed: checks.filter((x) => x.status === "ok").length, total: checks.length, history, inspectionPhotos };
  }

  trust(l: ListingDto) {
    const s = l.seller;
    if (!s) return "low" as const;
    return sellerTrust({
      verifiedShop: !!s.shop?.verified,
      platformSales: s.platformSales,
      accountAgeDays: (Date.now() - new Date(s.registeredAt).getTime()) / DAY,
      rating: s.rating,
      inspections: s.inspections,
      disputesLost: s.disputesLost,
    });
  }

  // ---------- market price ----------
  async market(l: Pick<ListingDto, "price" | "attributes">): Promise<PriceVerdict | null> {
    const key = l.attributes.modelKey;
    if (!key || !l.price) return null;
    const m = await this.marketRange(key);
    if (!m.range) return null;
    return priceVerdict(l.price, m.range, m.source);
  }

  private async marketRange(modelKey: string): Promise<MarketCacheEntry> {
    const hit = this.marketCache.get(modelKey);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit;
    let range = await this.repo.findReferencePrice(modelKey);
    let source: PriceSource = "reference";
    if (!range) {
      range = await this.findCatalogPrice(modelKey);
      source = "catalog";
    }
    const entry = { range, source: range ? source : ("none" as const), at: Date.now() };
    // Bounded: keys come from AI-generated model names, so the map must not grow forever.
    if (this.marketCache.size >= 5000) this.marketCache.delete(this.marketCache.keys().next().value!);
    this.marketCache.set(modelKey, entry);
    return entry;
  }

  /** Median of similar listings in our catalog (active + sold, last 90 days); needs ≥3 samples. */
  async findCatalogPrice(modelKey: string): Promise<MarketRange | null> {
    const rows = await this.db
      .select({ price: listings.price, key: sql<string>`${listings.attributes}->>'modelKey'` })
      .from(listings)
      .where(
        sql`${listings.status} in ('active', 'sold') and ${listings.price} > 0
            and ${listings.publishedAt} > now() - interval '90 days'
            and coalesce(${listings.attributes}->>'modelKey', '') % ${modelKey}`,
      )
      .limit(200);
    const prices = rows
      .filter((r) => r.key && sameModel(r.key, modelKey))
      .map((r) => r.price!)
      .sort((a, b) => a - b);
    if (prices.length < 3) return null;
    return { min: quantile(prices, 0.2), median: quantile(prices, 0.5), max: quantile(prices, 0.8) };
  }

  // ---------- valuation («Сколько стоит?») ----------
  /**
   * Market price for a model in a condition: the price reference (or our catalog median) scaled by the
   * condition, what sold on Ishonch lately and the monthly asking-price history. No AI: instant and free.
   */
  async valuation(query: string, condition: Condition): Promise<Valuation> {
    const ref = await this.repo.findReferenceRow(query);
    const modelKey = ref?.modelKey ?? normalizeModelKey(query);
    const base = ref ?? (await this.findCatalogPrice(modelKey));
    const source: Valuation["source"] = ref ? "reference" : base ? "catalog" : "none";
    const f = CONDITION_FACTOR[condition];
    const scale = (n: number) => Math.round((n * f) / 10_000) * 10_000;
    const range = base ? { min: scale(base.min), median: scale(base.median), max: scale(base.max) } : null;

    const since = new Date(Date.now() - VALUATION_HISTORY_MONTHS * 31 * DAY);
    const rows = await this.db
      .select({
        price: listings.price,
        status: listings.status,
        soldAt: listings.soldAt,
        publishedAt: listings.publishedAt,
        key: sql<string>`${listings.attributes}->>'modelKey'`,
      })
      .from(listings)
      .where(
        sql`${listings.status} in ('active', 'reserved', 'sold', 'archived') and ${listings.price} > 0
            and ${listings.publishedAt} > ${since.toISOString()}
            and coalesce(${listings.attributes}->>'modelKey', '') % ${modelKey}`,
      )
      .limit(1000);
    const same = rows.filter((r) => r.key && sameModel(r.key, modelKey));
    const soldRecent = same
      .filter((r) => r.status === "sold" && r.soldAt && r.soldAt.getTime() > Date.now() - 90 * DAY)
      .map((r) => r.price!)
      .sort((a, b) => a - b);
    const byMonth = new Map<string, number[]>();
    for (const r of same) {
      const month = (r.soldAt ?? r.publishedAt)!.toISOString().slice(0, 7);
      byMonth.set(month, [...(byMonth.get(month) ?? []), r.price!]);
    }
    return {
      modelKey,
      condition,
      range,
      source,
      estimate: suggestPrice(range, source),
      sold: { count: soldRecent.length, median: soldRecent.length ? quantile(soldRecent, 0.5) : null },
      live: same.filter((r) => r.status === "active").length,
      history: [...byMonth.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, prices]) => ({ month, median: quantile(prices.sort((a, b) => a - b), 0.5), n: prices.length })),
    };
  }

  valuationModels(query: string) {
    return this.repo.suggestModels(query);
  }

  // ---------- discovery ----------
  /**
   * "Похожие объявления": live listings of the same category, the same model first (trigram match on the
   * model key), then the closest price within −50…+60 %.
   */
  async similar(id: string, viewer: User | null): Promise<CatalogItem[]> {
    const [l] = await this.db.select().from(listings).where(eq(listings.id, id));
    if (!l) throw new CatalogRejected("not_found", 404);
    const key = ((l.attributes as { modelKey?: string | null }).modelKey ?? "").trim();
    const conds: SQL[] = [...this.conditions({}), sql`${listings.id} <> ${id}`, eq(listings.category, l.category)];
    if (l.price) conds.push(sql`${listings.price} between ${Math.round(l.price * 0.5)} and ${Math.round(l.price * 1.6)}`);
    const sameModel = key ? sql`case when coalesce(${listings.attributes}->>'modelKey', '') % ${key} then 0 else 1 end` : sql`0`;
    const rows = await this.db
      .select({ id: listings.id })
      .from(listings)
      .where(and(...conds))
      .orderBy(sameModel, l.price ? sql`abs(${listings.price} - ${l.price})` : desc(listings.bumpedAt))
      .limit(6);
    return this.items(
      rows.map((r) => r.id),
      viewer,
    );
  }

  /** Cards by id, in the given order (the Mini App's "recently viewed" list); non-public ones are skipped. */
  async batch(ids: string[], viewer: User | null): Promise<CatalogItem[]> {
    const unique = [...new Set(ids)].filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 20);
    const items = await this.items(unique, viewer);
    const byId = new Map(items.map((i) => [i.listing.id, i]));
    return unique.map((x) => byId.get(x)).filter((i): i is CatalogItem => !!i && i.listing.status === "active");
  }

  /** Public seller page: the seller's facts (trust, rating, reply time…) and their live listings. */
  async sellerPage(sellerId: string, viewer: User | null) {
    const seller = await this.listingsSvc.sellerProfile(sellerId);
    if (!seller) throw new CatalogRejected("not_found", 404);
    const ids = await this.searchIds({}, "newest", 0, SELLER_PAGE_LIMIT, [eq(listings.sellerUserId, sellerId)]);
    const items = await this.items(ids, viewer);
    const trust = sellerTrust({
      verifiedShop: !!seller.shop?.verified,
      platformSales: seller.platformSales,
      accountAgeDays: (Date.now() - new Date(seller.registeredAt).getTime()) / DAY,
      rating: seller.rating,
      inspections: seller.inspections,
    });
    const following = viewer ? await this.listingsSvc.isFollowing(viewer.id, sellerId) : false;
    return { seller, trust, items, following };
  }

  /**
   * "Почему не продаётся": numbers for the seller's own listing and concrete tips, most important first.
   * Deterministic rules (no AI): cheap, instant and explainable.
   */
  async insights(user: User, id: string): Promise<ListingInsights> {
    const [l] = await this.db.select().from(listings).where(eq(listings.id, id));
    if (!l || l.sellerUserId !== user.id) throw new CatalogRejected("not_found", 404);
    const dto = (await this.listingsSvc.dtos([id], user.id))[0]!;
    const days = l.publishedAt ? Math.max(1, Math.floor((Date.now() - l.publishedAt.getTime()) / DAY)) : 0;
    const viewsPerDay = days ? Math.round((l.views / days) * 10) / 10 : 0;
    const [cat] = (await this.db.execute(sql`
      select avg(views / greatest(1, extract(epoch from now() - published_at) / 86400))::float as avg, count(*)::int as n
      from ${listings}
      where status = 'active' and category = ${l.category} and id <> ${id} and published_at is not null`)) as unknown as Array<{
      avg: number | null;
      n: number;
    }>;
    const categoryViewsPerDay = cat && cat.n >= 3 && cat.avg != null ? Math.round(cat.avg * 10) / 10 : null;
    const verdict = await this.market(dto);
    const market =
      verdict?.range && l.price ? { median: verdict.range.median, diffPct: Math.round(((l.price - verdict.range.median) / verdict.range.median) * 100) } : null;

    const tips: ListingInsights["tips"] = [];
    const phone = (IMEI_CATEGORIES as readonly string[]).includes(l.category);
    const checklist = (l.checklist ?? {}) as ConditionChecklist;
    if (market && market.diffPct >= 10) tips.push({ code: "price_above_market", severity: "high", params: { pct: market.diffPct, median: formatUzs(market.median) } });
    if (l.favoritesCount >= 3 && l.requestsCount === 0) tips.push({ code: "favorites_no_requests", severity: "high", params: { n: l.favoritesCount } });
    if (days >= 3 && categoryViewsPerDay && viewsPerDay < categoryViewsPerDay * 0.5) {
      tips.push({ code: "low_views", severity: "medium", params: { mine: viewsPerDay, avg: categoryViewsPerDay } });
    }
    if (days >= 14 && l.requestsCount === 0) tips.push({ code: "stale", severity: "medium", params: { days } });
    if (dto.photos.length < 3) tips.push({ code: "few_photos", severity: "medium", params: { n: dto.photos.length } });
    if ((l.descriptionRu || l.descriptionUz).trim().length < 120) tips.push({ code: "short_description", severity: "low", params: {} });
    if (checklistFields(l.category).length && checklistEmpty(l.category, checklist)) tips.push({ code: "no_checklist", severity: "medium", params: {} });
    if ((ACCOUNT_CATEGORIES as readonly string[]).includes(l.category) && checklist.accountUnlocked !== true) {
      tips.push({ code: "no_account_check", severity: "medium", params: {} });
    }
    if (phone && !l.imei) tips.push({ code: "no_imei", severity: "low", params: {} });
    if (!(l.allowedDeliveryModes as string[]).includes("cod_seller")) tips.push({ code: "no_cod", severity: "low", params: {} });
    return {
      stats: { daysOnSale: days, views: l.views, viewsPerDay, categoryViewsPerDay, favorites: l.favoritesCount, requests: l.requestsCount },
      market,
      tips,
    };
  }

  logSearch(userId: string, f: CatalogFilters, results: number) {
    return this.repo.event(userId, "catalog_search", { q: f.q?.slice(0, 100) ?? null, category: f.category ?? null, results });
  }

  // ---------- favorites ----------
  async setFavorite(user: User, listingId: string, on: boolean) {
    const [l] = await this.db.select({ id: listings.id, status: listings.status }).from(listings).where(eq(listings.id, listingId));
    if (!l || (on && !PUBLIC_STATUSES.includes(l.status))) throw new CatalogRejected("not_found", 404);
    if (on) {
      const inserted = await this.db.insert(favorites).values({ userId: user.id, listingId }).onConflictDoNothing().returning();
      if (inserted.length) {
        await this.db.update(listings).set({ favoritesCount: sql`${listings.favoritesCount} + 1` }).where(eq(listings.id, listingId));
      }
    } else {
      const deleted = await this.db
        .delete(favorites)
        .where(and(eq(favorites.userId, user.id), eq(favorites.listingId, listingId)))
        .returning();
      if (deleted.length) {
        await this.db
          .update(listings)
          .set({ favoritesCount: sql`greatest(${listings.favoritesCount} - 1, 0)` })
          .where(eq(listings.id, listingId));
      }
    }
    return { favorite: on };
  }

  async favorites(user: User) {
    const rows = await this.db
      .select({ id: favorites.listingId })
      .from(favorites)
      .innerJoin(listings, eq(listings.id, favorites.listingId))
      .where(and(eq(favorites.userId, user.id), inArray(listings.status, ["active", "reserved", "sold"])))
      .orderBy(desc(favorites.createdAt))
      .limit(200);
    return this.items(
      rows.map((r) => r.id),
      user,
    );
  }

  // ---------- saved searches ----------
  async saveSearch(user: User, filters: CatalogFilters) {
    const [{ n }] = (await this.db.select({ n: count() }).from(savedSearches).where(eq(savedSearches.userId, user.id))) as [
      { n: number },
    ];
    if (n >= MAX_SAVED_SEARCHES) throw new CatalogRejected("too_many_searches", 409);
    const lang = user.language as Lang;
    const parts = [
      filters.q,
      filters.category ? t(lang, `category.${filters.category}`) : null,
      filters.priceMax ? `≤ ${formatUzs(filters.priceMax)}` : null,
      filters.verifiedOnly ? "✔️" : null,
      filters.goodGrade ? "A–B" : null,
    ].filter(Boolean);
    const [row] = await this.db
      .insert(savedSearches)
      .values({ userId: user.id, filters, title: parts.join(" · ") || t(lang, "catalog.title") })
      .returning();
    return row!;
  }

  listSearches(user: User) {
    return this.db.select().from(savedSearches).where(eq(savedSearches.userId, user.id)).orderBy(desc(savedSearches.createdAt));
  }

  async deleteSearch(user: User, id: number) {
    await this.db.delete(savedSearches).where(and(eq(savedSearches.id, id), eq(savedSearches.userId, user.id)));
  }

  /** Called after a listing is published: alerts subscribers (≤3 alerts per user per day). */
  async notifySavedSearches(listingId: string): Promise<number> {
    if (!this.notifier) return 0;
    const [l] = await this.db.select().from(listings).where(eq(listings.id, listingId));
    if (!l || l.status !== "active") return 0;
    const searches = await this.db
      .select({ s: savedSearches, telegramId: users.telegramId, language: users.language })
      .from(savedSearches)
      .innerJoin(users, eq(users.id, savedSearches.userId))
      // Cheap pre-filter in SQL on the structured filters; only the survivors run the full search below.
      .where(
        sql`${savedSearches.userId} <> ${l.sellerUserId} and ${users.bannedAt} is null and not ('saved_search' = any(${users.notifyOff}))
          and (${savedSearches.filters}->>'category' is null or ${savedSearches.filters}->>'category' = ${l.category})
          and (${savedSearches.filters}->>'district' is null or ${savedSearches.filters}->>'district' = ${l.district ?? ""})
          and (${savedSearches.filters}->>'priceMax' is null or (${savedSearches.filters}->>'priceMax')::bigint >= ${l.price ?? 0})
          and (${savedSearches.filters}->>'priceMin' is null or (${savedSearches.filters}->>'priceMin')::bigint <= ${l.price ?? 0})`,
      );

    let sent = 0;
    const notifiedUsers = new Set<string>();
    for (const { s, telegramId, language } of searches) {
      if (notifiedUsers.has(s.userId)) continue; // one alert per user per listing
      const ids = await this.searchIds(s.filters as CatalogFilters, "newest", 0, 1, [eq(listings.id, listingId)]);
      if (ids.length === 0) continue;
      const [{ today }] = (await this.db
        .select({ today: count() })
        .from(searchNotifications)
        .where(and(eq(searchNotifications.userId, s.userId), gte(searchNotifications.createdAt, startOfTashkentDay())))) as [
        { today: number },
      ];
      if (today >= MAX_SEARCH_ALERTS_PER_DAY) continue;
      const inserted = await this.db
        .insert(searchNotifications)
        .values({ savedSearchId: s.id, userId: s.userId, listingId })
        .onConflictDoNothing()
        .returning();
      if (!inserted.length) continue;

      const lang = language as Lang;
      const title = lang === "ru" ? l.titleRu || l.titleUz : l.titleUz || l.titleRu;
      const url = await this.notifier.miniAppLink(`listing_${listingId}`).catch(() => null);
      try {
        await this.notifier.send(
          telegramId,
          t(lang, "bot.saved_search_hit", { query: s.title, title, price: l.price ? formatUzs(l.price) : "" }),
          [...(url ? [[{ text: t(lang, "bot.open_listing"), url }]] : []), unsubscribeRow(lang, "saved_search")],
        );
        sent++;
        notifiedUsers.add(s.userId);
      } catch (err) {
        // The row claimed this alert; give it back so a retry of the job can deliver it.
        await this.db.delete(searchNotifications).where(eq(searchNotifications.id, inserted[0]!.id)).catch(() => undefined);
        console.error("saved search alert failed", err);
      }
    }
    return sent;
  }

  // ---------- masked buyer ↔ seller chat ----------
  async contactSeller(buyer: User, listingId: string, text: string) {
    const body = text.trim().slice(0, 1000);
    if (!body) throw new CatalogRejected("bad_request", 400);
    const [l] = await this.db.select().from(listings).where(eq(listings.id, listingId));
    if (!l || l.status !== "active") throw new CatalogRejected("not_found", 404);
    if (l.sellerUserId === buyer.id) throw new CatalogRejected("own_listing", 409);
    if (await blockedBetween(this.db, buyer.id, l.sellerUserId)) throw new CatalogRejected("blocked", 403);

    let [conv] = await this.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.buyerUserId, buyer.id), eq(conversations.listingId, listingId)));
    if (!conv) {
      const [{ n }] = (await this.db
        .select({ n: count() })
        .from(conversations)
        .where(and(eq(conversations.buyerUserId, buyer.id), gte(conversations.createdAt, startOfTashkentDay())))) as [
        { n: number },
      ];
      if (n >= MAX_NEW_CONVERSATIONS_PER_DAY) throw new CatalogRejected("contact_limit", 429);
      [conv] = await this.db
        .insert(conversations)
        .values({ listingId, buyerUserId: buyer.id, sellerUserId: l.sellerUserId })
        .returning();
    }
    await this.relay(conv!.id, buyer, body);
    return { ok: true, conversationId: conv!.id };
  }

  // ---------- bot state: "the next text of this user is a reply" ----------
  /** The bot's "Reply" button: remembered in the DB (shared by bot instances, survives restarts). */
  async setPendingReply(user: User, conversationId: string, windowMs = 15 * 60_000) {
    const [conv] = await this.db.select().from(conversations).where(eq(conversations.id, conversationId));
    if (!conv || (conv.buyerUserId !== user.id && conv.sellerUserId !== user.id)) throw new CatalogRejected("not_found", 404);
    const expiresAt = new Date(Date.now() + windowMs);
    await this.db
      .insert(botPendingReplies)
      .values({ telegramUserId: user.telegramId, conversationId, expiresAt })
      .onConflictDoUpdate({ target: botPendingReplies.telegramUserId, set: { conversationId, expiresAt } });
    return { ok: true, expiresAt: expiresAt.toISOString() };
  }

  /** Takes (and clears) the pending reply: the conversation, "expired", or nothing pending. */
  async takePendingReply(user: User): Promise<{ conversationId?: string; expired?: boolean }> {
    const [row] = await this.db.delete(botPendingReplies).where(eq(botPendingReplies.telegramUserId, user.telegramId)).returning();
    if (!row) return {};
    return row.expiresAt > new Date() ? { conversationId: row.conversationId } : { expired: true };
  }

  async cleanupPendingReplies() {
    await this.db.delete(botPendingReplies).where(lt(botPendingReplies.expiresAt, new Date(Date.now() - 24 * 3600_000)));
  }

  /** Stores a message and forwards it to the other side with a "Reply" button. Names are never revealed. */
  async relay(conversationId: string, sender: User, text: string) {
    const [conv] = await this.db.select().from(conversations).where(eq(conversations.id, conversationId));
    if (!conv || (conv.buyerUserId !== sender.id && conv.sellerUserId !== sender.id)) {
      throw new CatalogRejected("not_found", 404);
    }
    const fromBuyer = sender.id === conv.buyerUserId;
    const recipientId = fromBuyer ? conv.sellerUserId : conv.buyerUserId;
    const [recipient] = await this.db.select().from(users).where(eq(users.id, recipientId));
    const [l] = await this.db.select().from(listings).where(eq(listings.id, conv.listingId));
    // Banned users neither receive nor send through the masked chat (old conversations included).
    if (!recipient || !l || recipient.bannedAt) throw new CatalogRejected("not_found", 404);
    if (await blockedBetween(this.db, sender.id, recipientId)) throw new CatalogRejected("blocked", 403);

    const [{ n, mineLastHour }] = (await this.db
      .select({
        n: count(),
        mineLastHour: sql<number>`count(*) filter (where ${conversationMessages.senderUserId} = ${sender.id}
          and ${conversationMessages.createdAt} > now() - interval '1 hour')::int`,
      })
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, conversationId))) as [{ n: number; mineLastHour: number }];
    if (mineLastHour >= MAX_MESSAGES_PER_HOUR) throw new CatalogRejected("message_limit", 429);
    // What is stored is what is sent: a message over Telegram's limit must not be saved and then fail.
    text = text.slice(0, 1000);
    await this.db.insert(conversationMessages).values({ conversationId, senderUserId: sender.id, text });
    await this.db.update(conversations).set({ lastMessageAt: new Date() }).where(eq(conversations.id, conversationId));
    if (fromBuyer && n === 0) await this.repo.event(sender.id, "buyer_contacted_seller", { listingId: l.id });
    if (!fromBuyer) this.listingsSvc.forgetResponseTime(sender.id);

    if (!this.notifier) return;
    const lang = recipient.language as Lang;
    const title = listingTitle(l, lang);
    const key = fromBuyer ? (n === 0 ? "bot.msg_from_buyer" : "bot.msg_from_buyer_again") : "bot.msg_from_seller";
    const buttons: NotifyButton[][] = [[{ text: t(lang, "bot.reply"), callbackData: `reply:${conversationId}` }]];
    // The seller can let the AI draft the answer (three options, sent with one tap).
    if (fromBuyer) buttons[0]!.push({ text: t(lang, "suggest.button"), callbackData: `sugg:${conversationId}` });
    if (!fromBuyer) buttons.push([{ text: t(lang, "bot.open_listing"), url: await this.notifier.miniAppLink(`listing_${l.id}`) }]);
    // Stage 19: one tap to report or block the other side (names stay hidden).
    buttons.push([
      { text: t(lang, "chat.report"), callbackData: `rep:${conversationId}` },
      { text: t(lang, "chat.block"), callbackData: `blk:${conversationId}` },
    ]);
    try {
      await this.notifier.send(recipient.telegramId, t(lang, key, { title, text }), buttons);
    } catch {
      throw new CatalogRejected("seller_unreachable", 502);
    }
  }
}

