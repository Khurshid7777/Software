import { and, asc, count, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import {
  MAX_OPEN_ORDERS_PER_BUYER,
  MVP_DELIVERY_MODES,
  OPEN_ORDER_STATUSES,
  RESERVING_ORDER_STATUSES,
  canTransition,
  formatUzs,
  listingTitle,
  operatorNextStatuses,
  pickTariff,
  quoteDelivery,
  scrubPii,
  t,
  type CourierTariff,
  type CreateOrderInput,
  type DeliveryMode,
  type DeliveryQuote,
  type District,
  type FeePayer,
  type Lang,
  type OrderActor,
  type OrderDto,
  type OrderStatus,
} from "@ishonch/shared";
import type { Repo } from "../../db/repo.js";
import { courierTariffs, listingPhotos, listings, orderEvents, orders, reviews, users, type Order, type User } from "../../db/schema.js";
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
  | "too_many_attempts";

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

  async quote(listingId: string, district: District, mode: DeliveryMode): Promise<DeliveryQuote & { modes: DeliveryMode[] }> {
    const l = await this.availableListing(listingId);
    const modes = this.allowedModes(l);
    if (!modes.includes(mode)) throw new OrderRejected("mode_not_allowed", 400);
    const tariff = pickTariff(await this.tariffs(), (l.district as District | null) ?? null, district);
    return { ...quoteDelivery({ tariff, itemPrice: l.price!, mode, feePayer: l.feePayer as FeePayer }), modes };
  }

  // ---------- buyer ----------
  async create(buyer: User, input: CreateOrderInput) {
    const l = await this.availableListing(input.listingId);
    if (l.sellerUserId === buyer.id) throw new OrderRejected("own_listing", 409);
    if (!this.allowedModes(l).includes(input.mode)) throw new OrderRejected("mode_not_allowed", 400);
    if (!buyer.phone) throw new OrderRejected("phone_required", 409);

    const open = await this.db
      .select({ listingId: orders.listingId })
      .from(orders)
      .where(and(eq(orders.buyerUserId, buyer.id), inArray(orders.status, OPEN_ORDER_STATUSES)));
    if (open.some((o) => o.listingId === l.id)) throw new OrderRejected("already_ordered", 409);
    if (open.length >= MAX_OPEN_ORDERS_PER_BUYER) throw new OrderRejected("open_orders_limit", 429);
    // Order → cancel → order again sends the seller a DM each time: at most 3 requests per item per day.
    const [{ recent }] = (await this.db
      .select({ recent: count() })
      .from(orders)
      .where(and(eq(orders.buyerUserId, buyer.id), eq(orders.listingId, l.id), gt(orders.createdAt, new Date(Date.now() - 24 * 3600_000))))) as [
      { recent: number },
    ];
    if (recent >= 3) throw new OrderRejected("too_many_attempts", 429);

    const { modes: _m, ...quote } = await this.quote(l.id, input.district, input.mode);
    let order: Order;
    try {
      [order] = (await this.db
        .insert(orders)
        .values({
          listingId: l.id,
          buyerUserId: buyer.id,
          sellerUserId: l.sellerUserId,
          mode: input.mode,
          district: input.district,
          // Only the buyer and operators ever see the address; the seller sees the district.
          address: input.address,
          comment: input.comment || null,
          quote,
          feePayer: l.feePayer,
          provider: this.d.courier.name,
        })
        .returning()) as [Order];
    } catch (err) {
      if (isUniqueViolation(err)) throw new OrderRejected("already_ordered", 409);
      throw err;
    }
    await this.db.insert(orderEvents).values({ orderId: order.id, status: "new", actorUserId: buyer.id, actor: "buyer" });
    await this.db.update(listings).set({ requestsCount: sql`${listings.requestsCount} + 1` }).where(eq(listings.id, l.id));
    await this.d.repo.event(buyer.id, "order_created", { orderId: order.id, listingId: l.id, mode: input.mode });

    const [seller] = await this.db.select().from(users).where(eq(users.id, l.sellerUserId));
    if (seller) {
      const lang = seller.language as Lang;
      await this.dm(seller, t(lang, "order.new_for_seller", {
        title: listingTitle(l, lang),
        mode: t(lang, `delivery.${input.mode}`),
        district: t(lang, `district.${input.district}`),
        receives: formatUzs(quote.sellerReceives),
      }), [
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
    await this.transition(o, "cancelled", "buyer", buyer, "buyer_cancelled");
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

  // ---------- seller ----------
  async confirm(seller: User, id: string) {
    const o = await this.load(id);
    if (o.sellerUserId !== seller.id) throw new OrderRejected("forbidden", 403);
    if (o.status !== "new") throw new OrderRejected("bad_state", 409);
    // Reserve the listing first; the partial unique index also guarantees a single reservation.
    const reserved = await this.db
      .update(listings)
      .set({ status: "reserved", updatedAt: new Date() })
      .where(and(eq(listings.id, o.listingId), eq(listings.status, "active")))
      .returning({ id: listings.id });
    if (!reserved.length) throw new OrderRejected("not_available", 409);
    try {
      await this.transition(o, "confirmed", "seller", seller, null);
    } catch (err) {
      // Undo the reservation only if the order did not get confirmed (a later side effect may have thrown).
      const [now] = await this.db.select({ status: orders.status }).from(orders).where(eq(orders.id, o.id));
      if (now?.status === "new" || now?.status === "cancelled") {
        await this.db.update(listings).set({ status: "active" }).where(and(eq(listings.id, o.listingId), eq(listings.status, "reserved")));
      }
      if (isUniqueViolation(err)) throw new OrderRejected("not_available", 409);
      throw err;
    }
    return this.dto(id, seller);
  }

  async decline(seller: User, id: string) {
    const o = await this.load(id);
    if (o.sellerUserId !== seller.id) throw new OrderRejected("forbidden", 403);
    await this.transition(o, "cancelled", "seller", seller, "seller_declined");
    return this.dto(id, seller);
  }

  // ---------- operator ----------
  async operatorSetStatus(
    op: User,
    id: string,
    status: OrderStatus,
    extra: { note?: string; courierName?: string; courierPhone?: string } = {},
  ) {
    const o = await this.load(id);
    await this.transition(o, status, "operator", op, extra.note ?? null, {
      ...(extra.courierName ? { courierName: extra.courierName } : {}),
      ...(extra.courierPhone ? { courierPhone: extra.courierPhone } : {}),
    });
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
        };
      }),
    );
  }

  /** Text + buttons for the operators' chat; the bot edits the message with it after every change. */
  async operatorCard(o: Order) {
    const [l] = await this.db.select().from(listings).where(eq(listings.id, o.listingId));
    const [buyer, seller] = await Promise.all([this.user(o.buyerUserId), this.user(o.sellerUserId)]);
    const q = o.quote as DeliveryQuote;
    const collect = o.mode === "delivery_only" ? 0 : q.buyerTotal;
    const lines = [
      `📦 Заказ #${o.id.slice(0, 8)} — ${t("ru", `order.status.${o.status as OrderStatus}`)}`,
      `${l ? listingTitle(l, "ru") : "—"} — ${formatUzs(q.itemPrice)}`,
      `Способ: ${t("ru", `delivery.${o.mode as DeliveryMode}`)}`,
      collect ? `💵 Получить с покупателя: ${formatUzs(collect)}` : `💵 Наличные не собирать`,
      `Доставка: ${formatUzs(q.deliveryFee)}${q.codFee ? ` + ${formatUzs(q.codFee)} за наличные` : ""} (${t("ru", `fee_payer.${o.feePayer as FeePayer}`)})`,
      ``,
      `Забрать: ${l?.district ? t("ru", `district.${l.district as District}`) : "район не указан"}, продавец ${seller?.phone ?? "—"}`,
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
    for (const o of open) await this.transition(o, "cancelled", "seller", null, reason).catch(() => undefined);
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
      const [buyer, seller] = await Promise.all([this.user(o.buyerUserId), this.user(o.sellerUserId)]);
      const q = o.quote as DeliveryQuote;
      const { externalId } = await this.d.courier.createShipment({
        order,
        pickup: { phone: seller?.phone ?? null, district: l?.district ?? null, address: null },
        dropoff: { phone: buyer?.phone ?? null, district: o.district, address: o.address },
        collectUzs: o.mode === "delivery_only" ? 0 : q.buyerTotal,
        itemTitle: l ? listingTitle(l, "ru") : "",
      });
      if (externalId) await this.db.update(orders).set({ externalId }).where(eq(orders.id, o.id));
      const card = await this.operatorCard(order);
      await this.d.staff.operators(card.text, card.buttons);
    }

    if ((to === "cancelled" || to === "returned") && wasReserving) {
      await this.d.courier.cancelShipment(order).catch((err) => console.error("courier cancel failed", err));
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

    await this.notifyStatus(order, l ?? null, to, actor);
    return order;
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
    };
  }
}
