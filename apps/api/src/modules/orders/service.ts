import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, gt, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import {
  MAX_OPEN_ORDERS_PER_BUYER,
  MVP_DELIVERY_MODES,
  OFFER_ACCEPTED_HOURS,
  OFFER_PENDING_HOURS,
  OFFERS_PER_DAY,
  OPEN_ORDER_STATUSES,
  REVIEW_REMINDER_HOURS,
  REVIEW_REMINDER_MAX_DAYS,
  RESERVING_ORDER_STATUSES,
  canTransition,
  formatUzs,
  listingTitle,
  minOffer,
  operatorNextStatuses,
  isCargo,
  normalizeQuote,
  pickTariff,
  quoteDelivery,
  scrubPii,
  t,
  CONDITION_FACTOR,
  GUARANTEE_DAYS,
  LIKERS_OFFER_EVERY_DAYS,
  SHOPS_OFFER_EVERY_DAYS,
  SHOPS_OFFER_MAX,
  LIKERS_OFFER_HOURS,
  maxLikersOffer,
  applyDiscount,
  bundleDiscountPct,
  type BundleDiscount,
  TRADE_MAX_TOPUP_PCT,
  normalizeModelKey,
  type BundleQuote,
  type Condition,
  type CourierTariff,
  type DisputeDto,
  type DisputeReason,
  type DisputeResolution,
  type OfferKind,
  type TradeItem,
  type CreateOrderInput,
  type DeliveryMode,
  type DeliveryQuote,
  type District,
  inspectionChecks,
  type Inspection,
  type LiftInfo,
  type Vehicle,
  type InspectionCheck,
  type FeePayer,
  type Lang,
  type OfferDto,
  type OfferStatus,
  type OrderActor,
  type OrderDto,
  type OrderStatus,
} from "@ishonch/shared";
import type { Repo } from "../../db/repo.js";
import {
  courierTariffs,
  disputes,
  favorites,
  listingPhotos,
  listings,
  offers,
  orderEvents,
  orders,
  reviews,
  shops,
  users,
  type Listing,
  type Order,
  type User,
} from "../../db/schema.js";

const DAY_MS = 86_400_000;
import type { ChannelPublisher, Notifier, NotifyButton } from "../../telegram/publisher.js";
import type { StaffNotifier } from "../../telegram/staff.js";
import { unsubscribeRow, type ListingService } from "../listings/service.js";
import type { CourierProvider } from "./courier.js";
import type { EvidenceService } from "../evidence/service.js";

export type OrderError =
  | "not_found"
  | "own_listing"
  | "not_available"
  | "mode_not_allowed"
  | "phone_required"
  | "open_orders_limit"
  | "already_ordered"
  | "bad_state"
  | "forbidden"
  | "review_exists"
  | "too_many_attempts"
  | "offer_too_low"
  | "offer_not_lower"
  | "offer_pending"
  | "too_many_offers"
  | "bundle_invalid"
  | "no_tariff"
  | "trade_not_accepted"
  | "trade_topup_too_big"
  | "guarantee_expired"
  | "dispute_exists"
  | "bad_amount"
  | "likers_too_soon"
  | "likers_not_lower"
  | "likers_too_high"
  | "no_likers"
  | "shops_too_soon"
  | "seller_away"
  | "no_shops";

export class OrderRejected extends Error {
  constructor(
    public code: OrderError,
    public status: number,
  ) {
    super(code);
  }
}

export interface OrderServiceDeps {
  repo: Repo;
  listings: ListingService;
  notifier: (Notifier & Pick<ChannelPublisher, "miniAppLink">) | null;
  staff: StaffNotifier;
  /** Evidence files: dispute photos and the courier's inspection photos. */
  evidence?: EvidenceService;
  courier: CourierProvider;
  codPlatformEnabled: boolean;
  /** A reserved listing is back on sale: re-check complaints that arrived meanwhile (TrustService). */
  onListingRestored?: (listingId: string) => Promise<unknown>;
  /** Background jobs; used to send optional messages after the quiet hours. */
  enqueue?: (kind: string, payload: Record<string, unknown>, runAt?: Date | null) => Promise<void>;
  quietUntil?: (now: Date) => Date | null;
}

/** Drizzle wraps driver errors; the PostgreSQL code may sit on the error or its cause. */
const isUniqueViolation = (err: unknown) => {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
};

/**
 * Delivery orders: buyer requests → seller confirms (listing reserved) → operator books a courier
 * and moves statuses → delivered (listing sold through Ishonch, buyer may review) or returned / cancelled.
 */
export class OrderService {
  constructor(private d: OrderServiceDeps) {}

  private get db() {
    return this.d.repo.db;
  }

