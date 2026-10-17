import { and, eq, inArray, sql } from "drizzle-orm";
import { PROMO_DAYS, PROMO_PLANS, listingTitle, t, type Lang, type PromoOptions, type PromoPlan } from "@ishonch/shared";
import type { Repo } from "../../db/repo.js";
import { listings, promotions, users, type User } from "../../db/schema.js";
import type { StarsPayments } from "../../telegram/publisher.js";

export type PromotionError = "promotion_disabled" | "not_found" | "forbidden" | "not_active" | "bad_payment";

export class PromotionRejected extends Error {
  constructor(
    public code: PromotionError,
    public status: number,
  ) {
    super(code);
  }
}

const DAY = 864e5;
const PAYLOAD = /^promo:([0-9a-f-]{36})$/;

/**
 * Paid promotion for Telegram Stars (docs/plan.md, stage 18). The Mini App opens an invoice link; Telegram
 * asks the bot before charging (precheck) and reports the payment (paid) — the bot forwards both here.
 * A payment that cannot start a promotion is refunded at once.
 */
export class PromotionService {
  constructor(
    private d: {
      repo: Repo;
      payments: StarsPayments | null;
      enabled: boolean;
      prices: Record<PromoPlan, number>;
    },
  ) {}

  private get db() {
    return this.d.repo.db;
  }

  options(): PromoOptions {
    return {
      enabled: this.d.enabled && !!this.d.payments,
      plans: PROMO_PLANS.map((plan) => ({ plan, days: PROMO_DAYS[plan], stars: this.d.prices[plan] })),
    };
  }

  /** A pending promotion and its Telegram invoice link. */
  async start(user: User, listingId: string, plan: PromoPlan) {
    if (!this.options().enabled) throw new PromotionRejected("promotion_disabled", 403);
    const [l] = await this.db.select().from(listings).where(eq(listings.id, listingId));
    if (!l) throw new PromotionRejected("not_found", 404);
    if (l.sellerUserId !== user.id) throw new PromotionRejected("forbidden", 403);
    if (l.status !== "active") throw new PromotionRejected("not_active", 409);
    const lang = user.language as Lang;
    const days = PROMO_DAYS[plan];
    const stars = this.d.prices[plan];
    const [row] = await this.db.insert(promotions).values({ listingId: l.id, userId: user.id, plan, days, stars }).returning();
    const title = listingTitle(l, lang).slice(0, 32) || "Ishonch";
    const invoiceLink = await this.d.payments!.createStarsInvoice({
      title: t(lang, "promo.invoice_title", { days }),
      description: t(lang, "promo.invoice_description", { title, days }),
      payload: `promo:${row!.id}`,
      label: t(lang, "promo.invoice_title", { days }),
      stars,
    });
    await this.d.repo.event(user.id, "promotion_started", { listingId: l.id, plan, stars });
    return { promotionId: row!.id, invoiceLink, days, stars };
  }

  private async pendingFor(user: User, payload: string) {
    const id = PAYLOAD.exec(payload)?.[1];
    if (!id) return null;
    const [p] = await this.db.select().from(promotions).where(and(eq(promotions.id, id), eq(promotions.userId, user.id)));
    return p ?? null;
  }

  /** Telegram's pre_checkout_query: say no before money moves when the promotion cannot start. */
  async precheck(user: User, payload: string, currency: string, amount: number): Promise<{ ok: boolean; message?: string }> {
    const lang = user.language as Lang;
    const p = await this.pendingFor(user, payload);
    if (!p || p.status !== "pending" || currency !== "XTR" || amount !== p.stars) return { ok: false, message: t(lang, "promo.err.bad_payment") };
    const [l] = await this.db.select({ status: listings.status }).from(listings).where(eq(listings.id, p.listingId));
    if (l?.status !== "active") return { ok: false, message: t(lang, "promo.err.not_active") };
    return { ok: true };
  }

