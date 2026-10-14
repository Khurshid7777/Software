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
import { aiUsage, checks, events, priceReference, settings, users, type User } from "./schema.js";
import type { AiUsageRecord } from "../ai/aiService.js";

/** Tashkent is UTC+5 with no DST; "today" for limits is a Tashkent calendar day. */
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
    const [row] = await this.db
      .insert(users)
      .values({ telegramId: tg.id, language: normalizeLang(tg.language_code), ...(role ? { role } : {}) })
      .onConflictDoUpdate({
        target: users.telegramId,
        // Language is chosen once from Telegram, then only changed explicitly by the user.
        set: role ? { role } : { telegramId: sql`excluded.telegram_id` },
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

  async acceptTerms(userId: string) {
    await this.db.update(users).set({ acceptedTermsAt: new Date() }).where(eq(users.id, userId));
  }

  /** Right to erasure: checks keep only anonymised data and are detached (user_id -> null). */
  async deleteUser(userId: string) {
    await this.db.delete(users).where(eq(users.id, userId));
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
    const key = normalizeModelKey(modelKey);
    const rows = await this.db
      .select({
        modelKey: priceReference.modelKey,
        min: priceReference.priceMin,
        median: priceReference.priceMedian,
        max: priceReference.priceMax,
      })
      .from(priceReference)
      .where(sql`similarity(${priceReference.modelKey}, ${key}) >= 0.4`)
      .orderBy(desc(sql`similarity(${priceReference.modelKey}, ${key})`))
      .limit(5);
    const row = rows.find((r) => sameModel(r.modelKey, key));
    return row ? { min: row.min, median: row.median, max: row.max } : null;
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

  // ---- analytics ----
  async event(userId: string | null, name: string, props: Record<string, unknown> = {}) {
    await this.db.insert(events).values({ userId, name, props });
  }
}
