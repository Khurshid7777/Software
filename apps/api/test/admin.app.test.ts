import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { eq, sql as dsql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AdminMetrics, OrderDto } from "@ishonch/shared";
import { buildApp } from "../src/app.js";
import { buildInitData } from "../src/auth/telegram.js";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { listings, settings } from "../src/db/schema.js";
import { tashkentClock } from "../src/jobs.js";
import { FsStorage } from "../src/storage/storage.js";
import type { ChannelPublisher, Notifier } from "../src/telegram/publisher.js";
import { mockAiByPrompt } from "./helpers.js";

const url = process.env.TEST_DATABASE_URL ?? "postgres://ishonch:ishonch@localhost:5432/ishonch";
const reachable = await postgres(url, { max: 1, connect_timeout: 2 })`select 1`
  .then(() => true)
  .catch(() => false);

const BOT_TOKEN = "123456:TEST";
const ADMIN = 940_000_001;
const OPERATOR = 940_000_002;
const SELLER = 940_000_003;
const BUYER = 940_000_004;
const ALL = [ADMIN, OPERATOR, SELLER, BUYER];

describe.skipIf(!reachable)("admin: metrics, reports, settings, digest (integration)", () => {
  let app: FastifyInstance;
  let close: () => Promise<unknown>;
  let db: ReturnType<typeof createDb>["db"];
  const dms: Array<{ chatId: number; text: string }> = [];
  const gateway: ChannelPublisher & Notifier = {
    post: async () => ({ messageId: 1 }),
    miniAppLink: async (p) => `https://t.me/ishonch_bot/app?startapp=${p}`,
    send: async (chatId, text) => void dms.push({ chatId, text }),
  };

  const tma = (id: number) => ({ authorization: `tma ${buildInitData({ id, language_code: "ru" }, BOT_TOKEN)}` });
  const internal = (id: number) => ({ authorization: "Internal internal-secret", "x-telegram-user": JSON.stringify({ id, language_code: "ru" }) });
  const userId = async (tg: number) => (await app.inject({ url: "/me", headers: tma(tg) })).json().id as string;
  const metrics = async (days = 7) => (await app.inject({ url: `/admin/metrics?days=${days}`, headers: tma(ADMIN) })).json() as AdminMetrics;
  const step = (m: AdminMetrics, name: string) => m.buyerFunnel.find((s) => s.step === name)?.users ?? -1;

  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: url,
      BOT_TOKEN,
      INTERNAL_API_TOKEN: "internal-secret",
      ADMIN_TELEGRAM_IDS: String(ADMIN),
      OPERATOR_TELEGRAM_IDS: String(OPERATOR),
      CHECKS_PER_DAY: "5",
      DIGEST_HOUR: "9",
    } as NodeJS.ProcessEnv);
    const created = createDb(url);
    db = created.db;
    close = () => created.sql.end();
    app = await buildApp({ config, db, ai: mockAiByPrompt({}), storage: new FsStorage("/tmp/ishonch-admin-test"), publisher: gateway });
    await db.execute(dsql`update listings set status = 'archived' where status in ('active', 'pending', 'reserved')`);
  });

  beforeEach(async () => {
    dms.length = 0;
    await db.execute(dsql.raw(`delete from users where telegram_id in (${ALL.join(",")})`));
  });

  afterAll(async () => {
    await db.execute(dsql.raw(`delete from users where telegram_id in (${ALL.join(",")})`));
    await db.delete(settings).where(eq(settings.key, "digest_sent_for"));
    for (const k of ["checks_per_day", "complaints_to_hide"]) await db.delete(settings).where(eq(settings.key, k));
    await app.close();
    await close();
  });

  it("is admin-only", async () => {
    for (const path of ["/admin/metrics", "/admin/reports/orders.csv", "/admin/settings", "/admin/users/banned"]) {
      expect((await app.inject({ url: path, headers: tma(BUYER) })).statusCode).toBe(403);
      expect((await app.inject({ url: path, headers: tma(OPERATOR) })).statusCode).toBe(403);
      expect((await app.inject({ url: path })).statusCode).toBe(401);
    }
  });

  it("funnels, orders and the daily series move with real activity", async () => {
    const before = await metrics();
    await app.inject({ method: "POST", url: "/me/accept-terms", headers: tma(BUYER) });
    const [l] = await db
      .insert(listings)
      .values({
        sellerUserId: await userId(SELLER),
        category: "smartphone",
        titleRu: "Метрики iPhone 13",
        titleUz: "Metrika iPhone 13",
        descriptionRu: "x",
        descriptionUz: "x",
        price: 5_000_000,
        district: "chilonzor",
        status: "active",
        publishedAt: new Date(),
        bumpedAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 864e5),
      })
      .returning();
    await app.inject({ method: "POST", url: "/internal/phone", headers: internal(BUYER), payload: { phone: "+998901110000" } });
    await app.inject({ url: "/catalog?q=iphone", headers: tma(BUYER) });
    await app.inject({ url: `/catalog/${l!.id}`, headers: tma(BUYER) });
    await app.inject({ url: `/catalog/${l!.id}`, headers: tma(SELLER) }); // own view: no event

    const o = (
      await app.inject({
        method: "POST",
        url: "/orders",
        headers: tma(BUYER),
        payload: { listingId: l!.id, mode: "cod_seller", district: "yunusobod", address: "Amir Temur 5" },
      })
    ).json() as OrderDto;
    await app.inject({ method: "POST", url: `/orders/${o.id}/confirm`, headers: tma(SELLER) });
    for (const s of ["courier_assigned", "picked_up", "delivered"]) {
      await app.inject({ method: "POST", url: `/operator/orders/${o.id}/status`, headers: tma(OPERATOR), payload: { status: s } });
    }
    await app.inject({ method: "POST", url: `/orders/${o.id}/review`, headers: tma(BUYER), payload: { rating: 5 } });

    const after = await metrics();
    for (const s of ["terms_accepted", "catalog_search", "listing_viewed", "order_created", "order_delivered", "review_created"]) {
      expect(step(after, s) - step(before, s), s).toBe(1);
    }
    expect(after.sellerFunnel.find((s) => s.step === "order_confirmed")!.users).toBeGreaterThan(
      before.sellerFunnel.find((s) => s.step === "order_confirmed")!.users,
    );
    expect(after.orders.created - before.orders.created).toBe(1);
    expect(after.orders.delivered - before.orders.delivered).toBe(1);
    expect(after.orders.gmvUzs - before.orders.gmvUzs).toBe(5_000_000);
    expect(after.orders.returnRatePct).not.toBeNull();
    expect(after.listings.soldPlatform - before.listings.soldPlatform).toBe(1);
    expect(after.users.new - before.users.new).toBe(3); // buyer, seller, operator (the admin existed before)
    const today = tashkentClock(new Date()).date;
    expect(after.daily.at(-1)!.date).toBe(today);
    expect(after.daily).toHaveLength(7);
    expect(after.daily.at(-1)!.delivered - before.daily.at(-1)!.delivered).toBe(1);
    // Conversion is relative to the previous step.
    const f = after.buyerFunnel;
    expect(f[0]!.conversionPct).toBeNull();
    if (f[1]!.users && f[2]!.users) expect(f[2]!.conversionPct).toBe(Math.round((f[2]!.users / f[1]!.users) * 100));

    // Orders CSV: BOM, header, our order with the money columns.
    const csv = await app.inject({ url: "/admin/reports/orders.csv?days=7", headers: tma(ADMIN) });
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.body.slice(1).trim().split("\n");
    expect(lines[0]).toMatch(/^order_id;created_at;status;mode;/);
    const row = lines.find((x) => x.startsWith(o.id))!.split(";");
    expect(row[2]).toBe("delivered");
    expect(row[5]).toBe("Метрики iPhone 13");
    expect(row[6]).toBe("5000000");
    expect(row.at(-1)).toBe("yes");
  });

  it("settings: defaults, validated updates that take effect, unknown keys refused", async () => {
    const s = (await app.inject({ url: "/admin/settings", headers: tma(ADMIN) })).json();
    expect(Object.keys(s).sort()).toEqual(["ai_monthly_limit_usd", "assistant_per_day", "checks_per_day", "complaints_to_hide", "listing_ai_per_day", "usd_rate"]);

    const bad = await app.inject({ method: "PUT", url: "/admin/settings", headers: tma(ADMIN), payload: { checks_per_day: 0 } });
    expect(bad.statusCode).toBe(400);
    const unknown = await app.inject({ method: "PUT", url: "/admin/settings", headers: tma(ADMIN), payload: { risk_rules: {} } });
    expect(unknown.statusCode).toBe(400);

    const ok = await app.inject({ method: "PUT", url: "/admin/settings", headers: tma(ADMIN), payload: { checks_per_day: 9, complaints_to_hide: 4 } });
    expect(ok.json()).toMatchObject({ checks_per_day: 9, complaints_to_hide: 4 });
    expect((await app.inject({ url: "/me", headers: tma(BUYER) })).json().checks.perDay).toBe(9);
  });

  it("staff can open a pending listing, buyers cannot", async () => {
    const [l] = await db
      .insert(listings)
      .values({ sellerUserId: await userId(SELLER), titleRu: "На проверке", titleUz: "Tekshiruvda", status: "pending", price: 1 })
      .returning();
    expect((await app.inject({ url: `/catalog/${l!.id}`, headers: tma(BUYER) })).statusCode).toBe(404);
    expect((await app.inject({ url: `/catalog/${l!.id}`, headers: tma(ADMIN) })).statusCode).toBe(200);
    expect((await app.inject({ url: `/catalog/${l!.id}`, headers: tma(OPERATOR) })).statusCode).toBe(200);
  });

  it("digest: once per Tashkent day, not before the configured hour", async () => {
    await db.delete(settings).where(eq(settings.key, "digest_sent_for"));
    await userId(ADMIN);
    const at = (h: number) => new Date(Date.UTC(2031, 0, 15, h - 5, 30)); // Tashkent hh:30
    expect(await app.services.digest(at(8))).toBe(false);
    expect(await app.services.digest(at(9))).toBe(true);
    expect(await app.services.digest(at(18))).toBe(false);
    const msg = dms.filter((d) => d.chatId === ADMIN).at(-1)!;
    expect(msg.text).toContain("📊 Ishonch за 14 января");
    expect(msg.text).toContain("AI:");
    expect(await app.services.digest(new Date(at(9).getTime() + 864e5))).toBe(true); // next day

    dms.length = 0;
    const manual = await app.inject({ method: "POST", url: "/admin/digest", headers: tma(ADMIN) });
    expect(manual.json().sent).toBe(1);
    expect(dms[0]!.chatId).toBe(ADMIN);
  });

  it("banned users list", async () => {
    const id = await userId(BUYER);
    await app.inject({ method: "POST", url: `/admin/users/${id}/ban`, headers: tma(ADMIN), payload: { reason: "спам" } });
    const banned = (await app.inject({ url: "/admin/users/banned", headers: tma(ADMIN) })).json() as Array<{ id: string; banReason: string }>;
    expect(banned.find((b) => b.id === id)?.banReason).toBe("спам");
  });
});
