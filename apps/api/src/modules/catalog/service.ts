import { and, asc, count, desc, eq, gte, inArray, sql, type SQL } from "drizzle-orm";
import {
  canonicalQuery,
  canonicalWord,
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
  type Lang,
  type ListingDto,
  type MarketRange,
  type PriceSource,
  type PriceVerdict,
} from "@ishonch/shared";
import type { Repo } from "../../db/repo.js";
import { startOfTashkentDay } from "../../db/repo.js";
import {
  conversationMessages,
  conversations,
  favorites,
  listings,
  savedSearches,
  searchNotifications,
  shops,
  users,
  type User,
} from "../../db/schema.js";
import type { ChannelPublisher, Notifier, NotifyButton } from "../../telegram/publisher.js";
import type { ListingService } from "../listings/service.js";

export const PAGE_SIZE = 20;
/** Statuses anyone may see. */
export const PUBLIC_STATUSES = ["active", "reserved", "sold"];
export const MAX_NEW_CONVERSATIONS_PER_DAY = 20;
export const MAX_SEARCH_ALERTS_PER_DAY = 3;
export const MAX_SAVED_SEARCHES = 20;
const DAY = 24 * 3600_000;

export class CatalogRejected extends Error {
  constructor(
    public code: "not_found" | "own_listing" | "contact_limit" | "seller_unreachable" | "bad_request" | "too_many_searches",
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
        or (word_similarity(${canon}, ${title}) >= 0.4 and ${numbersMatch}))`);
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
    return { listing, market: await this.market(listing), trust: this.trust(listing), favorite: !!fav };
  }

  trust(l: ListingDto) {
    const s = l.seller;
    if (!s) return "low" as const;
    return sellerTrust({
      verifiedShop: !!s.shop?.verified,
      platformSales: s.platformSales,
      accountAgeDays: (Date.now() - new Date(s.registeredAt).getTime()) / DAY,
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
            and similarity(coalesce(${listings.attributes}->>'modelKey', ''), ${modelKey}) >= 0.4`,
      )
      .limit(200);
    const prices = rows
      .filter((r) => r.key && sameModel(r.key, modelKey))
      .map((r) => r.price!)
      .sort((a, b) => a - b);
    if (prices.length < 3) return null;
    return { min: quantile(prices, 0.2), median: quantile(prices, 0.5), max: quantile(prices, 0.8) };
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
        sql`${savedSearches.userId} <> ${l.sellerUserId} and ${users.bannedAt} is null
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
      const url = await this.notifier.miniAppLink(`listing_${listingId}`);
      try {
        await this.notifier.send(
          telegramId,
          t(lang, "bot.saved_search_hit", { query: s.title, title, price: l.price ? formatUzs(l.price) : "" }),
          [[{ text: t(lang, "bot.open_listing"), url }]],
        );
        sent++;
        notifiedUsers.add(s.userId);
      } catch (err) {
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

    const [{ n }] = (await this.db
      .select({ n: count() })
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, conversationId))) as [{ n: number }];
    await this.db.insert(conversationMessages).values({ conversationId, senderUserId: sender.id, text: text.slice(0, 1000) });
    await this.db.update(conversations).set({ lastMessageAt: new Date() }).where(eq(conversations.id, conversationId));
    if (fromBuyer && n === 0) await this.repo.event(sender.id, "buyer_contacted_seller", { listingId: l.id });

    if (!this.notifier) return;
    const lang = recipient.language as Lang;
    const title = listingTitle(l, lang);
    const key = fromBuyer ? (n === 0 ? "bot.msg_from_buyer" : "bot.msg_from_buyer_again") : "bot.msg_from_seller";
    const buttons: NotifyButton[][] = [[{ text: t(lang, "bot.reply"), callbackData: `reply:${conversationId}` }]];
    if (!fromBuyer) buttons.push([{ text: t(lang, "bot.open_listing"), url: await this.notifier.miniAppLink(`listing_${l.id}`) }]);
    try {
      await this.notifier.send(recipient.telegramId, t(lang, key, { title, text }), buttons);
    } catch {
      throw new CatalogRejected("seller_unreachable", 502);
    }
  }
}

