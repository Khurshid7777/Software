import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { eq, sql as dsql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { CatalogPage, ListingDto, PromoOptions } from "@ishonch/shared";
import { buildApp } from "../src/app.js";
import { buildInitData } from "../src/auth/telegram.js";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { listings, priceReference, promotions } from "../src/db/schema.js";
import type { CourierProvider } from "../src/modules/orders/courier.js";
import { FsStorage } from "../src/storage/storage.js";
import type { ChannelPublisher, Notifier, NotifyButton, StarsPayments } from "../src/telegram/publisher.js";
import { mockAiByPrompt } from "./helpers.js";

const url = process.env.TEST_DATABASE_URL ?? "postgres://ishonch:ishonch@localhost:5432/ishonch";
const reachable = await postgres(url, { max: 1, connect_timeout: 2 })`select 1`
  .then(() => true)
  .catch(() => false);

const BOT_TOKEN = "123456:TEST";
const SELLER = 990_180_001;
const BUYER = 990_180_002;
const OPERATOR = 990_180_003;
const ADMIN = 990_180_004;
const LIKER = 990_180_005;
const ALL = [SELLER, BUYER, OPERATOR, ADMIN, LIKER];
const MODERATORS = -100_990_180;
// A model of our own, so the price reference of other tests and seeds does not matter.
const MODEL = "testbrand phone x18 128gb";

describe.skipIf(!reachable)("paid promotion for Telegram Stars (integration)", () => {
  let app: FastifyInstance;
  let close: () => Promise<unknown>;
  let db: ReturnType<typeof createDb>["db"];
  let storageDir: string;
  const dms: Array<{ chatId: number; text: string; buttons: NotifyButton[][] }> = [];
  const invoices: Array<{ payload: string; stars: number; title: string }> = [];
  const refunds: Array<{ telegramUserId: number; chargeId: string }> = [];

  const ai = mockAiByPrompt({ listing_moderate: { decision: "approved", reasons: [], seller_message_ru: "", seller_message_uz: "" } });
  const gateway: ChannelPublisher & Notifier & StarsPayments = {
    post: async () => ({ messageId: 1 }),
    miniAppLink: async (p) => `https://t.me/ishonch_bot/app?startapp=${p}`,
    send: async (chatId, text, buttons = []) => void dms.push({ chatId, text, buttons }),
    createStarsInvoice: async (i) => {
      invoices.push(i);
      return `https://t.me/$invoice-${invoices.length}`;
    },
    refundStars: async (telegramUserId, chargeId) => void refunds.push({ telegramUserId, chargeId }),
  };
  const courier: CourierProvider = { name: "manual", createShipment: async () => ({ externalId: null }), cancelShipment: async () => undefined };

  const tma = (id: number) => ({ authorization: `tma ${buildInitData({ id, language_code: "ru" }, BOT_TOKEN)}` });
  const internal = (id: number) => ({ authorization: "Internal internal-secret", "x-telegram-user": JSON.stringify({ id, language_code: "ru" }) });
  const userId = async (tg: number) => (await app.inject({ url: "/me", headers: tma(tg) })).json().id as string;
  const dmsTo = (chat: number) => dms.filter((d) => d.chatId === chat);
  const callbacks = (d: { buttons: NotifyButton[][] }) => d.buttons.flat().map((b) => ("callbackData" in b ? b.callbackData : b.url));
  const post = (who: number, path: string, payload: object = {}) => app.inject({ method: "POST", url: path, headers: tma(who), payload });
  const get = async <T>(who: number, path: string) => (await app.inject({ url: path, headers: tma(who) })).json() as T;

  async function liveListing(extra: Partial<typeof listings.$inferInsert> = {}) {
    const [row] = await db
      .insert(listings)
      .values({
        sellerUserId: await userId(SELLER),
        category: "smartphone",
        titleRu: "Testbrand X7 128 ГБ",
        titleUz: "Testbrand X7 128 GB",
        descriptionRu: "Рабочий",
        descriptionUz: "Ishlaydi",
        attributes: { modelKey: MODEL, specs: [] },
        condition: "good",
        price: 4_000_000,
        district: "chilonzor",
        allowedDeliveryModes: ["delivery_only", "cod_seller"],
        feePayer: "buyer",
        status: "active",
        publishedAt: new Date(),
        bumpedAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 864e5),
        ...extra,
      })
      .returning();
    return row!;
  }

  beforeAll(async () => {
    storageDir = mkdtempSync(join(tmpdir(), "ishonch-promo-"));
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: url,
      BOT_TOKEN,
      INTERNAL_API_TOKEN: "internal-secret",
      OPERATOR_TELEGRAM_IDS: String(OPERATOR),
      ADMIN_TELEGRAM_IDS: String(ADMIN),
      MODERATION_CHAT_ID: String(MODERATORS),
      PROMOTION_ENABLED: "true",
      PROMO_STARS_3D: "50",
      PROMO_STARS_7D: "100",
    } as NodeJS.ProcessEnv);
    const created = createDb(url);
    db = created.db;
    close = () => created.sql.end();
    app = await buildApp({ config, db, ai, storage: new FsStorage(storageDir), publisher: gateway, courier });
    await db.execute(dsql`update listings set status = 'archived' where status in ('active', 'pending', 'reserved')`);
    await app.services.orders.replaceTariffs([
      { name: "default", vehicle: "courier", fromDistrict: null, toDistrict: null, price: 30_000, codFeePct: 1, liftPerFloor: 0, active: true },
    ]);
    await db
      .insert(priceReference)
      .values({ modelKey: MODEL, priceMin: 2_000_000, priceMedian: 2_500_000, priceMax: 3_000_000, source: "test" })
      .onConflictDoUpdate({ target: priceReference.modelKey, set: { priceMin: 2_000_000, priceMedian: 2_500_000, priceMax: 3_000_000 } });
  });

  beforeEach(async () => {
    dms.length = 0;
    invoices.length = 0;
    refunds.length = 0;
    await db.execute(dsql.raw(`delete from users where telegram_id in (${ALL.join(",")})`));
    for (const tg of [SELLER, BUYER, LIKER]) {
      await app.inject({ method: "POST", url: "/internal/phone", headers: internal(tg), payload: { phone: `+99890${String(tg).slice(-7)}` } });
    }
  });

  afterAll(async () => {
    await db.execute(dsql.raw(`delete from users where telegram_id in (${ALL.join(",")})`));
    await db.delete(priceReference).where(eq(priceReference.modelKey, MODEL));
    await app.close();
    await close();
    rmSync(storageDir, { recursive: true, force: true });
  });

  const patch = (who: number, id: string, payload: object) => app.inject({ method: "PATCH", url: `/listings/${id}`, headers: tma(who), payload });
  const like = async (id: string, ...who: number[]) => {
    for (const w of who) await app.inject({ method: "POST", url: `/favorites/${id}`, headers: tma(w) });
  };

  // ---------------- offer to likers ----------------

  const pay = (who: number, payload: string, amount: number, chargeId: string) =>
    app.inject({ method: "POST", url: "/internal/payments/paid", headers: internal(who), payload: { payload, currency: "XTR", amount, chargeId } });
  const precheck = async (who: number, payload: string, amount: number) =>
    (await app.inject({ method: "POST", url: "/internal/payments/precheck", headers: internal(who), payload: { payload, currency: "XTR", amount } })).json() as {
      ok: boolean;
      message?: string;
    };
  const promote = (who: number, id: string, plan: string) => post(who, `/listings/${id}/promote`, { plan });

  it("options, invoice, pre-checkout, payment → the listing is promoted; a repeated update never counts twice", async () => {
    expect(await get<PromoOptions>(BUYER, "/promotion/options")).toEqual({
      enabled: true,
      plans: [
        { plan: "3d", days: 3, stars: 50 },
        { plan: "7d", days: 7, stars: 100 },
      ],
    });
    const l = await liveListing();
    expect((await promote(BUYER, l.id, "3d")).statusCode).toBe(403);
    expect((await promote(SELLER, l.id, "30d")).statusCode).toBe(400);
    const res = await promote(SELLER, l.id, "3d");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ days: 3, stars: 50, invoiceLink: "https://t.me/$invoice-1" });
    const payload = invoices[0]!.payload;
    expect(payload).toBe(`promo:${res.json().promotionId}`);
    expect(invoices[0]!.stars).toBe(50);

    // Telegram asks before charging: wrong amount, someone else's invoice, or a bad payload say no.
    expect(await precheck(SELLER, payload, 10)).toMatchObject({ ok: false });
    expect(await precheck(BUYER, payload, 50)).toMatchObject({ ok: false });
    expect(await precheck(SELLER, "promo:x", 50)).toMatchObject({ ok: false });
    expect(await precheck(SELLER, payload, 50)).toEqual({ ok: true });

    const paid = await pay(SELLER, payload, 50, "charge-1");
    expect(paid.json()).toMatchObject({ ok: true });
    expect(paid.json().message).toContain("Продвижение включено");
    const [row] = await db.select().from(listings).where(eq(listings.id, l.id));
    const until = row!.promotedUntil!.getTime();
    expect(until - Date.now()).toBeGreaterThan(2.99 * 864e5);
    // The same update again: acknowledged, not extended, not charged twice.
    expect((await pay(SELLER, payload, 50, "charge-1")).json().message).toContain("уже учтён");
    expect((await db.select().from(listings).where(eq(listings.id, l.id)))[0]!.promotedUntil!.getTime()).toBe(until);
    // The invoice cannot be paid a second time with another charge.
    expect(await precheck(SELLER, payload, 50)).toMatchObject({ ok: false });

    // The owner sees the end date; a second purchase extends from it.
    const mine = (await get<ListingDto[]>(SELLER, "/listings/mine?status=active")).find((x) => x.id === l.id)!;
    expect(new Date(mine.promotedUntil!).getTime()).toBe(until);
    const again = await promote(SELLER, l.id, "7d");
    await pay(SELLER, `promo:${again.json().promotionId}`, 100, "charge-2");
    const [after] = await db.select().from(listings).where(eq(listings.id, l.id));
    expect(after!.promotedUntil!.getTime() - until).toBe(7 * 864e5);
    expect(refunds).toEqual([]);
  });

  it("the promoted block: at most 2, first page only, not with a price sort, not repeated from the page", async () => {
    const promotedIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const l = await liveListing({ bumpedAt: new Date(Date.now() - 30 * 864e5), promotedUntil: new Date(Date.now() + 864e5) });
      promotedIds.push(l.id);
    }
    // 20 fresher listings fill the first page.
    for (let i = 0; i < 20; i++) await liveListing({ bumpedAt: new Date(Date.now() - i * 1000) });
    const page = await get<CatalogPage>(BUYER, "/catalog");
    expect(page.items).toHaveLength(20);
    expect(page.promoted).toHaveLength(2);
    for (const p of page.promoted!) expect(promotedIds).toContain(p.listing.id);
    expect(page.items.some((i) => promotedIds.includes(i.listing.id))).toBe(false);

    expect((await get<CatalogPage>(BUYER, "/catalog?sort=price_asc")).promoted).toBeUndefined();
    expect((await get<CatalogPage>(BUYER, `/catalog?offset=20`)).promoted).toBeUndefined();
    // An expired promotion is not shown; a hidden listing neither.
    await db.update(listings).set({ promotedUntil: new Date(Date.now() - 1000) }).where(eq(listings.id, promotedIds[0]!));
    await db.update(listings).set({ status: "archived" }).where(eq(listings.id, promotedIds[1]!));
    expect((await get<CatalogPage>(BUYER, "/catalog")).promoted!.map((p) => p.listing.id)).toEqual([promotedIds[2]]);
    await db.execute(dsql`update listings set status = 'archived' where status = 'active'`);
  });

  it("refunds: automatic when the listing is gone by payment time; by an admin later", async () => {
    const l = await liveListing();
    const p1 = (await promote(SELLER, l.id, "3d")).json();
    // Sold meanwhile: Telegram already charged, so the stars go back at once.
    await db.update(listings).set({ status: "sold" }).where(eq(listings.id, l.id));
    expect(await precheck(SELLER, `promo:${p1.promotionId}`, 50)).toMatchObject({ ok: false });
    const res = await pay(SELLER, `promo:${p1.promotionId}`, 50, "charge-r1");
    expect(res.json()).toMatchObject({ ok: false });
    expect(res.json().message).toContain("возвращены");
    expect(refunds).toEqual([{ telegramUserId: SELLER, chargeId: "charge-r1" }]);
    expect((await db.select().from(promotions).where(eq(promotions.id, p1.promotionId)))[0]!.status).toBe("refunded");
    expect((await pay(SELLER, `promo:${p1.promotionId}`, 50, "charge-r1")).json()).toMatchObject({ ok: false });
    expect(refunds).toHaveLength(1);

    const l2 = await liveListing();
    const p2 = (await promote(SELLER, l2.id, "7d")).json();
    await pay(SELLER, `promo:${p2.promotionId}`, 100, "charge-r2");
    const list = await get<Array<{ id: string; status: string }>>(ADMIN, "/admin/promotions");
    expect(list.find((x) => x.id === p2.promotionId)).toMatchObject({ status: "active" });
    expect((await post(SELLER, `/admin/promotions/${p2.promotionId}/refund`)).statusCode).toBe(403);
    expect((await post(ADMIN, `/admin/promotions/${p2.promotionId}/refund`)).json()).toEqual({ ok: true });
    expect(refunds.at(-1)).toEqual({ telegramUserId: SELLER, chargeId: "charge-r2" });
    expect((await db.select().from(listings).where(eq(listings.id, l2.id)))[0]!.promotedUntil).toBeNull();
    expect((await post(ADMIN, `/admin/promotions/${p2.promotionId}/refund`)).statusCode).toBe(404);
  });

  it("only active listings; payments refused for unknown users' payloads", async () => {
    const l = await liveListing({ status: "pending" });
    expect((await promote(SELLER, l.id, "3d")).json().error).toBe("not_active");
    expect((await pay(SELLER, "promo:00000000-0000-0000-0000-000000000000", 50, "charge-x")).statusCode).toBe(400);
  });
});