  /** Telegram's successful_payment: start the promotion, or refund. Idempotent per charge id. */
  async paid(user: User, payload: string, amount: number, chargeId: string, now = new Date()) {
    const lang = user.language as Lang;
    const [done] = await this.db.select().from(promotions).where(eq(promotions.chargeId, chargeId));
    if (done) return this.outcome(lang, done);
    const p = await this.pendingFor(user, payload);
    if (!p) throw new PromotionRejected("bad_payment", 400);
    // Claim the pending row with this charge (a parallel delivery of the same update loses here).
    const [claimed] = await this.db
      .update(promotions)
      .set({ chargeId, status: "paid" })
      .where(and(eq(promotions.id, p.id), eq(promotions.status, "pending")))
      .returning();
    if (!claimed) return this.outcome(lang, p);
    const [l] = await this.db.select().from(listings).where(eq(listings.id, p.listingId));
    if (l?.status !== "active" || amount !== p.stars) {
      await this.refundRow(claimed, user.telegramId, now);
      return { ok: false, message: t(lang, "promo.refunded") };
    }
    // A running promotion is extended, not restarted.
    const from = l.promotedUntil && l.promotedUntil > now ? l.promotedUntil : now;
    const endsAt = new Date(from.getTime() + p.days * DAY);
    await this.db.transaction(async (tx) => {
      await tx.update(promotions).set({ status: "active", startsAt: now, endsAt }).where(eq(promotions.id, p.id));
      await tx.update(listings).set({ promotedUntil: endsAt }).where(eq(listings.id, l.id));
    });
    await this.d.repo.event(user.id, "promotion_paid", { listingId: l.id, plan: p.plan, stars: p.stars });
    return { ok: true, message: t(lang, "promo.activated", { title: listingTitle(l, lang), date: endsAt.toISOString().slice(0, 10) }), endsAt: endsAt.toISOString() };
  }

  private outcome(lang: Lang, p: typeof promotions.$inferSelect) {
    return p.status === "refunded"
      ? { ok: false, message: t(lang, "promo.refunded") }
      : { ok: true, message: t(lang, "promo.already"), endsAt: p.endsAt?.toISOString() };
  }

  private async refundRow(p: typeof promotions.$inferSelect, telegramId: number, now: Date) {
    await this.d.payments!.refundStars(telegramId, p.chargeId!);
    await this.db.update(promotions).set({ status: "refunded", refundedAt: now }).where(eq(promotions.id, p.id));
  }

  /** Admin: return the stars of a paid promotion and stop it. */
  async refund(admin: User, promotionId: string, now = new Date()) {
    const [p] = await this.db.select().from(promotions).where(eq(promotions.id, promotionId));
    if (!p || !p.chargeId || p.status === "refunded") throw new PromotionRejected("not_found", 404);
    const [owner] = await this.db.select().from(users).where(eq(users.id, p.userId));
    await this.refundRow(p, owner!.telegramId, now);
    // The listing keeps the longest of its other running promotions.
    const [rest] = (await this.db.execute(sql`
      select max(ends_at) as until from ${promotions}
      where listing_id = ${p.listingId} and status = 'active' and ends_at > ${now.toISOString()}`)) as unknown as Array<{ until: string | null }>;
    await this.db
      .update(listings)
      .set({ promotedUntil: rest?.until ? new Date(rest.until) : null })
      .where(eq(listings.id, p.listingId));
    await this.d.repo.audit(admin, "promotion_refund", p.id, { stars: p.stars });
    return { ok: true };
  }

  /** Admin list: recent paid promotions with the listing title and stars. */
  async recent(limit = 50) {
    const rows = await this.db
      .select({ p: promotions, title: listings.titleRu })
      .from(promotions)
      .innerJoin(listings, eq(listings.id, promotions.listingId))
      .where(inArray(promotions.status, ["active", "refunded"]))
      .orderBy(sql`${promotions.createdAt} desc`)
      .limit(limit);
    return rows.map(({ p, title }) => ({
      id: p.id,
      listingId: p.listingId,
      title,
      plan: p.plan,
      stars: p.stars,
      status: p.status,
      endsAt: p.endsAt?.toISOString() ?? null,
      createdAt: p.createdAt.toISOString(),
    }));
  }
}