  // ---------- tariffs ----------
  async tariffs(): Promise<CourierTariff[]> {
    const rows = await this.db.select().from(courierTariffs).orderBy(asc(courierTariffs.id));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      vehicle: r.vehicle as Vehicle,
      fromDistrict: (r.fromDistrict as District | null) ?? null,
      toDistrict: (r.toDistrict as District | null) ?? null,
      price: r.price,
      codFeePct: r.codFeePct,
      liftPerFloor: r.liftPerFloor,
      active: r.active,
    }));
  }

  /** Admin: replaces the whole tariff table (it is small and edited as a list). */
  async replaceTariffs(rows: Array<Omit<CourierTariff, "id">>) {
    await this.db.transaction(async (tx) => {
      await tx.delete(courierTariffs);
      if (rows.length) await tx.insert(courierTariffs).values(rows.map((r) => ({ ...r, updatedAt: new Date() })));
    });
    return this.tariffs();
  }

  private allowedModes(l: { allowedDeliveryModes: string[] }): DeliveryMode[] {
    return (l.allowedDeliveryModes as DeliveryMode[]).filter((m) => this.d.codPlatformEnabled || MVP_DELIVERY_MODES.includes(m));
  }

  /** «В отъезде»: deferred messages (quiet hours) are dropped if the seller left meanwhile. */
  private async sellerIsAway(userId: string) {
    const [u] = await this.db.select({ until: users.awayUntil }).from(users).where(eq(users.id, userId));
    return !!u?.until && u.until > new Date();
  }

  private async availableListing(listingId: string) {
    const [l] = await this.db.select().from(listings).where(eq(listings.id, listingId));
    if (!l) throw new OrderRejected("not_found", 404);
    if (l.status !== "active" || !l.price || (l.expiresAt && l.expiresAt <= new Date())) throw new OrderRejected("not_available", 409);
    if (await this.sellerIsAway(l.sellerUserId)) throw new OrderRejected("seller_away", 409);
    return l;
  }

  /**
   * `buyerId`: a price the seller accepted for this buyer replaces the asking price (never above it).
   * `extraIds`: more items of the same seller in this delivery — no second delivery fee, only the COD fee.
   * A big appliance anywhere in the delivery makes it a cargo trip (cargo tariff, movers' lift fee by `lift`).
   */
  async quote(
    listingId: string,
    district: District,
    mode: DeliveryMode,
    buyerId?: string,
    extraIds: string[] = [],
    lift: LiftInfo | null = null,
  ): Promise<DeliveryQuote & { modes: DeliveryMode[]; offerId: string | null; bundle: BundleQuote | null }> {
    const l = await this.availableListing(listingId);
    const modes = this.allowedModes(l);
    if (!modes.includes(mode)) throw new OrderRejected("mode_not_allowed", 400);
    const extras = [];
    for (const id of [...new Set(extraIds)].filter((id) => id !== l.id)) {
      const x = await this.availableListing(id).catch(() => {
        throw new OrderRejected("bundle_invalid", 409);
      });
      if (x.sellerUserId !== l.sellerUserId || !this.allowedModes(x).includes(mode)) throw new OrderRejected("bundle_invalid", 409);
      extras.push(x);
    }
    const vehicle: Vehicle = [l, ...extras].some((x) => isCargo(x.category)) ? "cargo" : "courier";
    const tariff = pickTariff(await this.tariffs(), (l.district as District | null) ?? null, district, vehicle);
    // No tariff for the route would mean a free courier trip: refuse (operators fix the tariff table).
    if (!tariff) throw new OrderRejected("no_tariff", 409);
    // The shop's set discount applies to items without an agreed price (an accepted offer is already a deal).
    const discountPct = extras.length ? bundleDiscountPct(await this.bundleDiscount(l.sellerUserId), 1 + extras.length) : 0;
    let discount = 0;
    const priceFor = async (x: Listing) => {
      const o = buyerId ? await this.acceptedOffer(x.id, buyerId) : null;
      if (o) return { offer: o, price: Math.min(o.amount, x.price!) };
      const price = applyDiscount(x.price!, discountPct);
      discount += x.price! - price;
      return { offer: null, price };
    };
    const { offer, price: itemPrice } = await priceFor(l);
    const main = quoteDelivery({ tariff, itemPrice, mode, feePayer: l.feePayer as FeePayer, lift });

    let bundle: BundleQuote | null = null;
    if (extras.length) {
      const items: BundleQuote["items"] = [];
      // One trip: the delivery and lift fees are in the main item, the extras pay only their COD fee.
      const xTariff = { ...tariff, price: 0, liftPerFloor: 0 };
      for (const x of extras) {
        const { price: xPrice } = await priceFor(x);
        items.push({ listingId: x.id, quote: quoteDelivery({ tariff: xTariff, itemPrice: xPrice, mode, feePayer: x.feePayer as FeePayer, lift }) });
      }
      bundle = {
        items,
        buyerTotal: main.buyerTotal + items.reduce((sum, i) => sum + i.quote.buyerTotal, 0),
        saved: main.deliveryFee * items.length,
        discountPct: discount ? discountPct : 0,
        discount,
      };
    }
    return { ...main, modes, offerId: offer?.id ?? null, bundle };
  }

  private async bundleDiscount(sellerId: string): Promise<BundleDiscount | null> {
    const [shop] = await this.db.select({ two: shops.bundle2Pct, three: shops.bundle3Pct }).from(shops).where(eq(shops.ownerUserId, sellerId));
    return shop && (shop.two || shop.three) ? shop : null;
  }

  /** Other live items of the same seller that can ride in the same delivery (checkout "add to this delivery"). */
  async bundleCandidates(buyer: User, listingId: string) {
    const l = await this.availableListing(listingId);
    if (l.sellerUserId === buyer.id) return [];
    const rows = await this.db
      .select({ id: listings.id, modes: listings.allowedDeliveryModes })
      .from(listings)
      .where(
        and(
          eq(listings.sellerUserId, l.sellerUserId),
          eq(listings.status, "active"),
          ne(listings.id, l.id),
          sql`${listings.price} is not null`,
          sql`(${listings.expiresAt} is null or ${listings.expiresAt} > now())`,
        ),
      )
      .orderBy(desc(listings.bumpedAt))
      .limit(10);
    return this.d.listings.dtos(rows.map((r) => r.id), buyer.id);
  }

  // ---------- price offers ----------
  private async acceptedOffer(listingId: string, buyerId: string) {
    const [o] = await this.db
      .select()
      .from(offers)
      .where(
        and(
          eq(offers.listingId, listingId),
          eq(offers.buyerUserId, buyerId),
          eq(offers.kind, "price"),
          eq(offers.status, "accepted"),
          gt(offers.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(offers.decidedAt))
      .limit(1);
    return o ?? null;
  }

  private offerDto(o: typeof offers.$inferSelect): OfferDto {
    // Lazily expired: the hourly job only tidies the table.
    const status = (["pending", "accepted"].includes(o.status) && o.expiresAt <= new Date() ? "expired" : o.status) as OfferStatus;
    return {
      id: o.id,
      listingId: o.listingId,
      kind: o.kind as OfferKind,
      amount: o.amount,
      trade: (o.trade as TradeItem | null) ?? null,
      listPrice: o.listPrice,
      status,
      createdAt: o.createdAt.toISOString(),
      decidedAt: o.decidedAt?.toISOString() ?? null,
      expiresAt: o.expiresAt.toISOString(),
    };
  }

  /** The buyer's latest offer on a listing (for the listing card), or null. */
  async myOffer(buyer: User, listingId: string): Promise<OfferDto | null> {
    const [o] = await this.db
      .select()
      .from(offers)
      .where(and(eq(offers.listingId, listingId), eq(offers.buyerUserId, buyer.id)))
      .orderBy(desc(offers.createdAt))
      .limit(1);
    return o ? this.offerDto(o) : null;
  }

  /** Buyer proposes a lower price; the seller answers with bot buttons (accept / decline). */
  async makeOffer(buyer: User, listingId: string, amount: number): Promise<OfferDto> {
    const l = await this.availableListing(listingId);
    if (l.sellerUserId === buyer.id) throw new OrderRejected("own_listing", 409);
    if (amount >= l.price!) throw new OrderRejected("offer_not_lower", 400);
    if (amount < minOffer(l.price!)) throw new OrderRejected("offer_too_low", 400);
    const now = new Date();
    // A pending offer past its deadline no longer blocks a new one.
    await this.db
      .update(offers)
      .set({ status: "expired" })
      .where(and(eq(offers.listingId, l.id), eq(offers.buyerUserId, buyer.id), eq(offers.status, "pending"), lt(offers.expiresAt, now)));
    const reservation = await this.d.repo.reserveDaily(buyer.id, "offer_made", OFFERS_PER_DAY);
    if (reservation == null) throw new OrderRejected("too_many_offers", 429);
    let offer: typeof offers.$inferSelect;
    try {
      [offer] = (await this.db
        .insert(offers)
        .values({
          listingId: l.id,
          buyerUserId: buyer.id,
          sellerUserId: l.sellerUserId,
          amount,
          listPrice: l.price!,
          expiresAt: new Date(now.getTime() + OFFER_PENDING_HOURS * 3600_000),
        })
        .returning()) as [typeof offers.$inferSelect];
    } catch (err) {
      await this.d.repo.refundDaily(reservation);
      if (isUniqueViolation(err)) throw new OrderRejected("offer_pending", 409);
      throw err;
    }
    const seller = await this.user(l.sellerUserId);
    if (seller) {
      const lang = seller.language as Lang;
      const url = this.d.notifier ? await this.d.notifier.miniAppLink(`listing_${l.id}`).catch(() => null) : null;
      // A verified shop says so — only to a seller who asked shops this week: on any other listing its owner
      // makes offers as a private person, and their shop is nobody's business.
      const askedShops = !!l.shopsOfferAt && now.getTime() - l.shopsOfferAt.getTime() < SHOPS_OFFER_EVERY_DAYS * DAY_MS;
      const [shop] = askedShops
        ? await this.db
            .select({ name: shops.name })
            .from(shops)
            .where(and(eq(shops.ownerUserId, buyer.id), eq(shops.verified, true)))
        : [];
      await this.dm(
        seller,
        t(lang, "offer.new_for_seller", {
          title: listingTitle(l, lang),
          amount: formatUzs(amount),
          price: formatUzs(l.price!),
          hours: OFFER_PENDING_HOURS,
        }) + (shop ? `\n${t(lang, "shops_offer.from_shop", { name: shop.name })}` : ""),
        [
          [
            { text: t(lang, "offer.accept"), callbackData: `offer:accept:${offer.id}` },
            { text: t(lang, "offer.decline"), callbackData: `offer:decline:${offer.id}` },
          ],
          ...(url ? [[{ text: t(lang, "favorites.open"), url }]] : []),
        ],
      );
    }
    return this.offerDto(offer);
  }

  /**
   * «Обмен с доплатой»: the buyer offers their item plus a top-up (or asks the seller to add one). Same
   * lifecycle as a price offer (one pending per buyer and listing, the seller answers with bot buttons);
   * once accepted the two arrange the meeting in the chat — an exchange is not a courier delivery.
   */
  async makeTradeOffer(buyer: User, listingId: string, input: { title: string; condition: Condition; description?: string; topUp: number }) {
    const l = await this.availableListing(listingId);
    if (l.sellerUserId === buyer.id) throw new OrderRejected("own_listing", 409);
    if (!l.acceptsTrade) throw new OrderRejected("trade_not_accepted", 409);
    if (Math.abs(input.topUp) > (l.price! * TRADE_MAX_TOPUP_PCT) / 100) throw new OrderRejected("trade_topup_too_big", 400);
    // Our valuation of the buyer's item helps the seller decide (reference price scaled by condition).
    const key = normalizeModelKey(input.title);
    const range = await this.d.repo.findReferencePrice(key);
    const item: TradeItem = {
      title: scrubPii(input.title),
      condition: input.condition,
      description: input.description ? scrubPii(input.description) : null,
      modelKey: range ? key : null,
      estimate: range ? Math.round((range.median * CONDITION_FACTOR[input.condition]) / 10_000) * 10_000 : null,
    };
    const now = new Date();
    await this.db
      .update(offers)
      .set({ status: "expired" })
      .where(and(eq(offers.listingId, l.id), eq(offers.buyerUserId, buyer.id), eq(offers.status, "pending"), lt(offers.expiresAt, now)));
    const reservation = await this.d.repo.reserveDaily(buyer.id, "offer_made", OFFERS_PER_DAY);
    if (reservation == null) throw new OrderRejected("too_many_offers", 429);
    let offer: typeof offers.$inferSelect;
    try {
      [offer] = (await this.db
        .insert(offers)
        .values({
          listingId: l.id,
          buyerUserId: buyer.id,
          sellerUserId: l.sellerUserId,
          kind: "trade",
          amount: input.topUp,
          trade: item,
          listPrice: l.price!,
          expiresAt: new Date(now.getTime() + OFFER_PENDING_HOURS * 3600_000),
        })
        .returning()) as [typeof offers.$inferSelect];
    } catch (err) {
      await this.d.repo.refundDaily(reservation);
      if (isUniqueViolation(err)) throw new OrderRejected("offer_pending", 409);
      throw err;
    }
    await this.d.repo.event(buyer.id, "trade_offer_made", { offerId: offer.id, listingId: l.id, topUp: input.topUp, estimate: item.estimate });
    const seller = await this.user(l.sellerUserId);
    if (seller) {
      const lang = seller.language as Lang;
      const url = this.d.notifier ? await this.d.notifier.miniAppLink(`listing_${l.id}`).catch(() => null) : null;
      await this.dm(
        seller,
        t(lang, "trade.new_for_seller", {
          title: listingTitle(l, lang),
          item: item.title,
          condition: t(lang, `condition.${item.condition}`),
          estimate: item.estimate ? t(lang, "trade.estimate", { amount: formatUzs(item.estimate) }) : "",
          topup: this.topUpText(lang, input.topUp),
          description: item.description ? `\n«${item.description}»` : "",
          hours: OFFER_PENDING_HOURS,
        }),
        [
          [
            { text: t(lang, "offer.accept"), callbackData: `offer:accept:${offer.id}` },
            { text: t(lang, "offer.decline"), callbackData: `offer:decline:${offer.id}` },
          ],
          ...(url ? [[{ text: t(lang, "favorites.open"), url }]] : []),
        ],
      );
    }
    return this.offerDto(offer);
  }

  private topUpText(lang: Lang, topUp: number) {
    if (topUp > 0) return t(lang, "trade.topup_buyer", { amount: formatUzs(topUp) });
    if (topUp < 0) return t(lang, "trade.topup_seller", { amount: formatUzs(-topUp) });
    return t(lang, "trade.topup_none");
  }

  /** Seller's answer (bot button or API). Compare-and-set: a second tap or an expired offer changes nothing. */
  async decideOffer(seller: User, id: string, decision: "accept" | "decline"): Promise<OfferDto> {
    const [o] = await this.db.select().from(offers).where(eq(offers.id, id));
    if (!o) throw new OrderRejected("not_found", 404);
    if (o.sellerUserId !== seller.id) throw new OrderRejected("forbidden", 403);
    const now = new Date();
    if (decision === "accept") {
      const [l] = await this.db.select({ status: listings.status }).from(listings).where(eq(listings.id, o.listingId));
      if (l?.status !== "active") throw new OrderRejected("not_available", 409);
    }
    const [updated] = await this.db
      .update(offers)
      .set(
        decision === "accept"
          ? { status: "accepted", decidedAt: now, expiresAt: new Date(now.getTime() + OFFER_ACCEPTED_HOURS * 3600_000) }
          : { status: "declined", decidedAt: now },
      )
      .where(and(eq(offers.id, id), eq(offers.status, "pending"), gt(offers.expiresAt, now)))
      .returning();
    if (!updated) throw new OrderRejected("bad_state", 409);
    await this.d.repo.event(seller.id, `offer_${updated.status}`, { offerId: id, listingId: o.listingId });

    const [buyer, [l]] = await Promise.all([this.user(o.buyerUserId), this.db.select().from(listings).where(eq(listings.id, o.listingId))]);
    if (buyer && l) {
      const lang = buyer.language as Lang;
      const url = this.d.notifier ? await this.d.notifier.miniAppLink(`listing_${l.id}`).catch(() => null) : null;
      const trade = o.kind === "trade" ? (o.trade as TradeItem) : null;
      const text = trade
        ? updated.status === "accepted"
          ? t(lang, "trade.accepted_for_buyer", { title: listingTitle(l, lang), item: trade.title, topup: this.topUpText(lang, o.amount) })
          : t(lang, "trade.declined_for_buyer", { title: listingTitle(l, lang), item: trade.title })
        : updated.status === "accepted"
          ? t(lang, "offer.accepted_for_buyer", { title: listingTitle(l, lang), amount: formatUzs(o.amount), hours: OFFER_ACCEPTED_HOURS })
          : t(lang, "offer.declined_for_buyer", { title: listingTitle(l, lang), amount: formatUzs(o.amount) });
      const button = trade ? "trade.write_seller" : updated.status === "accepted" ? "offer.checkout" : "favorites.open";
      await this.dm(buyer, text, url ? [[{ text: t(lang, button), url }]] : []);
    }
    return this.offerDto(updated);
  }

  /**
   * «Предложить избранным» (Poshmark "Offer to Likers"): everyone who saved the item gets a personal price
   * for LIKERS_OFFER_HOURS — stored as an accepted offer per person, so checkout applies it as after a
   * successful haggle. At least LIKERS_OFFER_MIN_PCT off, once per LIKERS_OFFER_EVERY_DAYS, each lower than the last.
   */
  async offerToLikers(seller: User, listingId: string, price: number, now = new Date()) {
    const l = await this.availableListing(listingId);
    if (l.sellerUserId !== seller.id) throw new OrderRejected("forbidden", 403);
    if (price > maxLikersOffer(l.price!) || price < minOffer(l.price!)) throw new OrderRejected("likers_too_high", 400);
    if (l.likersOfferAt && now.getTime() - l.likersOfferAt.getTime() < LIKERS_OFFER_EVERY_DAYS * DAY_MS) throw new OrderRejected("likers_too_soon", 409);
    if (l.likersOfferPrice && l.likersOfferAt && now.getTime() - l.likersOfferAt.getTime() < 90 * DAY_MS && price >= l.likersOfferPrice) {
      throw new OrderRejected("likers_not_lower", 400);
    }
    const likers = await this.db
      .select({ u: users })
      .from(favorites)
      .innerJoin(users, eq(users.id, favorites.userId))
      .where(and(eq(favorites.listingId, l.id), ne(favorites.userId, seller.id), sql`${users.bannedAt} is null`));
    if (!likers.length) throw new OrderRejected("no_likers", 409);
    // At night the messages wait for the morning, and the 24 hours start then (stage 17, quiet hours).
    const deferredUntil = this.d.enqueue ? (this.d.quietUntil?.(now) ?? null) : null;
    const expiresAt = new Date((deferredUntil ?? now).getTime() + LIKERS_OFFER_HOURS * 3600_000);
    await this.db.transaction(async (tx) => {
      // Compare-and-set on the previous offer time: a double tap sends one round, not two.
      const [claimed] = await tx
        .update(listings)
        .set({ likersOfferPrice: price, likersOfferAt: now })
        .where(and(eq(listings.id, l.id), l.likersOfferAt ? eq(listings.likersOfferAt, l.likersOfferAt) : isNull(listings.likersOfferAt)))
        .returning({ id: listings.id });
      if (!claimed) throw new OrderRejected("likers_too_soon", 409);
      await tx.insert(offers).values(
        likers.map(({ u }) => ({
          listingId: l.id,
          buyerUserId: u.id,
          sellerUserId: seller.id,
          amount: price,
          listPrice: l.price!,
          status: "accepted",
          decidedAt: now,
          expiresAt,
        })),
      );
    });
    await this.d.repo.event(seller.id, "likers_offer_sent", { listingId: l.id, price, recipients: likers.length });
    if (deferredUntil) await this.d.enqueue!("likers_offer_dms", { listingId: l.id, price }, deferredUntil);
    else await this.likersOfferDms(l.id, price);
    return { sent: likers.length, price, expiresAt: expiresAt.toISOString(), deferredUntil: deferredUntil?.toISOString() ?? null };
  }

  /**
   * «Предложить магазинам»: the listing goes to verified shops (not the seller's own, not banned, not blocked
   * either way, not switched off), once per SHOPS_OFFER_EVERY_DAYS. Shops answer with an ordinary offer.
   */
  async offerToShops(seller: User, listingId: string, now = new Date()) {
    const l = await this.availableListing(listingId);
    if (l.sellerUserId !== seller.id) throw new OrderRejected("forbidden", 403);
    if (l.shopsOfferAt && now.getTime() - l.shopsOfferAt.getTime() < SHOPS_OFFER_EVERY_DAYS * DAY_MS) throw new OrderRejected("shops_too_soon", 409);
    const recipients = await this.shopsForRequest(l);
    if (!recipients.length) throw new OrderRejected("no_shops", 409);
    // Compare-and-set on the previous request time: a double tap sends one round.
    const [claimed] = await this.db
      .update(listings)
      .set({ shopsOfferAt: now })
      .where(and(eq(listings.id, l.id), l.shopsOfferAt ? eq(listings.shopsOfferAt, l.shopsOfferAt) : isNull(listings.shopsOfferAt)))
      .returning({ id: listings.id });
    if (!claimed) throw new OrderRejected("shops_too_soon", 409);
    await this.d.repo.event(seller.id, "shops_offer_sent", { listingId: l.id, recipients: recipients.length });
    const deferredUntil = this.d.enqueue ? (this.d.quietUntil?.(now) ?? null) : null;
    if (deferredUntil) await this.d.enqueue!("shops_offer_dms", { listingId: l.id }, deferredUntil);
    else await this.shopsOfferDms(l.id);
    return { sent: recipients.length, deferredUntil: deferredUntil?.toISOString() ?? null };
  }

  private async shopsForRequest(l: Listing) {
    return this.db
      .select({ u: users, shopName: shops.name })
      .from(shops)
      .innerJoin(users, eq(users.id, shops.ownerUserId))
      .where(
        and(
          eq(shops.verified, true),
          ne(shops.ownerUserId, l.sellerUserId),
          sql`${users.bannedAt} is null`,
          sql`not ('shops_request' = any(${users.notifyOff}))`,
          sql`not exists (select 1 from user_blocks b where (b.blocker_user_id = ${users.id} and b.blocked_user_id = ${l.sellerUserId})
                or (b.blocker_user_id = ${l.sellerUserId} and b.blocked_user_id = ${users.id}))`,
        ),
      )
      .orderBy(asc(shops.verifiedAt))
      .limit(SHOPS_OFFER_MAX);
  }

  /** The request messages to shops (now, or in the morning after quiet hours). */
  async shopsOfferDms(listingId: string) {
    const [l] = await this.db.select().from(listings).where(eq(listings.id, listingId));
    if (!l || l.status !== "active" || !l.price || (await this.sellerIsAway(l.sellerUserId))) return 0;
    const recipients = await this.shopsForRequest(l);
    const url = this.d.notifier ? await this.d.notifier.miniAppLink(`listing_${l.id}`).catch(() => null) : null;
    for (const { u } of recipients) {
      const lang = u.language as Lang;
      await this.dm(
        u,
        t(lang, "shops_offer.for_shop", {
          title: listingTitle(l, lang),
          price: formatUzs(l.price),
          grade: l.grade ? ` · ${t(lang, "passport.grade", { grade: l.grade })}` : "",
          hours: OFFER_PENDING_HOURS,
        }),
        [...(url ? [[{ text: t(lang, "shops_offer.make_offer"), url }]] : []), unsubscribeRow(lang, "shops_request")],
      );
    }
    return recipients.length;
  }

  /** The messages of an offer to likers: to everyone whose personal price is still open. */
  async likersOfferDms(listingId: string, price: number) {
    const [l] = await this.db.select().from(listings).where(eq(listings.id, listingId));
    if (!l || l.status !== "active" || l.likersOfferPrice !== price || (await this.sellerIsAway(l.sellerUserId))) return 0;
    const rows = await this.db
      .select({ u: users })
      .from(offers)
      .innerJoin(users, eq(users.id, offers.buyerUserId))
      .where(
        and(
          eq(offers.listingId, l.id),
          eq(offers.kind, "price"),
          eq(offers.status, "accepted"),
          eq(offers.amount, price),
          gt(offers.expiresAt, new Date()),
          sql`${users.bannedAt} is null`,
          // The personal price still applies at checkout; only the message is skipped.
          sql`not ('likers_offer' = any(${users.notifyOff}))`,
        ),
      );
    const url = this.d.notifier ? await this.d.notifier.miniAppLink(`listing_${l.id}`).catch(() => null) : null;
    for (const { u } of rows) {
      const lang = u.language as Lang;
      await this.dm(
        u,
        t(lang, "likers.offer_for_buyer", { title: listingTitle(l, lang), price: formatUzs(price), old: formatUzs(l.price!), hours: LIKERS_OFFER_HOURS }),
        [...(url ? [[{ text: t(lang, "offer.checkout"), url }]] : []), unsubscribeRow(lang, "likers_offer")],
      );
    }
    return rows.length;
  }

  /** Hourly tidy-up: offers past their deadline are marked expired. */
  async expireOffers(now = new Date()) {
    const rows = await this.db
      .update(offers)
      .set({ status: "expired" })
      .where(and(inArray(offers.status, ["pending", "accepted"]), lt(offers.expiresAt, now)))
      .returning({ id: offers.id });
    return rows.length;
  }

  // ---------- buyer ----------
  async create(buyer: User, input: CreateOrderInput) {
    const extraIds = [...new Set(input.extraListingIds ?? [])].filter((id) => id !== input.listingId);
    const l = await this.availableListing(input.listingId);
    if (l.sellerUserId === buyer.id) throw new OrderRejected("own_listing", 409);
    if (!this.allowedModes(l).includes(input.mode)) throw new OrderRejected("mode_not_allowed", 400);
    if (!buyer.phone) throw new OrderRejected("phone_required", 409);

    const open = await this.db
      .select({ listingId: orders.listingId })
      .from(orders)
      .where(and(eq(orders.buyerUserId, buyer.id), inArray(orders.status, OPEN_ORDER_STATUSES)));
    if (open.some((o) => o.listingId === l.id || extraIds.includes(o.listingId))) throw new OrderRejected("already_ordered", 409);
    if (open.length + 1 + extraIds.length > MAX_OPEN_ORDERS_PER_BUYER) throw new OrderRejected("open_orders_limit", 429);
    // Order → cancel → order again sends the seller a DM each time: at most 3 requests per item per day.
    const [{ recent }] = (await this.db
      .select({ recent: count() })
      .from(orders)
      .where(and(eq(orders.buyerUserId, buyer.id), eq(orders.listingId, l.id), gt(orders.createdAt, new Date(Date.now() - 24 * 3600_000))))) as [
      { recent: number },
    ];
    if (recent >= 3) throw new OrderRejected("too_many_attempts", 429);

    const lift = input.floor ? { floor: input.floor, elevator: input.elevator ?? false } : null;
    const { modes: _m, offerId, bundle, ...quote } = await this.quote(l.id, input.district, input.mode, buyer.id, extraIds, lift);
    // A bundle shares the first order's id; every order of it is created or none.
    const id = randomUUID();
    const base = {
      buyerUserId: buyer.id,
      sellerUserId: l.sellerUserId,
      mode: input.mode,
      district: input.district,
      // Only the buyer and operators ever see the address; the seller sees the district.
      address: input.address,
      comment: input.comment || null,
      provider: this.d.courier.name,
      bundleId: bundle ? id : null,
    };
    const [extraRows] = bundle ? [await this.db.select().from(listings).where(inArray(listings.id, bundle.items.map((i) => i.listingId)))] : [[]];
    const feeOf = new Map(extraRows.map((r) => [r.id, r.feePayer]));
    let order: Order;
    try {
      order = await this.db.transaction(async (tx) => {
        const [main] = (await tx
          .insert(orders)
          .values({ ...base, id, listingId: l.id, quote, feePayer: l.feePayer })
          .returning()) as [Order];
        for (const item of bundle?.items ?? []) {
          await tx.insert(orders).values({ ...base, listingId: item.listingId, quote: item.quote, feePayer: feeOf.get(item.listingId) ?? l.feePayer });
        }
        return main;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new OrderRejected("already_ordered", 409);
      throw err;
    }
    const created = bundle ? await this.db.select().from(orders).where(eq(orders.bundleId, id)) : [order];
    for (const o of created) {
      await this.db.insert(orderEvents).values({ orderId: o.id, status: "new", actorUserId: buyer.id, actor: "buyer" });
      await this.db.update(listings).set({ requestsCount: sql`${listings.requestsCount} + 1` }).where(eq(listings.id, o.listingId));
    }
    await this.d.repo.event(buyer.id, "order_created", { orderId: order.id, listingId: l.id, mode: input.mode, offerId, bundleSize: created.length });

    const [seller] = await this.db.select().from(users).where(eq(users.id, l.sellerUserId));
    if (seller) {
      const lang = seller.language as Lang;
      const titles = [listingTitle(l, lang), ...extraRows.map((x) => listingTitle(x, lang))];
      const receives = quote.sellerReceives + (bundle?.items.reduce((sum, i) => sum + i.quote.sellerReceives, 0) ?? 0);
      await this.dm(seller, t(lang, "order.new_for_seller", {
        title: titles.join("», «"),
        mode: t(lang, `delivery.${input.mode}`),
        district: t(lang, `district.${input.district}`),
        receives: formatUzs(receives),
      }) + (bundle ? `\n${t(lang, "order.bundle_note", { n: titles.length })}` : "") + (bundle?.discount ? `\n${t(lang, "order.bundle_discount_note", { pct: bundle.discountPct, amount: formatUzs(bundle.discount) })}` : "") + (quote.vehicle === "cargo" ? `\n${t(lang, "order.cargo_for_seller")}` : ""), [
        [
          { text: t(lang, "order.confirm"), callbackData: `order:confirm:${order.id}` },
          { text: t(lang, "order.decline"), callbackData: `order:decline:${order.id}` },
        ],
        ...(await this.openButton(lang, order.id)),
      ]);
    }
    return this.dto(order.id, buyer);
  }

  async cancel(buyer: User, id: string) {
    const o = await this.load(id);
    if (o.buyerUserId !== buyer.id) throw new OrderRejected("forbidden", 403);
    await this.cascade(o, "cancelled", "buyer", buyer, "buyer_cancelled");
    return this.dto(id, buyer);
  }

  async review(buyer: User, id: string, rating: number, text?: string) {
    const o = await this.load(id);
    if (o.buyerUserId !== buyer.id) throw new OrderRejected("forbidden", 403);
    if (o.status !== "delivered") throw new OrderRejected("bad_state", 409);
    try {
      await this.db.insert(reviews).values({
        orderId: o.id,
        listingId: o.listingId,
        sellerUserId: o.sellerUserId,
        buyerUserId: buyer.id,
        rating,
        text: text ? scrubPii(text).slice(0, 500) : null,
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new OrderRejected("review_exists", 409);
      throw err;
    }
    await this.d.repo.event(buyer.id, "review_created", { orderId: o.id, rating });
    const [seller] = await this.db.select().from(users).where(eq(users.id, o.sellerUserId));
    if (seller) {
      const lang = seller.language as Lang;
      await this.dm(seller, t(lang, "order.review_received", { stars: "⭐".repeat(rating), text: text ? `\n«${scrubPii(text)}»` : "" }));
    }
    return this.dto(id, buyer);
  }

  // ---------- Ishonch guarantee ----------
  private disputeDto(d: typeof disputes.$inferSelect, photos: string[] = []): DisputeDto {
    return {
      id: d.id,
      orderId: d.orderId,
      reason: d.reason as DisputeReason,
      text: d.text,
      sellerResponse: d.sellerResponse,
      status: d.status as DisputeDto["status"],
      resolution: (d.resolution as DisputeResolution | null) ?? null,
      amount: d.amount,
      note: d.note,
      photos,
      createdAt: d.createdAt.toISOString(),
      resolvedAt: d.resolvedAt?.toISOString() ?? null,
    };
  }

  private guaranteeUntil(o: Order) {
    return o.status === "delivered" && o.deliveredAt ? new Date(o.deliveredAt.getTime() + GUARANTEE_DAYS * DAY_MS) : null;
  }

  /** The buyer found a problem within GUARANTEE_DAYS of delivery: the seller and the moderators are told. */
  async openDispute(buyer: User, id: string, input: { reason: DisputeReason; text: string }) {
    const o = await this.load(id);
    if (o.buyerUserId !== buyer.id) throw new OrderRejected("forbidden", 403);
    const until = this.guaranteeUntil(o);
    if (!until) throw new OrderRejected("bad_state", 409);
    if (until <= new Date()) throw new OrderRejected("guarantee_expired", 409);
    const text = scrubPii(input.text);
    try {
      await this.db.insert(disputes).values({
        orderId: o.id,
        listingId: o.listingId,
        buyerUserId: o.buyerUserId,
        sellerUserId: o.sellerUserId,
        reason: input.reason,
        text,
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new OrderRejected("dispute_exists", 409);
      throw err;
    }
    await this.d.repo.event(buyer.id, "dispute_opened", { orderId: o.id, reason: input.reason });
    const [seller, [l]] = await Promise.all([this.user(o.sellerUserId), this.db.select().from(listings).where(eq(listings.id, o.listingId))]);
    if (seller) {
      const lang = seller.language as Lang;
      await this.dm(
        seller,
        t(lang, "dispute.new_for_seller", { title: l ? listingTitle(l, lang) : "—", reason: t(lang, `dispute.reason.${input.reason}`), text }),
        await this.openButton(lang, o.id, "dispute.respond"),
      );
    }
    await this.d.staff.moderators(
      [
        `⚖️ Спор покупателя, заказ #${o.id.slice(0, 8)}`,
        `${l ? listingTitle(l, "ru") : "—"} — ${formatUzs(normalizeQuote(o.quote as DeliveryQuote).itemPrice)}`,
        `Причина: ${t("ru", `dispute.reason.${input.reason}`)}`,
        `«${text}»`,
        `Решение — в админке, раздел «Споры».`,
      ].join("\n"),
    );
    return this.dto(id, buyer);
  }

  /** The seller's side of the story (once, while the dispute is open). */
  async respondDispute(seller: User, id: string, text: string) {
    const o = await this.load(id);
    if (o.sellerUserId !== seller.id) throw new OrderRejected("forbidden", 403);
    const [updated] = await this.db
      .update(disputes)
      .set({ sellerResponse: scrubPii(text) })
      .where(and(eq(disputes.orderId, o.id), eq(disputes.status, "open"), sql`${disputes.sellerResponse} is null`))
      .returning();
    if (!updated) throw new OrderRejected("bad_state", 409);
    await this.d.staff.moderators(`⚖️ Продавец ответил по спору #${o.id.slice(0, 8)}:\n«${updated.sellerResponse}»`);
    return this.dto(id, seller);
  }

  /** Admin queue: open disputes first, with what the decision needs (prices, phones, both stories). */
  async adminDisputes(all = false) {
    const rows = await this.db
      .select({ d: disputes, o: orders, titleRu: listings.titleRu, titleUz: listings.titleUz })
      .from(disputes)
      .innerJoin(orders, eq(orders.id, disputes.orderId))
      .innerJoin(listings, eq(listings.id, disputes.listingId))
      .where(all ? undefined : eq(disputes.status, "open"))
      .orderBy(asc(disputes.status), desc(disputes.createdAt))
      .limit(100);
    if (!rows.length) return [];
    const people = await this.db
      .select({ id: users.id, phone: users.phone })
      .from(users)
      .where(inArray(users.id, [...new Set(rows.flatMap((r) => [r.d.buyerUserId, r.d.sellerUserId]))]));
    const phoneOf = new Map(people.map((u) => [u.id, u.phone]));
    const orderIds = rows.map((r) => r.d.orderId);
    const [photosOf, inspectionOf] = this.d.evidence
      ? await Promise.all([this.d.evidence.orderPhotos(orderIds, "dispute_photo"), this.d.evidence.orderPhotos(orderIds, "inspection_photo")])
      : [new Map<string, string[]>(), new Map<string, string[]>()];
    return rows.map((r) => ({
      ...this.disputeDto(r.d, photosOf.get(r.d.orderId) ?? []),
      inspectionPhotos: inspectionOf.get(r.d.orderId) ?? [],
      title: r.titleRu || r.titleUz,
      listingId: r.d.listingId,
      itemPrice: normalizeQuote(r.o.quote as DeliveryQuote).itemPrice,
      deliveredAt: r.o.deliveredAt?.toISOString() ?? null,
      inspection: (r.o.inspection as Inspection | null) ?? null,
      buyerPhone: phoneOf.get(r.d.buyerUserId) ?? null,
      sellerPhone: phoneOf.get(r.d.sellerUserId) ?? null,
    }));
  }

  /** Admin's decision; both sides are told. A refund or compensation counts against the seller's trust. */
  async resolveDispute(admin: User, disputeId: string, input: { resolution: DisputeResolution; amount?: number; note?: string }) {
    const [d] = await this.db.select().from(disputes).where(eq(disputes.id, disputeId));
    if (!d) throw new OrderRejected("not_found", 404);
    const o = await this.load(d.orderId);
    const itemPrice = normalizeQuote(o.quote as DeliveryQuote).itemPrice;
    if (input.resolution === "partial" && (!input.amount || input.amount >= itemPrice)) throw new OrderRejected("bad_amount", 400);
    const amount = input.resolution === "partial" ? input.amount! : input.resolution === "refund" ? itemPrice : null;
    const [updated] = await this.db
      .update(disputes)
      .set({ status: "resolved", resolution: input.resolution, amount, note: input.note || null, resolvedBy: admin.id, resolvedAt: new Date() })
      .where(and(eq(disputes.id, d.id), eq(disputes.status, "open")))
      .returning();
    if (!updated) throw new OrderRejected("bad_state", 409);
    await this.d.repo.event(admin.id, "dispute_resolved", { orderId: o.id, resolution: input.resolution, amount });
    const [l] = await this.db.select().from(listings).where(eq(listings.id, o.listingId));
    for (const [uid, key] of [
      [o.buyerUserId, "dispute.resolved_for_buyer"],
      [o.sellerUserId, "dispute.resolved_for_seller"],
    ] as const) {
      const u = await this.user(uid);
      if (!u) continue;
      const lang = u.language as Lang;
      await this.dm(
        u,
        t(lang, key, {
          title: l ? listingTitle(l, lang) : "—",
          outcome: t(lang, `dispute.resolution.${input.resolution}`, { amount: amount ? formatUzs(amount) : "" }),
          note: input.note ? `\n${input.note}` : "",
        }),
        await this.openButton(lang, o.id),
      );
    }
    return this.disputeDto(updated);
  }

  async openDisputesCount() {
    const [{ n }] = (await this.db.select({ n: count() }).from(disputes).where(eq(disputes.status, "open"))) as [{ n: number }];
    return Number(n);
  }

  /** The orders of a bundle (or just this one), the first order last: it carries the loud side effects. */
  private async withBundle(o: Order, statuses?: string[]): Promise<Order[]> {
    if (!o.bundleId) return [o];
    const rows = await this.db
      .select()
      .from(orders)
      .where(and(eq(orders.bundleId, o.bundleId), ...(statuses ? [inArray(orders.status, statuses)] : [])));
    const list = rows.some((r) => r.id === o.id) ? rows : [...rows, o];
    return list.sort((a, b) => Number(a.id === o.bundleId) - Number(b.id === o.bundleId) || a.createdAt.getTime() - b.createdAt.getTime());
  }

  // ---------- seller ----------
  /** Confirms the order — the whole bundle when it is one (each item gets reserved). */
  async confirm(seller: User, id: string) {
    const o = await this.load(id);
    if (o.sellerUserId !== seller.id) throw new OrderRejected("forbidden", 403);
    if (o.status !== "new") throw new OrderRejected("bad_state", 409);
    // The bundle's first order carries the delivery fee: it is confirmed first, and if its item is gone the
    // whole request closes (the rest was priced without a delivery fee of its own).
    const group = (await this.withBundle(o, ["new"])).sort((a, b) => Number(b.id === b.bundleId) - Number(a.id === a.bundleId));
    const [main, ...rest] = group;
    let confirmedMain: Order;
    try {
      confirmedMain = await this.confirmOne(main!, seller);
    } catch (err) {
      if (rest.length && err instanceof OrderRejected && err.code === "not_available") {
        await this.cascade(main!, "cancelled", "seller", seller, "listing_unavailable").catch(() => undefined);
      }
      throw err;
    }
    for (const item of rest) {
      try {
        await this.confirmOne(item, seller);
      } catch (err) {
        if (err instanceof OrderRejected && err.code === "not_available") {
          // An extra item sold meanwhile: the buyer is told it dropped out; the rest of the trip goes.
          await this.transition(item, "cancelled", "seller", seller, "listing_unavailable").catch(() => undefined);
        } else {
          // The main order is already confirmed: never leave it without a courier booking and an operator card
          // because of one extra item. That item stays "new"; the operator sees it in the bundle.
          console.error("bundle item confirm failed", item.id, err);
        }
      }
    }
    // One courier booking, one operator card and one message to the buyer for the whole trip.
    await this.announceConfirmed(confirmedMain);
    return this.dto(id, seller);
  }

  private async confirmOne(o: Order, seller: User): Promise<Order> {
    // Reserve the listing first; the partial unique index also guarantees a single reservation.
    const reserved = await this.db
      .update(listings)
      .set({ status: "reserved", updatedAt: new Date() })
      .where(and(eq(listings.id, o.listingId), eq(listings.status, "active")))
      .returning({ id: listings.id });
    if (!reserved.length) throw new OrderRejected("not_available", 409);
    try {
      return await this.transition(o, "confirmed", "seller", seller, null, {}, { quiet: true });
    } catch (err) {
      // Undo the reservation only if the order did not get confirmed (a later side effect may have thrown).
      const [now] = await this.db.select({ status: orders.status }).from(orders).where(eq(orders.id, o.id));
      if (now?.status === "new" || now?.status === "cancelled") {
        await this.db.update(listings).set({ status: "active" }).where(and(eq(listings.id, o.listingId), eq(listings.status, "reserved")));
      }
      if (isUniqueViolation(err)) throw new OrderRejected("not_available", 409);
      throw err;
    }
  }

  async decline(seller: User, id: string) {
    const o = await this.load(id);
    if (o.sellerUserId !== seller.id) throw new OrderRejected("forbidden", 403);
    await this.cascade(o, "cancelled", "seller", seller, "seller_declined");
    return this.dto(id, seller);
  }

  /**
   * Applies a status to the order and to the bundle orders that are in the same status (one courier trip):
   * only the last transition notifies, so nobody gets N identical messages.
   */
  private async cascade(o: Order, to: OrderStatus, actor: OrderActor, user: User | null, note: string | null, extra: Partial<Pick<Order, "courierName" | "courierPhone">> = {}) {
    const group = (await this.withBundle(o, [o.status])).filter((x) => x.id === o.id || canTransition(x.status as OrderStatus, to, actor));
    // The order acted on goes first so that its own refusal (bad state) surfaces as the error.
    group.sort((a, b) => Number(b.id === o.id) - Number(a.id === o.id));
    const [first, ...rest] = group;
    await this.transition(first!, to, actor, user, note, extra, { quiet: rest.length > 0 });
    for (const [i, x] of rest.entries()) {
      await this.transition(x, to, actor, user, note, extra, { quiet: i < rest.length - 1 }).catch(() => undefined);
    }
  }

  // ---------- operator ----------
  async operatorSetStatus(
    op: User,
    id: string,
    status: OrderStatus,
    extra: { note?: string; courierName?: string; courierPhone?: string; wholeBundle?: boolean } = {},
  ) {
    const o = await this.load(id);
    const fields = {
      ...(extra.courierName ? { courierName: extra.courierName } : {}),
      ...(extra.courierPhone ? { courierPhone: extra.courierPhone } : {}),
    };
    // One courier trip moves the whole bundle; at the door the buyer may keep some items and return others,
    // so delivered/returned go per item unless the bot's card button says "the whole bundle".
    if ((status === "delivered" || status === "returned") && !extra.wholeBundle) {
      await this.transition(o, status, "operator", op, extra.note ?? null, fields);
    } else {
      await this.cascade(o, status, "operator", op, extra.note ?? null, fields);
    }
    const fresh = await this.load(id);
    return { order: await this.dto(id, op), card: await this.operatorCard(fresh) };
  }

  async operatorList(status?: OrderStatus) {
    const rows = await this.db
      .select()
      .from(orders)
      .where(status ? eq(orders.status, status) : inArray(orders.status, OPEN_ORDER_STATUSES))
      .orderBy(asc(orders.createdAt))
      .limit(100);
    if (!rows.length) return [];
    const userIds = [...new Set(rows.flatMap((o) => [o.buyerUserId, o.sellerUserId]))];
    const [dtos, people, imeis] = await Promise.all([
      this.dtos(rows, null, "operator"),
      this.db.select({ id: users.id, phone: users.phone }).from(users).where(inArray(users.id, userIds)),
      this.db.select({ id: listings.id, imei: listings.imei, category: listings.category }).from(listings).where(inArray(listings.id, [...new Set(rows.map((o) => o.listingId))])),
    ]);
    const phoneOf = new Map(people.map((u) => [u.id, u.phone]));
    const listingOf = new Map(imeis.map((l) => [l.id, l]));
    return rows.map((o, i) => ({
      ...dtos[i]!,
      contacts: { buyerPhone: phoneOf.get(o.buyerUserId) ?? null, sellerPhone: phoneOf.get(o.sellerUserId) ?? null, courierPhone: o.courierPhone },
      imei: listingOf.get(o.listingId)?.imei ?? null,
      category: listingOf.get(o.listingId)?.category ?? "other",
    }));
  }

  /** Text + buttons for the operators' chat; the bot edits the message with it after every change. */
  async operatorCard(o: Order) {
    const [l] = await this.db.select().from(listings).where(eq(listings.id, o.listingId));
    const [buyer, seller] = await Promise.all([this.user(o.buyerUserId), this.user(o.sellerUserId)]);
    const q = normalizeQuote(o.quote as DeliveryQuote);
    const trip = await this.tripOf(o);
    const collect = o.mode === "delivery_only" ? 0 : trip.collect;
    const lines = [
      `📦 Заказ #${o.id.slice(0, 8)} — ${t("ru", `order.status.${o.status as OrderStatus}`)}`,
      ...(trip.orders.length > 1
        ? [
            `Сборный заказ, ${trip.orders.length} товара одной поездкой:`,
            ...trip.orders.map((x, i) => `  ${i + 1}. ${trip.titles[i]} — ${formatUzs((x.quote as DeliveryQuote).itemPrice)}`),
          ]
        : [`${l ? listingTitle(l, "ru") : "—"} — ${formatUzs(q.itemPrice)}`]),
      `Способ: ${t("ru", `delivery.${o.mode as DeliveryMode}`)}`,
      collect ? `💵 Получить с покупателя: ${formatUzs(collect)}` : `💵 Наличные не собирать`,
      ...(q.vehicle === "cargo"
        ? [
            `🚚 ГРУЗОВОЕ ТАКСИ с грузчиками${q.lift ? ` — ${q.lift.floor} этаж, ${q.lift.elevator ? "есть лифт" : "без лифта"}` : ""}`,
          ]
        : []),
      `Доставка: ${formatUzs(q.deliveryFee)}${q.liftFee ? ` + ${formatUzs(q.liftFee)} подъём` : ""}${q.codFee ? ` + ${formatUzs(q.codFee)} за наличные` : ""} (${t("ru", `fee_payer.${o.feePayer as FeePayer}`)})`,
      ``,
      `Забрать: ${l?.district ? t("ru", `district.${l.district as District}`) : "район не указан"}, продавец ${seller?.phone ?? "—"}`,
      ...(l?.imei ? [`IMEI: ${l.imei} — сверить с *#06# при получении`] : []),
      o.inspection
        ? `🔍 Осмотр: ${(o.inspection as Inspection).passed ? "✅ пройден" : "⚠️ есть замечания"}`
        : `🔍 Осмотр при получении: отметьте чек-лист в админке (заказы)`,
      `Доставить: ${t("ru", `district.${o.district as District}`)}, ${o.address}`,
      `Покупатель: ${buyer?.phone ?? "—"}${o.comment ? `\nКомментарий: ${o.comment}` : ""}`,
      ...(o.courierName ? [`Курьер: ${o.courierName}${o.courierPhone ? `, ${o.courierPhone}` : ""}`] : []),
    ];
    const buttons: NotifyButton[][] = operatorNextStatuses(o.status as OrderStatus).map((s) => [
      { text: t("ru", `order.op_action.${s}`), callbackData: `op:${s}:${o.id}` },
    ]);
    return { text: lines.join("\n"), buttons };
  }

  /** The listing left sale (sold elsewhere, archived, hidden, expired): pending requests are closed, buyers told. */
  async closeNewOrders(listingId: string, reason: string) {
    const open = await this.db.select().from(orders).where(and(eq(orders.listingId, listingId), eq(orders.status, "new")));
    // A bundle request is priced as a whole (one delivery fee): it is closed as a whole.
    for (const o of open) await this.cascade(o, "cancelled", "seller", null, reason).catch(() => undefined);
    return open.length;
  }

  /** Requests the seller ignored for `hours` are cancelled, so buyers are not stuck and their slots free up. */
  async expireStale(hours = 48, now = new Date()) {
    const stale = await this.db
      .select()
      .from(orders)
      .where(and(eq(orders.status, "new"), lt(orders.createdAt, new Date(now.getTime() - hours * 3600_000))))
      .limit(500);
    const seen = new Set<string>();
    for (const o of stale) {
      if (o.bundleId && seen.has(o.bundleId)) continue;
      if (o.bundleId) seen.add(o.bundleId);
      await this.cascade(o, "cancelled", "operator", null, "seller_timeout").catch(() => undefined);
    }
    return stale.length;
  }

  /**
   * «Проверено Ishonch»: the courier ticks the checklist when picking the item up. A passed inspection
   * puts a badge on the listing (it matters if the buyer refuses and the item goes back on sale) and
   * counts for the seller; a failed one removes an earlier badge and counts against the seller.
   */
  async inspect(op: User, id: string, input: { checks: Partial<Record<InspectionCheck, boolean>>; note?: string }) {
    const o = await this.load(id);
    if (!["confirmed", "courier_assigned", "picked_up", "delivered"].includes(o.status)) throw new OrderRejected("bad_state", 409);
    const values = Object.values(input.checks).filter((v): v is boolean => typeof v === "boolean");
    if (!values.length) throw new OrderRejected("bad_state", 400);
    // A monitor has no Face ID: only the checks of the item's category count.
    const [item] = await this.db.select({ category: listings.category }).from(listings).where(eq(listings.id, o.listingId));
    const allowed = inspectionChecks(item?.category ?? "other", true);
    if (Object.keys(input.checks).some((c) => !allowed.includes(c as InspectionCheck))) throw new OrderRejected("bad_state", 400);
    const now = new Date();
    const inspection: Inspection = { checks: input.checks, passed: values.every(Boolean), note: input.note || null, at: now.toISOString() };
    await this.db.update(orders).set({ inspection, updatedAt: now }).where(eq(orders.id, o.id));
    await this.db
      .update(listings)
      .set(inspection.passed ? { verifiedAt: now, verification: inspection } : { verifiedAt: null, verification: null })
      .where(eq(listings.id, o.listingId));
    await this.d.repo.event(op.id, "order_inspected", { orderId: o.id, passed: inspection.passed });
    return this.dto(id, op, "operator");
  }

  /**
   * One reminder to review a delivered order (Mercari / Avito ask the same): REVIEW_REMINDER_HOURS after
   * delivery, if there is no review yet; orders older than REVIEW_REMINDER_MAX_DAYS are left alone.
   */
  async remindReviews(now = new Date()) {
    const due = await this.db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.status, "delivered"),
          sql`${orders.reviewRemindedAt} is null`,
          lt(orders.deliveredAt, new Date(now.getTime() - REVIEW_REMINDER_HOURS * 3600_000)),
          gt(orders.deliveredAt, new Date(now.getTime() - REVIEW_REMINDER_MAX_DAYS * 24 * 3600_000)),
          sql`not exists (select 1 from ${reviews} r where r.order_id = ${orders.id})`,
        ),
      )
      .limit(500);
    for (const o of due) {
      // Mark first: a failing DM must not turn into a reminder every hour.
      // A bundle gets one reminder (all its delivered orders are marked together).
      const claimed = await this.db
        .update(orders)
        .set({ reviewRemindedAt: now })
        .where(and(o.bundleId ? eq(orders.bundleId, o.bundleId) : eq(orders.id, o.id), sql`${orders.reviewRemindedAt} is null`))
        .returning({ id: orders.id });
      if (!claimed.some((c) => c.id === o.id)) continue;
      const [buyer, [l]] = await Promise.all([this.user(o.buyerUserId), this.db.select().from(listings).where(eq(listings.id, o.listingId))]);
      if (!buyer) continue;
      const lang = buyer.language as Lang;
      if (buyer.notifyOff.includes("review_reminder")) continue;
      await this.dm(buyer, t(lang, "order.review_reminder", { title: l ? listingTitle(l, lang) : "" }), [
        ...(await this.openButton(lang, o.id, "order.leave_review")),
        unsubscribeRow(lang, "review_reminder"),
      ]);
    }
    return due.length;
  }

  /** Ban: open orders of the user are cancelled; ones already with the courier are left to the operator. */
  async cancelAllFor(userId: string) {
    const open = await this.db
      .select()
      .from(orders)
      .where(
        and(
          or(eq(orders.buyerUserId, userId), eq(orders.sellerUserId, userId)),
          inArray(orders.status, ["new", "confirmed", "courier_assigned"]),
        ),
      );
    const seen = new Set<string>();
    for (const o of open) {
      const key = `${o.bundleId ?? o.id}:${o.status}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await this.cascade(o, "cancelled", "operator", null, "banned").catch(() => undefined);
    }
    return open.length;
  }

  // ---------- reads ----------
  async mine(user: User, role: "buyer" | "seller") {
    const rows = await this.db
      .select()
      .from(orders)
      .where(eq(role === "buyer" ? orders.buyerUserId : orders.sellerUserId, user.id))
      .orderBy(desc(orders.createdAt))
      .limit(50);
    return this.dtos(rows, user);
  }

  async get(user: User, id: string) {
    const o = await this.load(id);
    const staff = user.role === "operator" || user.role === "admin";
    if (o.buyerUserId !== user.id && o.sellerUserId !== user.id && !staff) throw new OrderRejected("not_found", 404);
    return this.dto(id, user, staff && o.buyerUserId !== user.id && o.sellerUserId !== user.id ? "operator" : undefined);
  }

  /** Public: the latest reviews about a seller (no buyer identity). */
  async sellerReviews(sellerId: string) {
    const rows = await this.db
      .select()
      .from(reviews)
      .where(eq(reviews.sellerUserId, sellerId))
      .orderBy(desc(reviews.createdAt))
      .limit(20);
    return {
      rating: await this.d.listings.sellerRating(sellerId),
      reviews: rows.map((r) => ({ id: r.id, rating: r.rating, text: r.text, createdAt: r.createdAt.toISOString() })),
    };
  }

  async openOrdersCount(sellerId: string) {
    const [{ n }] = (await this.db
      .select({ n: count() })
      .from(orders)
      .where(and(eq(orders.sellerUserId, sellerId), eq(orders.status, "new")))) as [{ n: number }];
    return n;
  }

  // ---------- internals ----------
  private async load(id: string): Promise<Order> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new OrderRejected("not_found", 404);
    const [o] = await this.db.select().from(orders).where(eq(orders.id, id));
    if (!o) throw new OrderRejected("not_found", 404);
    return o;
  }

  private async user(id: string) {
    const [u] = await this.db.select().from(users).where(eq(users.id, id));
    return u ?? null;
  }

  /** Deep link to the order, or null (a Telegram API hiccup must not fail the request that sends it). */
  private async link(orderId: string): Promise<string | null> {
    if (!this.d.notifier) return null;
    return this.d.notifier.miniAppLink(`order_${orderId}`).catch((err) => (console.error("mini app link failed", err), null));
  }

  private async openButton(
    lang: Lang,
    orderId: string,
    key: "order.open" | "order.leave_review" | "dispute.respond" = "order.open",
  ): Promise<NotifyButton[][]> {
    const url = await this.link(orderId);
    return url ? [[{ text: t(lang, key), url }]] : [];
  }

  private async dm(u: User, text: string, buttons: NotifyButton[][] = []) {
    if (!this.d.notifier || u.bannedAt) return;
    await this.d.notifier.send(u.telegramId, text, buttons).catch((err) => console.error("order notification failed", err));
  }

  /**
   * The only place that changes an order's status: validates the transition for the actor, then in ONE
   * database transaction applies it (compare-and-set on the old status), writes the history and updates
   * the listing (reserved / back on sale / sold). Messages, the courier and the operator card come after
   * the commit: a crash in between can lose a message, never leave a listing reserved without an order.
   */
  private async transition(
    o: Order,
    to: OrderStatus,
    actor: OrderActor,
    actorUser: User | null,
    note: string | null,
    extra: Partial<Pick<Order, "courierName" | "courierPhone">> = {},
    /** quiet: a bundle sibling — no courier booking, operator card or messages (the last order of the bundle sends them). */
    opts: { quiet?: boolean } = {},
  ) {
    const from = o.status as OrderStatus;
    if (!canTransition(from, to, actor)) throw new OrderRejected("bad_state", 409);
    const now = new Date();
    const wasReserving = RESERVING_ORDER_STATUSES.includes(from);

    const { order, rivals, restored } = await this.db.transaction(async (tx) => {
      const updated = await tx
        .update(orders)
        .set({
          status: to,
          updatedAt: now,
          ...extra,
          ...(to === "cancelled" ? { cancelReason: note } : {}),
          ...(to === "delivered" ? { deliveredAt: now } : {}),
        })
        .where(and(eq(orders.id, o.id), eq(orders.status, from)))
        .returning();
      if (!updated.length) throw new OrderRejected("bad_state", 409);
      await tx.insert(orderEvents).values({ orderId: o.id, status: to, actorUserId: actorUser?.id ?? null, actor, note });

      let rivals: Order[] = [];
      if (to === "confirmed") {
        // Other requests for the same item are closed: it is reserved for this buyer. A rival that is part
        // of a bundle closes with its whole bundle (its delivery fee was priced for the whole trip).
        rivals = await tx
          .update(orders)
          .set({ status: "cancelled", cancelReason: "reserved_by_other", updatedAt: now })
          .where(and(eq(orders.listingId, o.listingId), eq(orders.status, "new")))
          .returning();
        const bundleIds = [...new Set(rivals.map((r) => r.bundleId).filter((b): b is string => !!b))];
        if (bundleIds.length) {
          rivals.push(
            ...(await tx
              .update(orders)
              .set({ status: "cancelled", cancelReason: "reserved_by_other", updatedAt: now })
              .where(and(inArray(orders.bundleId, bundleIds), eq(orders.status, "new")))
              .returning()),
          );
        }
        for (const r of rivals) await tx.insert(orderEvents).values({ orderId: r.id, status: "cancelled", actor: "seller", note: "reserved_by_other" });
      }

      let restored = false;
      if ((to === "cancelled" || to === "returned") && wasReserving) {
        // Back on sale unless it expired meanwhile.
        restored =
          (
            await tx
              .update(listings)
              .set({ status: "active", updatedAt: now })
              .where(and(eq(listings.id, o.listingId), eq(listings.status, "reserved"), gt(listings.expiresAt, now)))
              .returning({ id: listings.id })
          ).length > 0;
        await tx
          .update(listings)
          .set({ status: "archived", moderationReason: "expired", updatedAt: now })
          .where(and(eq(listings.id, o.listingId), eq(listings.status, "reserved")));
      }
      if (to === "delivered") {
        await tx.update(listings).set({ status: "sold", soldVia: "platform", soldAt: now, updatedAt: now }).where(eq(listings.id, o.listingId));
      }
      return { order: updated[0]!, rivals, restored };
    });

    // ---- after commit: analytics, messages, courier, operators ----
    await this.d.repo.event(actorUser?.id ?? null, "order_status", { orderId: o.id, from, to, actor });
    if (to === "delivered") await this.d.repo.event(o.buyerUserId, "order_delivered", { orderId: o.id, listingId: o.listingId });
    const [l] = await this.db.select().from(listings).where(eq(listings.id, o.listingId));

    // One message per rival request (a bundle is one request), to its buyer only: the seller caused it.
    const told = new Set<string>();
    for (const r of rivals) {
      const key = r.bundleId ?? r.id;
      if (told.has(key)) continue;
      told.add(key);
      await this.notifyStatus(r, l ?? null, "cancelled", "seller").catch((err) => console.error("rival notification failed", err));
    }
    if (to === "confirmed" && !opts.quiet) await this.announceConfirmed(order, { notify: false });
    if ((to === "cancelled" || to === "returned") && wasReserving && (!opts.quiet || order.externalId)) {
      await this.d.courier.cancelShipment(order).catch((err) => console.error("courier cancel failed", err));
    }
    // Complaints collected while the item was reserved still count once it is back on sale.
    if (restored) await this.d.onListingRestored?.(o.listingId).catch((err) => console.error("complaint recheck failed", err));

    if (!opts.quiet) await this.notifyStatus(order, l ?? null, to, actor);
    return order;
  }

  /** Courier booking + operator card (+ the buyer's message) once the seller confirmed the order / bundle. */
  private async announceConfirmed(order: Order, opts: { notify?: boolean } = {}) {
    const [l] = await this.db.select().from(listings).where(eq(listings.id, order.listingId));
    const [buyer, seller] = await Promise.all([this.user(order.buyerUserId), this.user(order.sellerUserId)]);
    const trip = await this.tripOf(order);
    const { externalId } = await this.d.courier.createShipment({
      order,
      pickup: { phone: seller?.phone ?? null, district: l?.district ?? null, address: null },
      dropoff: { phone: buyer?.phone ?? null, district: order.district, address: order.address },
      collectUzs: order.mode === "delivery_only" ? 0 : trip.collect,
      itemTitle: trip.titles.join(" + "),
    });
    if (externalId) await this.db.update(orders).set({ externalId }).where(eq(orders.id, order.id));
    const card = await this.operatorCard(order);
    await this.d.staff.operators(card.text, card.buttons);
    if (opts.notify !== false) await this.notifyStatus(order, l ?? null, "confirmed", "seller");
  }

  /** What travels with this order's courier: the live orders of its bundle (titles, cash to collect). */
  private async tripOf(o: Order) {
    const group = (await this.withBundle(o)).filter((x) => !["cancelled", "returned"].includes(x.status));
    const rows = await this.db.select().from(listings).where(inArray(listings.id, group.map((x) => x.listingId)));
    const byId = new Map(rows.map((r) => [r.id, r]));
    return {
      orders: group,
      titles: group.map((x) => (byId.get(x.listingId) ? listingTitle(byId.get(x.listingId)!, "ru") : "—")),
      collect: group.reduce((sum, x) => sum + (x.quote as DeliveryQuote).buyerTotal, 0),
      listings: byId,
    };
  }

  /** Tells the buyer and the seller (except whoever made the change) about a new status. */
  private async notifyStatus(o: Order, l: typeof listings.$inferSelect | null, to: OrderStatus, actor?: OrderActor) {
    const targets: Array<["buyer" | "seller", string]> = [
      ["buyer", o.buyerUserId],
      ["seller", o.sellerUserId],
    ];
    for (const [role, id] of targets) {
      if (actor === role) continue;
      const u = await this.user(id);
      if (!u) continue;
      const lang = u.language as Lang;
      const title = l ? listingTitle(l, lang) : "";
      let text = t(lang, `order.status_msg.${to}`, { title });
      if (to === "cancelled" && o.cancelReason) {
        const why = `order.cancel_reason.${o.cancelReason}`;
        const explained = t(lang, why as Parameters<typeof t>[1]);
        if (explained !== why) text += `\n${explained}`;
      }
      if (to === "courier_assigned" && o.courierName) text += `\n${t(lang, "order.courier", { name: o.courierName })}`;
      const buttons: NotifyButton[][] = [];
      if (to === "delivered" && role === "buyer") {
        text += `\n\n${t(lang, "order.ask_review")}`;
      }
      buttons.push(...(await this.openButton(lang, o.id)));
      await this.dm(u, text, buttons);
    }
  }

  async dto(id: string, viewer: User | null, as?: "operator"): Promise<OrderDto> {
    const [dto] = await this.dtos([await this.load(id)], viewer, as);
    return dto!;
  }

  /**
   * Batched DTOs: a fixed number of queries for any number of orders (listings, first photos, history,
   * reviews, bundle siblings), in the order given. Lists (my orders, the operators' queue) use this.
   */
  async dtos(rows: Order[], viewer: User | null, as?: "operator"): Promise<OrderDto[]> {
    if (!rows.length) return [];
    const orderIds = rows.map((o) => o.id);
    const listingIds = [...new Set(rows.map((o) => o.listingId))];
    const bundleIds = [...new Set(rows.map((o) => o.bundleId).filter((b): b is string => !!b))];
    const [listingRows, photoRows, history, reviewRows, siblings, disputeRows] = await Promise.all([
      this.db.select().from(listings).where(inArray(listings.id, listingIds)),
      this.db
        .selectDistinctOn([listingPhotos.listingId])
        .from(listingPhotos)
        .where(inArray(listingPhotos.listingId, listingIds))
        .orderBy(listingPhotos.listingId, asc(listingPhotos.position), asc(listingPhotos.id)),
      this.db.select().from(orderEvents).where(inArray(orderEvents.orderId, orderIds)).orderBy(asc(orderEvents.id)),
      this.db.select().from(reviews).where(inArray(reviews.orderId, orderIds)),
      bundleIds.length
        ? this.db
            .select({
              orderId: orders.id,
              bundleId: orders.bundleId,
              listingId: orders.listingId,
              status: orders.status,
              titleRu: listings.titleRu,
              titleUz: listings.titleUz,
              createdAt: orders.createdAt,
            })
            .from(orders)
            .innerJoin(listings, eq(listings.id, orders.listingId))
            .where(inArray(orders.bundleId, bundleIds))
            .orderBy(asc(orders.createdAt))
        : Promise.resolve([]),
      this.db.select().from(disputes).where(inArray(disputes.orderId, orderIds)),
    ]);
    const disputeOf = new Map(disputeRows.map((d) => [d.orderId, d]));
    const disputePhotos =
      this.d.evidence && disputeRows.length ? await this.d.evidence.orderPhotos(disputeRows.map((d) => d.orderId), "dispute_photo") : new Map<string, string[]>();
    const listingOf = new Map(listingRows.map((l) => [l.id, l]));
    const photoOf = new Map(photoRows.map((p) => [p.listingId, p]));
    const reviewOf = new Map(reviewRows.map((r) => [r.orderId, r]));
    const historyOf = new Map<string, typeof history>();
    for (const h of history) historyOf.set(h.orderId, [...(historyOf.get(h.orderId) ?? []), h]);

    return rows.map((o) => {
      const role: OrderDto["role"] = as ?? (viewer?.id === o.buyerUserId ? "buyer" : viewer?.id === o.sellerUserId ? "seller" : "operator");
      const l = listingOf.get(o.listingId);
      const photo = photoOf.get(o.listingId);
      const review = reviewOf.get(o.id);
      const status = o.status as OrderStatus;
      const dispute = disputeOf.get(o.id);
      const until = this.guaranteeUntil(o);
      const actions: OrderDto["actions"] = [];
      if (role === "buyer") {
        if (canTransition(status, "cancelled", "buyer")) actions.push("cancel");
        if (status === "delivered" && !review) actions.push("review");
        if (until && until > new Date() && !dispute) actions.push("dispute");
      }
      if (role === "seller") {
        if (status === "new") actions.push("confirm", "decline");
        else if (canTransition(status, "cancelled", "seller")) actions.push("cancel");
        if (dispute?.status === "open" && !dispute.sellerResponse) actions.push("dispute_response");
      }
      return {
        id: o.id,
        status,
        role,
        mode: o.mode as DeliveryMode,
        listing: {
          id: o.listingId,
          titleRu: l?.titleRu ?? "",
          titleUz: l?.titleUz ?? "",
          photoUrl: photo ? this.d.listings.photoUrl(photo.id, photo.storageKey) : null,
        },
        district: o.district as District,
        address: role === "seller" ? null : o.address,
        // The buyer's free text reaches the seller only without phones and links (deals stay inside Ishonch).
        comment: o.comment && role === "seller" ? scrubPii(o.comment) : o.comment,
        quote: normalizeQuote(o.quote as DeliveryQuote),
        feePayer: o.feePayer as FeePayer,
        courier: o.courierName ? { name: o.courierName } : null,
        cancelReason: o.cancelReason,
        createdAt: o.createdAt.toISOString(),
        updatedAt: o.updatedAt.toISOString(),
        history: (historyOf.get(o.id) ?? []).map((h) => ({ status: h.status as OrderStatus, at: h.createdAt.toISOString(), note: h.note })),
        review: review ? { id: review.id, rating: review.rating, text: review.text, createdAt: review.createdAt.toISOString() } : null,
        canReview: actions.includes("review"),
        actions,
        inspection: (o.inspection as Inspection | null) ?? null,
        guaranteeUntil: until?.toISOString() ?? null,
        dispute: dispute ? this.disputeDto(dispute, disputePhotos.get(o.id) ?? []) : null,
        bundle: siblings
          .filter((b) => o.bundleId && b.bundleId === o.bundleId && b.orderId !== o.id)
          .map((b) => ({ orderId: b.orderId, listingId: b.listingId, status: b.status as OrderStatus, titleRu: b.titleRu, titleUz: b.titleUz })),
      };
    });
  }
}
