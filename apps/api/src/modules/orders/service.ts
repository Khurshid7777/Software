import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, gt, inArray, lt, ne, or, sql } from "drizzle-orm";
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
  pickTariff,
  quoteDelivery,
  scrubPii,
  t,
  type BundleQuote,
  type CourierTariff,
  type CreateOrderInput,
  type DeliveryMode,
  type DeliveryQuote,
  type District,
  type Inspection,
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
import { courierTariffs, listingPhotos, listings, offers, orderEvents, orders, reviews, users, type Order, type User } from "../../db/schema.js";
import type { ChannelPublisher, Notifier, NotifyButton } from "../../telegram/publisher.js";
import type { StaffNotifier } from "../../telegram/staff.js";
import type { ListingService } from "../listings/service.js";
import type { CourierProvider } from "./courier.js";

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
  | "bundle_invalid";

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
  courier: CourierProvider;
  codPlatformEnabled: boolean;
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
      fromDistrict: (r.fromDistrict as District | null) ?? null,
      toDistrict: (r.toDistrict as District | null) ?? null,
      price: r.price,
      codFeePct: r.codFeePct,
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

  private async availableListing(listingId: string) {
    const [l] = await this.db.select().from(listings).where(eq(listings.id, listingId));
    if (!l) throw new OrderRejected("not_found", 404);
    if (l.status !== "active" || !l.price || (l.expiresAt && l.expiresAt <= new Date())) throw new OrderRejected("not_available", 409);
    return l;
  }

  /**
   * `buyerId`: a price the seller accepted for this buyer replaces the asking price (never above it).
   * `extraIds`: more items of the same seller in this delivery — no second delivery fee, only the COD fee.
   */
  async quote(
    listingId: string,
    district: District,
    mode: DeliveryMode,
    buyerId?: string,
    extraIds: string[] = [],
  ): Promise<DeliveryQuote & { modes: DeliveryMode[]; offerId: string | null; bundle: BundleQuote | null }> {
    const l = await this.availableListing(listingId);
    const modes = this.allowedModes(l);
    if (!modes.includes(mode)) throw new OrderRejected("mode_not_allowed", 400);
    const tariff = pickTariff(await this.tariffs(), (l.district as District | null) ?? null, district);
    const offer = buyerId ? await this.acceptedOffer(l.id, buyerId) : null;
    const itemPrice = offer ? Math.min(offer.amount, l.price!) : l.price!;
    const main = quoteDelivery({ tariff, itemPrice, mode, feePayer: l.feePayer as FeePayer });

    let bundle: BundleQuote | null = null;
    const extras = [...new Set(extraIds)].filter((id) => id !== l.id);
    if (extras.length) {
      const items: BundleQuote["items"] = [];
      for (const id of extras) {
        const x = await this.availableListing(id).catch(() => {
          throw new OrderRejected("bundle_invalid", 409);
        });
        if (x.sellerUserId !== l.sellerUserId || !this.allowedModes(x).includes(mode)) throw new OrderRejected("bundle_invalid", 409);
        const xOffer = buyerId ? await this.acceptedOffer(x.id, buyerId) : null;
        const xPrice = xOffer ? Math.min(xOffer.amount, x.price!) : x.price!;
        const xTariff = tariff ? { ...tariff, price: 0 } : null; // one courier trip: the delivery fee is in the main item
        items.push({ listingId: x.id, quote: quoteDelivery({ tariff: xTariff, itemPrice: xPrice, mode, feePayer: x.feePayer as FeePayer }) });
      }
      bundle = {
        items,
        buyerTotal: main.buyerTotal + items.reduce((sum, i) => sum + i.quote.buyerTotal, 0),
        saved: main.deliveryFee * items.length,
      };
    }
    return { ...main, modes, offerId: offer?.id ?? null, bundle };
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
        and(eq(offers.listingId, listingId), eq(offers.buyerUserId, buyerId), eq(offers.status, "accepted"), gt(offers.expiresAt, new Date())),
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
      amount: o.amount,
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
      await this.dm(
        seller,
        t(lang, "offer.new_for_seller", {
          title: listingTitle(l, lang),
          amount: formatUzs(amount),
          price: formatUzs(l.price!),
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
      const text =
        updated.status === "accepted"
          ? t(lang, "offer.accepted_for_buyer", { title: listingTitle(l, lang), amount: formatUzs(o.amount), hours: OFFER_ACCEPTED_HOURS })
          : t(lang, "offer.declined_for_buyer", { title: listingTitle(l, lang), amount: formatUzs(o.amount) });
      await this.dm(buyer, text, url ? [[{ text: t(lang, updated.status === "accepted" ? "offer.checkout" : "favorites.open"), url }]] : []);
    }
    return this.offerDto(updated);
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

    const { modes: _m, offerId, bundle, ...quote } = await this.quote(l.id, input.district, input.mode, buyer.id, extraIds);
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
      }) + (bundle ? `\n${t(lang, "order.bundle_note", { n: titles.length })}` : ""), [
        [
          { text: t(lang, "order.confirm"), callbackData: `order:confirm:${order.id}` },
          { text: t(lang, "order.decline"), callbackData: `order:decline:${order.id}` },
        ],
        [{ text: t(lang, "order.open"), url: await this.link(order.id) }],
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
    const group = await this.withBundle(o, ["new"]);
    let lastConfirmed: Order | null = null;
    for (const item of group) {
      try {
        lastConfirmed = await this.confirmOne(item, seller);
      } catch (err) {
        // A bundle item sold meanwhile is cancelled for the buyer; the rest still goes.
        if (group.length === 1 || !(err instanceof OrderRejected) || err.code !== "not_available") throw err;
        await this.transition(item, "cancelled", "seller", seller, "listing_unavailable", {}, { quiet: true }).catch(() => undefined);
      }
    }
    if (!lastConfirmed) throw new OrderRejected("not_available", 409);
    // One courier booking, one operator card and one message to the buyer for the whole trip.
    await this.announceConfirmed(lastConfirmed);
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
      .select({ id: orders.id })
      .from(orders)
      .where(status ? eq(orders.status, status) : inArray(orders.status, OPEN_ORDER_STATUSES))
      .orderBy(asc(orders.createdAt))
      .limit(100);
    return Promise.all(
      rows.map(async (r) => {
        const o = await this.load(r.id);
        const [buyer, seller] = await Promise.all([this.user(o.buyerUserId), this.user(o.sellerUserId)]);
        return {
          ...(await this.dto(r.id, null, "operator")),
          contacts: { buyerPhone: buyer?.phone ?? null, sellerPhone: seller?.phone ?? null, courierPhone: o.courierPhone },
          imei: (await this.db.select({ imei: listings.imei }).from(listings).where(eq(listings.id, o.listingId)))[0]?.imei ?? null,
        };
      }),
    );
  }

  /** Text + buttons for the operators' chat; the bot edits the message with it after every change. */
  async operatorCard(o: Order) {
    const [l] = await this.db.select().from(listings).where(eq(listings.id, o.listingId));
    const [buyer, seller] = await Promise.all([this.user(o.buyerUserId), this.user(o.sellerUserId)]);
    const q = o.quote as DeliveryQuote;
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
      `Доставка: ${formatUzs(q.deliveryFee)}${q.codFee ? ` + ${formatUzs(q.codFee)} за наличные` : ""} (${t("ru", `fee_payer.${o.feePayer as FeePayer}`)})`,
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
    for (const o of stale) await this.transition(o, "cancelled", "operator", null, "seller_timeout").catch(() => undefined);
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
      const claimed = await this.db
        .update(orders)
        .set({ reviewRemindedAt: now })
        .where(and(eq(orders.id, o.id), sql`${orders.reviewRemindedAt} is null`))
        .returning({ id: orders.id });
      if (!claimed.length) continue;
      const [buyer, [l]] = await Promise.all([this.user(o.buyerUserId), this.db.select().from(listings).where(eq(listings.id, o.listingId))]);
      if (!buyer) continue;
      const lang = buyer.language as Lang;
      await this.dm(buyer, t(lang, "order.review_reminder", { title: l ? listingTitle(l, lang) : "" }), [
        [{ text: t(lang, "order.leave_review"), url: await this.link(o.id) }],
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
    for (const o of open) await this.transition(o, "cancelled", "operator", null, "banned").catch(() => undefined);
    return open.length;
  }

  // ---------- reads ----------
  async mine(user: User, role: "buyer" | "seller") {
    const rows = await this.db
      .select({ id: orders.id })
      .from(orders)
      .where(eq(role === "buyer" ? orders.buyerUserId : orders.sellerUserId, user.id))
      .orderBy(desc(orders.createdAt))
      .limit(50);
    return Promise.all(rows.map((r) => this.dto(r.id, user)));
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

  private link(orderId: string) {
    return this.d.notifier ? this.d.notifier.miniAppLink(`order_${orderId}`) : Promise.resolve("");
  }

  private async dm(u: User, text: string, buttons: NotifyButton[][] = []) {
    if (!this.d.notifier || u.bannedAt) return;
    await this.d.notifier.send(u.telegramId, text, buttons).catch((err) => console.error("order notification failed", err));
  }

  /**
   * The only place that changes an order's status: validates the transition for the actor, applies it
   * atomically (compare-and-set on the old status), logs the event and runs the side effects.
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
    const updated = await this.db
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
    const order = updated[0]!;
    await this.db.insert(orderEvents).values({ orderId: o.id, status: to, actorUserId: actorUser?.id ?? null, actor, note });
    await this.d.repo.event(actorUser?.id ?? null, "order_status", { orderId: o.id, from, to, actor });

    const [l] = await this.db.select().from(listings).where(eq(listings.id, o.listingId));
    const wasReserving = RESERVING_ORDER_STATUSES.includes(from);

    if (to === "confirmed") {
      // Other requests for the same item are closed: it is reserved for this buyer.
      const others = await this.db
        .update(orders)
        .set({ status: "cancelled", cancelReason: "reserved_by_other", updatedAt: now })
        .where(and(eq(orders.listingId, o.listingId), eq(orders.status, "new")))
        .returning();
      for (const other of others) {
        await this.db.insert(orderEvents).values({ orderId: other.id, status: "cancelled", actor: "seller", note: "reserved_by_other" });
        await this.notifyStatus(other, l ?? null, "cancelled", "seller"); // the seller caused it: tell the buyer only
      }
      if (!opts.quiet) await this.announceConfirmed(order, { notify: false });
    }

    if ((to === "cancelled" || to === "returned") && wasReserving) {
      if (!opts.quiet || order.externalId) await this.d.courier.cancelShipment(order).catch((err) => console.error("courier cancel failed", err));
      // Back on sale unless it expired meanwhile.
      await this.db
        .update(listings)
        .set({ status: "active", updatedAt: now })
        .where(and(eq(listings.id, o.listingId), eq(listings.status, "reserved"), gt(listings.expiresAt, now)));
      await this.db
        .update(listings)
        .set({ status: "archived", moderationReason: "expired", updatedAt: now })
        .where(and(eq(listings.id, o.listingId), eq(listings.status, "reserved")));
    }

    if (to === "delivered") {
      await this.db
        .update(listings)
        .set({ status: "sold", soldVia: "platform", soldAt: now, updatedAt: now })
        .where(eq(listings.id, o.listingId));
      await this.d.repo.event(o.buyerUserId, "order_delivered", { orderId: o.id, listingId: o.listingId });
    }

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
      buttons.push([{ text: t(lang, "order.open"), url: await this.link(o.id) }]);
      await this.dm(u, text, buttons);
    }
  }

  private async bundleOf(o: Order): Promise<OrderDto["bundle"]> {
    if (!o.bundleId) return [];
    const rows = await this.db
      .select({ orderId: orders.id, listingId: orders.listingId, status: orders.status, titleRu: listings.titleRu, titleUz: listings.titleUz })
      .from(orders)
      .innerJoin(listings, eq(listings.id, orders.listingId))
      .where(and(eq(orders.bundleId, o.bundleId), ne(orders.id, o.id)))
      .orderBy(asc(orders.createdAt));
    return rows.map((r) => ({ ...r, status: r.status as OrderStatus }));
  }

  async dto(id: string, viewer: User | null, as?: "operator"): Promise<OrderDto> {
    const o = await this.load(id);
    const role: OrderDto["role"] = as ?? (viewer?.id === o.buyerUserId ? "buyer" : viewer?.id === o.sellerUserId ? "seller" : "operator");
    const [l] = await this.db.select().from(listings).where(eq(listings.id, o.listingId));
    const [photo] = await this.db
      .select()
      .from(listingPhotos)
      .where(eq(listingPhotos.listingId, o.listingId))
      .orderBy(asc(listingPhotos.position), asc(listingPhotos.id))
      .limit(1);
    const history = await this.db.select().from(orderEvents).where(eq(orderEvents.orderId, o.id)).orderBy(asc(orderEvents.id));
    const [review] = await this.db.select().from(reviews).where(eq(reviews.orderId, o.id));
    const status = o.status as OrderStatus;

    const actions: OrderDto["actions"] = [];
    if (role === "buyer") {
      if (canTransition(status, "cancelled", "buyer")) actions.push("cancel");
      if (status === "delivered" && !review) actions.push("review");
    }
    if (role === "seller") {
      if (status === "new") actions.push("confirm", "decline");
      else if (canTransition(status, "cancelled", "seller")) actions.push("cancel");
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
      quote: o.quote as DeliveryQuote,
      feePayer: o.feePayer as FeePayer,
      courier: o.courierName ? { name: o.courierName } : null,
      cancelReason: o.cancelReason,
      createdAt: o.createdAt.toISOString(),
      updatedAt: o.updatedAt.toISOString(),
      history: history.map((h) => ({ status: h.status as OrderStatus, at: h.createdAt.toISOString(), note: h.note })),
      review: review ? { id: review.id, rating: review.rating, text: review.text, createdAt: review.createdAt.toISOString() } : null,
      canReview: actions.includes("review"),
      actions,
      inspection: (o.inspection as Inspection | null) ?? null,
      bundle: await this.bundleOf(o),
    };
  }
}
