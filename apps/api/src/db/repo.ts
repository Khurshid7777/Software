import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  DEFAULT_RISK_RULES,
  RiskRulesSchema,
  normalizeLang,
  normalizeModelKey,
  sameModel,
  type Lang,
  type MarketRange,
  type Role,
  type RiskRules,
} from "@ishonch/shared";
import type { Db } from "./client.js";
import { adminAudit, aiBudget, aiUsage, checks, events, priceReference, settings, users, type User } from "./schema.js";
import type { AiUsageRecord } from "../ai/aiService.js";

/** Tashkent is UTC+5 with no DST; "today" for limits is a Tashkent calendar day. */
/** Retention periods (days) for personal data; see Repo.runRetention and the privacy policy. */
export const RETENTION = { orderPiiDays: 90, chatDays: 365, eventsDays: 400 } as const;

export function startOfTashkentDay(now = new Date()): Date {
  const shifted = new Date(now.getTime() + 5 * 3600_000);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - 5 * 3600_000);
}

export function startOfMonthUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export class Repo {
  private settingsCache = new Map<string, { value: unknown; at: number }>();

  constructor(
    readonly db: Db,
    private adminTelegramIds: number[] = [],
    private operatorTelegramIds: number[] = [],
  ) {}

  // ---- users ----
  async upsertTelegramUser(tg: { id: number; language_code?: string }): Promise<User> {
    const role: Role | undefined = this.adminTelegramIds.includes(tg.id)
      ? "admin"
      : this.operatorTelegramIds.includes(tg.id)
        ? "operator"
        : undefined;
    // Every authenticated request lands here: read first and write only for a new user or a role change
    // (an upsert per request would lock and rewrite the row each time).
    const [existing] = await this.db.select().from(users).where(eq(users.telegramId, tg.id));
    if (existing && (role ? existing.role === role : existing.role !== "admin" && existing.role !== "operator")) return existing;
    const [row] = await this.db
      .insert(users)
      .values({ telegramId: tg.id, language: normalizeLang(tg.language_code), ...(role ? { role } : {}) })
      .onConflictDoUpdate({
        target: users.telegramId,
        // Language is chosen once from Telegram, then only changed explicitly by the user.
        // Staff roles follow the env lists: an id removed from ADMIN/OPERATOR_TELEGRAM_IDS loses the role.
        set: role
          ? { role }
          : { role: sql`case when ${users.role} in ('admin', 'operator') then 'buyer' else ${users.role} end` },
      })
      .returning();
    return row!;
  }

  async setLanguage(userId: string, lang: Lang) {
    await this.db.update(users).set({ language: lang }).where(eq(users.id, userId));
  }

  async setPhone(userId: string, phone: string) {
    await this.db.update(users).set({ phone }).where(eq(users.id, userId));
  }

  /**
   * Orders in progress, a delivery still inside the dispute window, or an open dispute: deleting the
   * account then would erase the other side's record (and let a seller escape a dispute).
   */
  async hasOpenOrders(userId: string, disputeDays: number) {
    const rows = await this.db.execute(sql`
      select 1 from orders where (buyer_user_id = ${userId} or seller_user_id = ${userId})
        and (status in ('new', 'confirmed', 'courier_assigned', 'picked_up')
          or (status = 'delivered' and delivered_at > now() - make_interval(days => ${disputeDays})))
      union all
      select 1 from disputes where (buyer_user_id = ${userId} or seller_user_id = ${userId}) and status = 'open'
      limit 1`);
    return (rows as unknown as unknown[]).length > 0;
  }

  /** Adds or removes an optional notification type from users.notify_off; returns the new list. */
  async setNotify(userId: string, type: string, on: boolean) {
    const [row] = await this.db
      .update(users)
      .set({
        notifyOff: on
          ? sql`array_remove(${users.notifyOff}, ${type})`
          : sql`case when ${type} = any(${users.notifyOff}) then ${users.notifyOff} else array_append(${users.notifyOff}, ${type}) end`,
      })
      .where(eq(users.id, userId))
      .returning({ notifyOff: users.notifyOff });
    return row?.notifyOff ?? [];
  }

  async acceptTerms(userId: string) {
    await this.db.update(users).set({ acceptedTermsAt: new Date() }).where(eq(users.id, userId));
  }

  /**
   * Right to erasure without erasing the other side's history. The user's orders, disputes and the reviews
   * about them, and the listings those refer to, move to an anonymous "deleted account" placeholder (no
   * Telegram id, no phone, banned so it never shows up); everything else of the user is deleted. Files are
   * removed before (ListingService.purgeUserFiles), so the kept listings lose their photo rows too.
   */
  async deleteUser(userId: string) {
    await this.db.transaction(async (tx) => {
      const [ghost] = await tx
        .insert(users)
        .values({
          // A unique negative id that no Telegram account can have.
          telegramId: -(Date.now() * 1000 + Math.floor(Math.random() * 1000)),
          language: "ru",
          role: "deleted",
          bannedAt: new Date(),
          banReason: "account_deleted",
        })
        .returning({ id: users.id });
      const g = ghost!.id;
      await tx.execute(sql`
        update listings set seller_user_id = ${g},
          status = case when status in ('active', 'pending', 'reserved', 'draft', 'rejected') then 'archived' else status end
        where seller_user_id = ${userId}
          and (exists (select 1 from orders o where o.listing_id = listings.id)
            or exists (select 1 from disputes d where d.listing_id = listings.id))`);
      await tx.execute(sql`
        delete from listing_photos where listing_id in (select id from listings where seller_user_id = ${g})`);
      await tx.execute(sql`update orders set buyer_user_id = ${g} where buyer_user_id = ${userId}`);
      await tx.execute(sql`update orders set seller_user_id = ${g} where seller_user_id = ${userId}`);
      await tx.execute(sql`update disputes set buyer_user_id = ${g} where buyer_user_id = ${userId}`);
      await tx.execute(sql`update disputes set seller_user_id = ${g} where seller_user_id = ${userId}`);
      await tx.execute(sql`update reviews set seller_user_id = ${g} where seller_user_id = ${userId}`);
      await tx.delete(users).where(eq(users.id, userId));
    });
  }

  /**
   * Personal data is kept only as long as it is needed (privacy policy): the delivery address, comment and
   * courier phone of orders closed more than ORDER_PII_DAYS ago, chat messages older than CHAT_DAYS, and raw
   * analytics events older than EVENTS_DAYS. Orders themselves stay (sales, reviews, disputes refer to them).
   */
  async runRetention(now = new Date()) {
    const DAY = 864e5;
    const orders = (await this.db.execute(sql`
      update orders set address = '', comment = null, courier_phone = null
      where address <> '' and status not in ('new', 'confirmed', 'courier_assigned', 'picked_up')
        and updated_at < ${new Date(now.getTime() - RETENTION.orderPiiDays * DAY).toISOString()}
        and not exists (select 1 from disputes d where d.order_id = orders.id and d.status = 'open')
      returning id`)) as unknown as unknown[];
    const messages = (await this.db.execute(sql`
      delete from conversation_messages where created_at < ${new Date(now.getTime() - RETENTION.chatDays * DAY).toISOString()}
      returning id`)) as unknown as unknown[];
    const events = (await this.db.execute(sql`
      delete from events where created_at < ${new Date(now.getTime() - RETENTION.eventsDays * DAY).toISOString()}
      returning id`)) as unknown as unknown[];
    return { orders: orders.length, messages: messages.length, events: events.length };
  }

  // ---- settings ----
  async getSetting<T>(key: string, fallback: T): Promise<T> {
    const hit = this.settingsCache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.value as T;
    const [row] = await this.db.select().from(settings).where(eq(settings.key, key));
    const value = (row?.value as T) ?? fallback;
    this.settingsCache.set(key, { value, at: Date.now() });
    return value;
  }

  async setSetting(key: string, value: unknown) {
    await this.db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
    this.settingsCache.delete(key);
  }

  async riskRules(): Promise<RiskRules> {
    const parsed = RiskRulesSchema.safeParse(await this.getSetting("risk_rules", DEFAULT_RISK_RULES));
    return parsed.success ? parsed.data : DEFAULT_RISK_RULES;
  }

  // ---- ai usage ----
  async recordAiUsage(u: AiUsageRecord) {
    await this.db.insert(aiUsage).values(u);
  }

  /** Running monthly counter (UTC month), by model tier. */
  async aiBudget(now = new Date()): Promise<{ fast: number; strong: number }> {
    const rows = await this.db.select().from(aiBudget).where(eq(aiBudget.month, now.toISOString().slice(0, 7)));
    const out = { fast: 0, strong: 0 };
    for (const r of rows) if (r.tier === "fast" || r.tier === "strong") out[r.tier] = Number(r.spentUsd);
    return out;
  }

  async addAiSpend(tier: "fast" | "strong", usd: number, now = new Date()) {
    await this.db
      .insert(aiBudget)
      .values({ month: now.toISOString().slice(0, 7), tier, spentUsd: usd, calls: 1 })
      .onConflictDoUpdate({
        target: [aiBudget.month, aiBudget.tier],
        set: { spentUsd: sql`${aiBudget.spentUsd} + ${usd}`, calls: sql`${aiBudget.calls} + 1` },
      });
  }

  async aiSpendSince(since: Date): Promise<number> {
    const [row] = await this.db
      .select({ total: sql<string>`coalesce(sum(${aiUsage.costUsd}), 0)` })
      .from(aiUsage)
      .where(gte(aiUsage.createdAt, since));
    return Number(row?.total ?? 0);
  }

  // ---- price reference ----
  /**
   * Fuzzy lookup (pg_trgm) that tolerates word order, colours and typos,
   * but requires the same model numbers / storage (13 vs 13, 128 vs 128).
   */
  async findReferencePrice(modelKey: string): Promise<MarketRange | null> {
    const row = await this.findReferenceRow(modelKey);
    return row ? { min: row.min, median: row.median, max: row.max } : null;
  }

  /** The reference row of the same model (trigram candidates, then the same numbers and modifiers). */
  async findReferenceRow(modelKey: string): Promise<(MarketRange & { modelKey: string }) | null> {
    const key = normalizeModelKey(modelKey);
    const rows = await this.db
      .select({
        modelKey: priceReference.modelKey,
        min: priceReference.priceMin,
        median: priceReference.priceMedian,
        max: priceReference.priceMax,
      })
      .from(priceReference)
      .where(sql`${priceReference.modelKey} % ${key}`)
      .orderBy(desc(sql`similarity(${priceReference.modelKey}, ${key})`))
      .limit(5);
    return rows.find((r) => sameModel(r.modelKey, key)) ?? null;
  }

  /** Model names from the price reference for an autocomplete (prefix words first, then similar). */
  async suggestModels(query: string, limit = 8): Promise<string[]> {
    const key = normalizeModelKey(query);
    if (key.length < 2) return [];
    const rows = await this.db
      .select({ modelKey: priceReference.modelKey })
      .from(priceReference)
      .where(sql`${priceReference.modelKey} ilike ${`%${key.replace(/[%_\\]/g, "")}%`} or ${priceReference.modelKey} % ${key}`)
      .orderBy(desc(sql`similarity(${priceReference.modelKey}, ${key})`))
      .limit(limit);
    return rows.map((r) => r.modelKey);
  }

  listPriceReference() {
    return this.db.select().from(priceReference).orderBy(priceReference.modelKey);
  }

  async upsertPriceReference(rows: Array<{ modelKey: string; priceMin: number; priceMedian: number; priceMax: number; categoryId?: number | null; source?: string }>) {
    for (const r of rows) {
      const values = {
        ...r,
        modelKey: r.modelKey.toLowerCase().trim(),
        priceMin: Math.round(r.priceMin),
        priceMedian: Math.round(r.priceMedian),
        priceMax: Math.round(r.priceMax),
        source: r.source ?? "manual",
        updatedAt: new Date(),
      };
      await this.db
        .insert(priceReference)
        .values(values)
        .onConflictDoUpdate({
          target: priceReference.modelKey,
          set: { priceMin: values.priceMin, priceMedian: values.priceMedian, priceMax: values.priceMax, source: values.source, updatedAt: values.updatedAt },
        });
    }
  }

  async deletePriceReference(id: number) {
    await this.db.delete(priceReference).where(eq(priceReference.id, id));
  }

  // ---- checks ----
  async countChecksToday(userId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(checks)
      .where(and(eq(checks.userId, userId), gte(checks.createdAt, startOfTashkentDay())));
    return row?.n ?? 0;
  }

  async insertCheck(values: typeof checks.$inferInsert) {
    const [row] = await this.db.insert(checks).values(values).returning({ id: checks.id, createdAt: checks.createdAt });
    return row!;
  }

  async getCheck(id: string) {
    const [row] = await this.db.select().from(checks).where(eq(checks.id, id));
    return row ?? null;
  }

  // ---- per-user daily quotas (paid AI calls) ----
  /**
   * Reserves one unit of a daily quota BEFORE the expensive call: insert, then count. Parallel requests
   * cannot all slip through (at the boundary some may be refused, never over-admitted).
   * Returns the reservation id (to refund on our own failures) or null when the quota is used up.
   */
  async reserveDaily(userId: string, quota: string, limit: number): Promise<number | null> {
    const [row] = await this.db.insert(events).values({ userId, name: quota }).returning({ id: events.id });
    const used = await this.usedToday(userId, quota);
    if (used > limit) {
      await this.db.delete(events).where(eq(events.id, row!.id));
      return null;
    }
    return row!.id;
  }

  async usedToday(userId: string, quota: string): Promise<number> {
    const [r] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(events)
      .where(and(eq(events.userId, userId), eq(events.name, quota), gte(events.createdAt, startOfTashkentDay())));
    return r?.n ?? 0;
  }

  /** Gives a reservation back (the AI was unavailable — not the user's fault). */
  async refundDaily(reservationId: number | null) {
    if (reservationId != null) await this.db.delete(events).where(eq(events.id, reservationId));
  }

  // ---- staff audit log ----
  async audit(actor: Pick<User, "id" | "telegramId"> | null, action: string, target?: string | null, details: Record<string, unknown> = {}) {
    await this.db.insert(adminAudit).values({
      actorUserId: actor?.id ?? null,
      actorTelegramId: actor?.telegramId ?? null,
      action,
      target: target ?? null,
      details,
    });
  }

  listAudit(limit = 200) {
    return this.db.select().from(adminAudit).orderBy(desc(adminAudit.id)).limit(Math.min(limit, 1000));
  }

  // ---- analytics ----
  async event(userId: string | null, name: string, props: Record<string, unknown> = {}) {
    await this.db.insert(events).values({ userId, name, props });
  }
}
