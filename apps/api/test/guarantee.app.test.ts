import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { eq, sql as dsql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { CatalogItem, DeliveryQuote, OfferDto, OrderDto, Valuation } from "@ishonch/shared";
import { buildApp } from "../src/app.js";
import { buildInitData } from "../src/auth/telegram.js";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { listings, orders, priceReference } from "../src/db/schema.js";
import type { CourierProvider } from "../src/modules/orders/courier.js";
import { FsStorage } from "../src/storage/storage.js";
import type { ChannelPublisher, Notifier, NotifyButton } from "../src/telegram/publisher.js";
import { mockAiByPrompt } from "./helpers.js";

const url = process.env.TEST_DATABASE_URL ?? "postgres://ishonch:ishonch@localhost:5432/ishonch";
const reachable = await postgres(url, { max: 1, connect_timeout: 2 })`select 1`
  .then(() => true)
  .catch(() => false);

const BOT_TOKEN = "123456:TEST";
const SELLER = 990_100_001;
const BUYER = 990_100_002;
const OPERATOR = 990_100_003;
const ADMIN = 990_100_004;
const ALL = [SELLER, BUYER, OPERATOR, ADMIN];
const MODERATORS = -100_990_100;
// A model of our own, so the price reference of other tests and seeds does not matter.
const MODEL = "testbrand phone x7 128gb";

describe.skipIf(!reachable)("guarantee disputes, valuation, trade-in offers (integration)", () => {
  let app: FastifyInstance;
  let close: () => Promise<unknown>;
  let db: ReturnType<typeof createDb>["db"];
  let storageDir: string;
  const dms: Array<{ chatId: number; text: string; buttons: NotifyButton[][] }> = [];

  const ai = mockAiByPrompt({ listing_moderate: { decision: "approved", reasons: [], seller_message_ru: "", seller_message_uz: "" } });
  const gateway: ChannelPublisher & Notifier = {
    post: async () => ({ messageId: 1 }),
    miniAppLink: async (p) => `https://t.me/ishonch_bot/app?startapp=${p}`,
    send: async (chatId, text, buttons = []) => void dms.push({ chatId, text, buttons }),
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

  /** Request → seller confirms → courier → delivered; returns the order id. */
  async function deliveredOrder(listingId: string) {
    const o = (await post(BUYER, "/orders", { listingId, mode: "cod_seller", district: "yunusobod", address: "Amir Temur 1" })).json() as OrderDto;
    await app.inject({ method: "POST", url: `/orders/${o.id}/confirm`, headers: internal(SELLER) });
    for (const status of ["courier_assigned", "picked_up", "delivered"]) {
      await app.inject({ method: "POST", url: `/operator/orders/${o.id}/status`, headers: internal(OPERATOR), payload: { status } });
    }
    return o.id;
  }

  beforeAll(async () => {
    storageDir = mkdtempSync(join(tmpdir(), "ishonch-guarantee-"));
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: url,
      BOT_TOKEN,
      INTERNAL_API_TOKEN: "internal-secret",
      OPERATOR_TELEGRAM_IDS: String(OPERATOR),
      ADMIN_TELEGRAM_IDS: String(ADMIN),
      MODERATION_CHAT_ID: String(MODERATORS),
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
    await db.execute(dsql.raw(`delete from users where telegram_id in (${ALL.join(",")})`));
    for (const tg of [SELLER, BUYER]) {
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

  // ---------------- valuation ----------------

  it("valuation: reference price by condition, recent sales, live count and monthly history", async () => {
    await liveListing({ status: "sold", soldAt: new Date(), price: 2_400_000 });
    await liveListing({ status: "sold", soldAt: new Date(), price: 2_600_000 });
    await liveListing({ price: 2_900_000 });

    const good = await get<Valuation>(BUYER, `/valuation?q=${encodeURIComponent("Testbrand Phone X7 128 ГБ")}&condition=good`);
    expect(good).toMatchObject({ modelKey: MODEL, source: "reference", range: { median: 2_500_000 }, sold: { count: 2, median: 2_500_000 }, live: 1 });
    expect(good.estimate).toMatchObject({ market: 2_500_000, max: 3_000_000 });
    expect(good.history.at(-1)).toMatchObject({ month: new Date().toISOString().slice(0, 7), n: 3 });

    const fair = await get<Valuation>(BUYER, `/valuation?q=${encodeURIComponent("testbrand phone x7 128gb")}&condition=fair`);
    expect(fair.range!.median).toBe(2_130_000); // 85 % of the reference, rounded to 10 000

    const unknown = await get<Valuation>(BUYER, "/valuation?q=nonexistent%20gadget%20zz9");
    expect(unknown).toMatchObject({ source: "none", range: null, estimate: null });
    expect((await app.inject({ url: "/valuation?q=x" })).statusCode).toBe(400);
    // Works without a Telegram session too (a shared link to the tool).
    expect((await app.inject({ url: `/valuation?q=${encodeURIComponent(MODEL)}` })).statusCode).toBe(200);
    expect((await get<{ models: string[] }>(BUYER, "/valuation/models?q=testbrand x7")).models).toContain(MODEL);
  });

  // ---------------- trade-in ----------------

  it("trade-in: only when the seller accepts trades; our estimate of the buyer's item; bot buttons; price checkout unaffected", async () => {
    const l = await liveListing();
    const offer = { title: "Testbrand Phone X7 128 ГБ", condition: "good", description: "звоните +998 90 111 22 33", topUp: 500_000 };
    expect((await post(BUYER, `/listings/${l.id}/trade-offers`, offer)).json().error).toBe("trade_not_accepted");

    const patched = await app.inject({ method: "PATCH", url: `/listings/${l.id}`, headers: tma(SELLER), payload: { acceptsTrade: true } });
    expect(patched.json().acceptsTrade).toBe(true);
    expect((await post(BUYER, `/listings/${l.id}/trade-offers`, { ...offer, topUp: 9_000_000 })).json().error).toBe("trade_topup_too_big");
    expect((await post(SELLER, `/listings/${l.id}/trade-offers`, offer)).statusCode).toBe(409);

    const res = await post(BUYER, `/listings/${l.id}/trade-offers`, offer);
    expect(res.statusCode).toBe(200);
    const made = res.json() as OfferDto;
    expect(made).toMatchObject({ kind: "trade", amount: 500_000, status: "pending", trade: { condition: "good", modelKey: MODEL, estimate: 2_500_000 } });
    expect(made.trade!.description).not.toContain("111 22 33"); // contacts are scrubbed
    expect((await post(BUYER, `/listings/${l.id}/trade-offers`, offer)).json().error).toBe("offer_pending");

    const toSeller = dmsTo(SELLER).at(-1)!;
    expect(toSeller.text).toContain("Предложение обмена");
    expect(toSeller.text).toContain("≈ 2 500 000");
    expect(toSeller.text).toContain("Доплата от покупателя: 500 000");
    expect(callbacks(toSeller)).toContain(`offer:accept:${made.id}`);

    expect((await post(SELLER, `/offers/${made.id}/accept`)).json()).toMatchObject({ status: "accepted", kind: "trade" });
    expect(dmsTo(BUYER).at(-1)!.text).toContain("согласен на обмен");
    expect((await get<{ offer: OfferDto }>(BUYER, `/listings/${l.id}/offers/mine`)).offer.kind).toBe("trade");
    // An accepted exchange is not a discount: delivery is still quoted at the asking price.
    const quote = await get<DeliveryQuote>(BUYER, `/orders/quote?listingId=${l.id}&district=chilonzor&mode=cod_seller`);
    expect(quote.itemPrice).toBe(4_000_000);
  });

  // ---------------- guarantee ----------------

  it("guarantee: the buyer disputes within the window, the seller answers, an admin decides; the seller's trust drops", async () => {
    const l = await liveListing({ titleRu: "Testbrand X7 с гарантией" });
    const id = await deliveredOrder(l.id);
    const view = await get<OrderDto>(BUYER, `/orders/${id}`);
    expect(view.status).toBe("delivered");
    expect(view.actions).toContain("dispute");
    expect(new Date(view.guaranteeUntil!).getTime()).toBeGreaterThan(Date.now() + 2.9 * 864e5);

    const body = { reason: "hidden_defect", text: "Через день перестал работать Face ID, пишите @scammer" };
    expect((await post(SELLER, `/orders/${id}/dispute`, body)).statusCode).toBe(403);
    expect((await post(BUYER, `/orders/${id}/dispute`, { reason: "hidden_defect", text: "плохо" })).statusCode).toBe(400);
    const opened = (await post(BUYER, `/orders/${id}/dispute`, body)).json() as OrderDto;
    expect(opened.dispute).toMatchObject({ status: "open", reason: "hidden_defect" });
    expect(opened.dispute!.text).not.toContain("@scammer");
    expect(opened.actions).not.toContain("dispute");
    expect((await post(BUYER, `/orders/${id}/dispute`, body)).json().error).toBe("dispute_exists");
    expect(dmsTo(SELLER).at(-1)!.text).toContain("открыл спор");
    expect(dmsTo(MODERATORS).at(-1)!.text).toContain("Спор покупателя");

    expect((await get<OrderDto>(SELLER, `/orders/${id}`)).actions).toContain("dispute_response");
    expect((await post(SELLER, `/orders/${id}/dispute/response`, { text: "При передаче всё работало, курьер проверил" })).statusCode).toBe(200);
    expect((await post(SELLER, `/orders/${id}/dispute/response`, { text: "Ещё раз" })).statusCode).toBe(409);
    expect((await get<OrderDto>(SELLER, `/orders/${id}`)).dispute!.sellerResponse).toContain("курьер проверил");

    expect((await app.inject({ url: "/admin/disputes", headers: tma(BUYER) })).statusCode).toBe(403);
    const queue = (await get<Array<{ id: string; orderId: string; itemPrice: number; sellerResponse: string }>>(ADMIN, "/admin/disputes")).find(
      (d) => d.orderId === id,
    )!;
    expect(queue).toMatchObject({ itemPrice: 4_000_000 });
    expect((await post(ADMIN, `/admin/disputes/${queue.id}/resolve`, { resolution: "partial" })).statusCode).toBe(400);
    expect((await post(ADMIN, `/admin/disputes/${queue.id}/resolve`, { resolution: "partial", amount: 4_000_000 })).json().error).toBe("bad_amount");
    const resolved = await post(ADMIN, `/admin/disputes/${queue.id}/resolve`, { resolution: "partial", amount: 300_000, note: "Компенсация за ремонт" });
    expect(resolved.json()).toMatchObject({ status: "resolved", resolution: "partial", amount: 300_000 });
    expect((await post(ADMIN, `/admin/disputes/${queue.id}/resolve`, { resolution: "rejected" })).statusCode).toBe(409);
    expect(dmsTo(BUYER).at(-1)!.text).toContain("часть суммы — 300 000");
    expect(dmsTo(SELLER).at(-1)!.text).toContain("Решение по спору");

    // A lost dispute shows on the seller's card and keeps them out of "high" trust.
    const other = await liveListing();
    const item = await get<CatalogItem>(BUYER, `/catalog/${other.id}`);
    expect(item.listing.seller!.disputesLost).toBe(1);
    expect(item.trust).not.toBe("high");
  });

  it("guarantee: no dispute after the window or before delivery", async () => {
    const l = await liveListing();
    const id = await deliveredOrder(l.id);
    await db.update(orders).set({ deliveredAt: new Date(Date.now() - 4 * 864e5) }).where(eq(orders.id, id));
    expect((await get<OrderDto>(BUYER, `/orders/${id}`)).actions).not.toContain("dispute");
    const late = await post(BUYER, `/orders/${id}/dispute`, { reason: "not_working", text: "Не включается совсем, проверьте" });
    expect(late.json()).toMatchObject({ error: "guarantee_expired" });
    expect(late.json().message).toContain("3 дн");

    const fresh = await liveListing();
    const o = (await post(BUYER, "/orders", { listingId: fresh.id, mode: "cod_seller", district: "yunusobod", address: "Amir Temur 1" })).json() as OrderDto;
    expect((await post(BUYER, `/orders/${o.id}/dispute`, { reason: "not_working", text: "Не включается совсем, проверьте" })).statusCode).toBe(409);
  });
});
