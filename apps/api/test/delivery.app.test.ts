import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { eq, sql as dsql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { CatalogItem, CatalogPage, DeliveryQuote, ListingDto, ListingModeration, OrderDto } from "@ishonch/shared";
import { buildApp } from "../src/app.js";
import { buildInitData } from "../src/auth/telegram.js";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { complaints, listings, users } from "../src/db/schema.js";
import type { CourierProvider, ShipmentRequest } from "../src/modules/orders/courier.js";
import { FsStorage } from "../src/storage/storage.js";
import type { ChannelPost, ChannelPublisher, Notifier, NotifyButton } from "../src/telegram/publisher.js";
import { listingFixtures, mockAiByPrompt, testPhoto } from "./helpers.js";

const url = process.env.TEST_DATABASE_URL ?? "postgres://ishonch:ishonch@localhost:5432/ishonch";
const reachable = await postgres(url, { max: 1, connect_timeout: 2 })`select 1`
  .then(() => true)
  .catch(() => false);

const BOT_TOKEN = "123456:TEST";
const SELLER = 930_000_001;
const BUYER = 930_000_002;
const BUYER2 = 930_000_003;
const OPERATOR = 930_000_004;
const ADMIN = 930_000_005;
const SELLER2 = 930_000_006;
const C1 = 930_000_007;
const C2 = 930_000_008;
const C3 = 930_000_009;
const ALL = [SELLER, BUYER, BUYER2, OPERATOR, ADMIN, SELLER2, C1, C2, C3];
const MODERATION_CHAT = -100_777;

function multipart(parts: Array<{ name: string; value: string | Buffer; filename?: string; type?: string }>) {
  const boundary = "----ishonch-test";
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const head = p.filename
      ? `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\nContent-Type: ${p.type}\r\n\r\n`
      : `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"\r\n\r\n`;
    chunks.push(Buffer.from(head), Buffer.isBuffer(p.value) ? p.value : Buffer.from(p.value), Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

const approved: ListingModeration = { decision: "approved", reasons: [], seller_message_ru: "", seller_message_uz: "" };

describe.skipIf(!reachable)("delivery, moderation, complaints, expiry, bans (integration)", () => {
  let app: FastifyInstance;
  let close: () => Promise<unknown>;
  let db: ReturnType<typeof createDb>["db"];
  let storageDir: string;
  const dms: Array<{ chatId: number; text: string; buttons: NotifyButton[][] }> = [];
  const posts: Array<{ channelId: number; post: ChannelPost }> = [];
  const shipments: ShipmentRequest[] = [];
  let moderationMock: ListingModeration | (() => never) = approved;

  const fx = listingFixtures.find((f) => f.name === "samsung_a54_photo_only_ru")!;
  const ai = mockAiByPrompt({
    listing_analyze: fx.mock_analysis,
    listing_generate: fx.mock_text,
    listing_moderate: () => (typeof moderationMock === "function" ? moderationMock() : moderationMock),
  });
  const gateway: ChannelPublisher & Notifier = {
    post: async (channelId, post) => (posts.push({ channelId, post }), { messageId: posts.length }),
    miniAppLink: async (p) => `https://t.me/ishonch_bot/app?startapp=${p}`,
    send: async (chatId, text, buttons = []) => void dms.push({ chatId, text, buttons }),
  };
  const courier: CourierProvider = {
    name: "manual",
    createShipment: async (req) => (shipments.push(req), { externalId: null }),
    cancelShipment: async () => undefined,
  };

  const tma = (id: number, lang = "ru") => ({ authorization: `tma ${buildInitData({ id, language_code: lang }, BOT_TOKEN)}` });
  const internal = (id: number) => ({
    authorization: "Internal internal-secret",
    "x-telegram-user": JSON.stringify({ id, language_code: "ru" }),
  });
  const userId = async (tg: number) => (await app.inject({ url: "/me", headers: tma(tg) })).json().id as string;
  const setPhone = (tg: number, phone: string) => app.inject({ method: "POST", url: "/internal/phone", headers: internal(tg), payload: { phone } });
  const dmsTo = (tg: number) => dms.filter((d) => d.chatId === tg);
  const callbacks = (d: { buttons: NotifyButton[][] }) => d.buttons.flat().map((b) => ("callbackData" in b ? b.callbackData : b.url));

  /** A live listing inserted directly (order tests don't need the AI draft flow). */
  async function liveListing(seller: number, extra: Partial<typeof listings.$inferInsert> = {}) {
    const [row] = await db
      .insert(listings)
      .values({
        sellerUserId: await userId(seller),
        category: "smartphone",
        titleRu: "Samsung Galaxy A54 256 ГБ",
        titleUz: "Samsung Galaxy A54 256 GB",
        descriptionRu: "Хорошее состояние",
        descriptionUz: "Yaxshi holatda",
        attributes: { modelKey: "samsung galaxy a54 256gb", specs: [] },
        condition: "good",
        price: 3_000_000,
        district: "chilonzor",
        allowedDeliveryModes: ["delivery_only", "cod_seller"],
        feePayer: "split",
        status: "active",
        publishedAt: new Date(),
        bumpedAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 864e5),
        ...extra,
      })
      .returning();
    return row!;
  }

  async function publishable(seller: number, photoSeeds: number[]) {
    const parts = [];
    for (const s of photoSeeds) parts.push({ name: "photos", value: await testPhoto(s), filename: `p${s}.jpg`, type: "image/jpeg" });
    parts.push({ name: "text", value: "Samsung A54" });
    const body = multipart(parts);
    const draft = (
      await app.inject({ method: "POST", url: "/listings/drafts", headers: { ...tma(seller), "content-type": body.contentType }, payload: body.payload })
    ).json() as ListingDto;
    await app.inject({ method: "POST", url: `/listings/${draft.id}/generate`, headers: tma(seller), payload: { answers: { storage: "256 ГБ" } } });
    return draft.id;
  }

  const order = (who: number, body: Record<string, unknown>) => app.inject({ method: "POST", url: "/orders", headers: tma(who), payload: body });
  const opStatus = (who: number, id: string, status: string, extra: Record<string, unknown> = {}) =>
    app.inject({ method: "POST", url: `/operator/orders/${id}/status`, headers: internal(who), payload: { status, ...extra } });
  const listingStatus = async (id: string) => (await db.select().from(listings).where(eq(listings.id, id)))[0]!.status;

  beforeAll(async () => {
    storageDir = mkdtempSync(join(tmpdir(), "ishonch-delivery-"));
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: url,
      BOT_TOKEN,
      INTERNAL_API_TOKEN: "internal-secret",
      ADMIN_TELEGRAM_IDS: String(ADMIN),
      OPERATOR_TELEGRAM_IDS: String(OPERATOR),
      MODERATION_CHAT_ID: String(MODERATION_CHAT),
    } as NodeJS.ProcessEnv);
    const created = createDb(url);
    db = created.db;
    close = () => created.sql.end();
    app = await buildApp({ config, db, ai, storage: new FsStorage(storageDir), publisher: gateway, courier });
    await app.services.orders.replaceTariffs([
      { name: "default", fromDistrict: null, toDistrict: null, price: 30_000, codFeePct: 1, active: true },
      { name: "sergeli", fromDistrict: null, toDistrict: "sergeli", price: 40_000, codFeePct: 1, active: true },
      { name: "chilonzor inside", fromDistrict: "chilonzor", toDistrict: "chilonzor", price: 20_000, codFeePct: 1, active: true },
    ]);
  });

  beforeEach(async () => {
    dms.length = 0;
    posts.length = 0;
    shipments.length = 0;
    moderationMock = approved;
    await db.execute(dsql.raw(`delete from users where telegram_id in (${ALL.join(",")})`));
    for (const tg of [SELLER, BUYER, BUYER2, SELLER2]) await setPhone(tg, `+99890${String(tg).slice(-7)}`);
  });

  afterAll(async () => {
    await db.execute(dsql.raw(`delete from users where telegram_id in (${ALL.join(",")})`));
    await app.close();
    await close();
    rmSync(storageDir, { recursive: true, force: true });
  });

  // ---------------- delivery ----------------

  it("quote: the most specific tariff, COD fee and the fee split", async () => {
    const l = await liveListing(SELLER);
    const q = async (district: string, mode: string) =>
      (await app.inject({ url: `/orders/quote?listingId=${l.id}&district=${district}&mode=${mode}`, headers: tma(BUYER) })).json() as DeliveryQuote;

    const local = await q("chilonzor", "cod_seller");
    expect(local.deliveryFee).toBe(20_000);
    expect(local.codFee).toBe(30_000); // 1% of 3 000 000
    expect(local.buyerFee + local.sellerFee).toBe(50_000);
    expect(local.sellerFee).toBe(25_000); // split
    expect(local.buyerTotal).toBe(3_025_000);
    expect(local.sellerReceives).toBe(2_975_000);

    expect((await q("sergeli", "delivery_only")).deliveryFee).toBe(40_000);
    expect((await q("sergeli", "delivery_only")).codFee).toBe(0);
    expect((await q("yunusobod", "cod_seller")).deliveryFee).toBe(30_000);

    const off = await app.inject({ url: `/orders/quote?listingId=${l.id}&district=yunusobod&mode=cod_platform`, headers: tma(BUYER) });
    expect(off.statusCode).toBe(400);
  });

  it("full flow: request → seller confirms (listing reserved, rival request closed) → operator → delivered → review", async () => {
    const l = await liveListing(SELLER);
    await db.update(users).set({ phone: null }).where(eq(users.telegramId, BUYER));
    const body = { listingId: l.id, mode: "cod_seller", district: "yunusobod", address: "Amir Temur 1, kv 5", comment: "после 18:00" };

    const noPhone = await order(BUYER, body);
    expect(noPhone.statusCode).toBe(409);
    expect(noPhone.json().error).toBe("phone_required");
    await setPhone(BUYER, "+998901112233");
    expect((await order(SELLER, body)).json().error).toBe("own_listing");

    const created = await order(BUYER, body);
    expect(created.statusCode).toBe(200);
    const o = created.json() as OrderDto;
    expect(o.status).toBe("new");
    expect(o.role).toBe("buyer");
    expect(o.address).toBe("Amir Temur 1, kv 5");
    expect(o.actions).toEqual(["cancel"]);
    expect((await order(BUYER, body)).json().error).toBe("already_ordered");

    // Seller gets a DM with confirm / decline buttons; the buyer's phone and address are not in it.
    const sellerDm = dmsTo(SELLER).at(-1)!;
    expect(sellerDm.text).toContain("Новая заявка");
    expect(sellerDm.text).not.toContain("+99890");
    expect(sellerDm.text).not.toContain("Amir Temur");
    expect(callbacks(sellerDm)).toContain(`order:confirm:${o.id}`);
    expect((await db.select().from(listings).where(eq(listings.id, l.id)))[0]!.requestsCount).toBe(1);

    // The seller's view hides the address.
    const sellerView = (await app.inject({ url: `/orders/${o.id}`, headers: tma(SELLER) })).json() as OrderDto;
    expect(sellerView.address).toBeNull();
    expect(sellerView.actions).toEqual(["confirm", "decline"]);
    expect((await app.inject({ url: `/orders/${o.id}`, headers: tma(BUYER2) })).statusCode).toBe(404);

    // A rival request, then the seller confirms the first one through the bot (Internal auth).
    const rival = (await order(BUYER2, { ...body, district: "sergeli" })).json() as OrderDto;
    dms.length = 0;
    const confirmed = await app.inject({ method: "POST", url: `/orders/${o.id}/confirm`, headers: internal(SELLER) });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().status).toBe("confirmed");
    expect(await listingStatus(l.id)).toBe("reserved");
    const rivalNow = (await app.inject({ url: `/orders/${rival.id}`, headers: tma(BUYER2) })).json() as OrderDto;
    expect(rivalNow.status).toBe("cancelled");
    expect(rivalNow.cancelReason).toBe("reserved_by_other");
    expect(dmsTo(BUYER2).at(-1)!.text).toContain("забронирован другим");
    expect(dmsTo(BUYER).at(-1)!.text).toContain("подтвердил");

    // Operators get the card with phones, the address and the cash to collect.
    expect(shipments).toHaveLength(1);
    expect(shipments[0]!.collectUzs).toBe(3_030_000); // default tariff 30k + 1% COD 30k, split
    const card = dmsTo(OPERATOR).at(-1)!;
    expect(card.text).toContain("+998901112233");
    expect(card.text).toContain("Amir Temur 1");
    expect(card.text).toContain("3 030 000");
    expect(callbacks(card)).toEqual([`op:courier_assigned:${o.id}`, `op:cancelled:${o.id}`]);
    expect(dmsTo(ADMIN).length).toBeGreaterThan(0); // admins also act as operators without a group chat

    // Reserved: gone from the catalog, nobody else can order or message.
    const page = (await app.inject({ url: "/catalog?q=a54" })).json() as CatalogPage;
    expect(page.items.map((i) => i.listing.id)).not.toContain(l.id);
    const card2 = (await app.inject({ url: `/catalog/${l.id}`, headers: tma(BUYER2) })).json() as CatalogItem;
    expect(card2.listing.status).toBe("reserved");
    expect((await order(BUYER2, body)).json().error).toBe("not_available");

    // Only operators move the delivery; wrong steps are refused.
    expect((await opStatus(BUYER, o.id, "courier_assigned")).statusCode).toBe(403);
    expect((await opStatus(OPERATOR, o.id, "delivered")).json().error).toBe("bad_state");
    const assigned = await opStatus(OPERATOR, o.id, "courier_assigned", { courierName: "Jasur" });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json().card.buttons.flat().map((b: { callbackData: string }) => b.callbackData)).toEqual([
      `op:picked_up:${o.id}`,
      `op:cancelled:${o.id}`,
    ]);
    expect(dmsTo(BUYER).at(-1)!.text).toContain("Курьер: Jasur");
    expect((await app.inject({ method: "POST", url: `/orders/${o.id}/cancel`, headers: tma(BUYER) })).json().error).toBe("bad_state");

    // Review before delivery is refused.
    const early = await app.inject({ method: "POST", url: `/orders/${o.id}/review`, headers: tma(BUYER), payload: { rating: 5 } });
    expect(early.json().error).toBe("bad_state");

    await opStatus(OPERATOR, o.id, "picked_up");
    const delivered = await opStatus(OPERATOR, o.id, "delivered");
    expect(delivered.json().order.status).toBe("delivered");
    expect(delivered.json().card.buttons).toEqual([]);
    const [sold] = await db.select().from(listings).where(eq(listings.id, l.id));
    expect(sold!.status).toBe("sold");
    expect(sold!.soldVia).toBe("platform");
    expect(dmsTo(BUYER).at(-1)!.text).toContain("оцените продавца");

    const history = ((await app.inject({ url: `/orders/${o.id}`, headers: tma(BUYER) })).json() as OrderDto).history.map((h) => h.status);
    expect(history).toEqual(["new", "confirmed", "courier_assigned", "picked_up", "delivered"]);

    // Review: once, PII scrubbed, shown on the seller card and in the trust level.
    const review = await app.inject({
      method: "POST",
      url: `/orders/${o.id}/review`,
      headers: tma(BUYER),
      payload: { rating: 4, text: "Всё честно, звоните +998 90 123 45 67" },
    });
    expect(review.statusCode).toBe(200);
    expect((review.json() as OrderDto).review?.text).toContain("[phone]");
    expect(dmsTo(SELLER).at(-1)!.text).toContain("⭐⭐⭐⭐");
    const again = await app.inject({ method: "POST", url: `/orders/${o.id}/review`, headers: tma(BUYER), payload: { rating: 1 } });
    expect(again.json().error).toBe("review_exists");

    const reviews = (await app.inject({ url: `/sellers/${await userId(SELLER)}/reviews` })).json();
    expect(reviews.rating).toEqual({ avg: 4, count: 1 });
    const l2 = await liveListing(SELLER, { titleRu: "Другой телефон" });
    const view = (await app.inject({ url: `/catalog/${l2.id}`, headers: tma(BUYER2) })).json() as CatalogItem;
    expect(view.listing.seller?.rating).toEqual({ avg: 4, count: 1 });
    expect(view.listing.seller?.platformSales).toBe(1);

    const mine = (await app.inject({ url: "/orders/mine?role=seller", headers: tma(SELLER) })).json() as OrderDto[];
    expect(mine.map((m) => m.id)).toContain(o.id);
  });

  it("refusal at inspection returns the item to sale; a buyer cancel after confirmation too", async () => {
    const l = await liveListing(SELLER);
    const body = { listingId: l.id, mode: "delivery_only", district: "sergeli", address: "Sergeli 7, uy 12" };
    const o = (await order(BUYER, body)).json() as OrderDto;
    await app.inject({ method: "POST", url: `/orders/${o.id}/confirm`, headers: tma(SELLER) });
    expect(shipments.at(-1)!.collectUzs).toBe(0); // delivery only: no cash
    await opStatus(OPERATOR, o.id, "courier_assigned");
    await opStatus(OPERATOR, o.id, "picked_up");
    const returned = await opStatus(OPERATOR, o.id, "returned");
    expect(returned.json().order.status).toBe("returned");
    expect(await listingStatus(l.id)).toBe("active");
    expect(dmsTo(SELLER).at(-1)!.text).toContain("возвращается продавцу");

    const o2 = (await order(BUYER2, body)).json() as OrderDto;
    await app.inject({ method: "POST", url: `/orders/${o2.id}/confirm`, headers: tma(SELLER) });
    expect(await listingStatus(l.id)).toBe("reserved");
    const cancelled = await app.inject({ method: "POST", url: `/orders/${o2.id}/cancel`, headers: tma(BUYER2) });
    expect((cancelled.json() as OrderDto).status).toBe("cancelled");
    expect(await listingStatus(l.id)).toBe("active");
    expect(dmsTo(SELLER).at(-1)!.text).toContain("Покупатель отменил");

    // Seller declines a new request.
    const o3 = (await order(BUYER, body)).json() as OrderDto;
    const declined = await app.inject({ method: "POST", url: `/orders/${o3.id}/decline`, headers: internal(SELLER) });
    expect((declined.json() as OrderDto).status).toBe("cancelled");
    expect(dmsTo(BUYER).at(-1)!.text).toContain("не подтвердил");
  });

  it("listing modes are respected and open orders are limited", async () => {
    const l = await liveListing(SELLER, { allowedDeliveryModes: ["delivery_only"] });
    const bad = await order(BUYER, { listingId: l.id, mode: "cod_seller", district: "chilonzor", address: "Chilonzor 1" });
    expect(bad.json().error).toBe("mode_not_allowed");
    for (let i = 0; i < 5; i++) {
      const li = await liveListing(SELLER2, { titleRu: `Телефон ${i}` });
      expect((await order(BUYER, { listingId: li.id, mode: "delivery_only", district: "chilonzor", address: "Chilonzor 1" })).statusCode).toBe(200);
    }
    const sixth = await order(BUYER, { listingId: l.id, mode: "delivery_only", district: "chilonzor", address: "Chilonzor 1" });
    expect(sixth.json().error).toBe("open_orders_limit");
  });

  // ---------------- moderation at publication ----------------

  it("publication: contact info refused, AI rejection, review queue → admin approval posts to channels", async () => {
    // Contact info typed by the seller blocks publication before any AI call.
    const a = await publishable(SELLER, [11]);
    await app.inject({ method: "PATCH", url: `/listings/${a}`, headers: tma(SELLER), payload: { descriptionRu: "Звоните 90 123 45 67" } });
    const withPhone = await app.inject({ method: "POST", url: `/listings/${a}/publish`, headers: tma(SELLER), payload: {} });
    expect(withPhone.json().error).toBe("contact_info");

    // AI rejects: the listing is rejected with the AI's advice for the seller.
    moderationMock = {
      decision: "rejected",
      reasons: [{ code: "prohibited_item", note: "Оружие" }],
      seller_message_ru: "Оружие продавать нельзя.",
      seller_message_uz: "Qurol sotish mumkin emas.",
    };
    const b = await publishable(SELLER, [12]);
    const rejected = await app.inject({ method: "POST", url: `/listings/${b}/publish`, headers: tma(SELLER), payload: {} });
    expect(rejected.json().moderation).toBe("rejected");
    expect(rejected.json().listing.status).toBe("rejected");
    expect(rejected.json().listing.moderation).toEqual({ reason: "prohibited_item", message: "Оружие продавать нельзя." });
    const moderateCall = ai.calls.filter((c) => c.promptId === "listing_moderate").at(-1)!;
    expect((moderateCall.content as Array<{ type: string }>).map((c) => c.type)).toEqual(["image", "text"]);
    const pendingTab = (await app.inject({ url: "/listings/mine?status=pending", headers: tma(SELLER) })).json() as ListingDto[];
    expect(pendingTab.map((x) => x.id)).toContain(b);

    // Needs review: pending, moderators' chat gets approve/reject buttons; nothing posted yet.
    moderationMock = { decision: "needs_review", reasons: [{ code: "misleading", note: "Цена в 4 раза ниже" }], seller_message_ru: "", seller_message_uz: "" };
    await app.inject({ method: "POST", url: "/internal/channels", headers: internal(SELLER), payload: { telegramChannelId: -100_500, title: "Shop" } });
    const channelId = ((await app.inject({ url: "/shops/mine", headers: tma(SELLER) })).json().channels[0] as { id: number }).id;
    const c = await publishable(SELLER, [13]);
    const pending = await app.inject({ method: "POST", url: `/listings/${c}/publish`, headers: tma(SELLER), payload: { channelIds: [channelId] } });
    expect(pending.json().moderation).toBe("needs_review");
    expect(await listingStatus(c)).toBe("pending");
    expect(posts).toHaveLength(0);
    const modMsg = dmsTo(MODERATION_CHAT).at(-1)!;
    expect(modMsg.text).toContain("misleading");
    expect(callbacks(modMsg)).toContain(`mod:approve:${c}`);
    expect((await app.inject({ url: `/catalog/${c}`, headers: tma(BUYER) })).statusCode).toBe(404);

    const queue = (await app.inject({ url: "/admin/moderation", headers: tma(ADMIN) })).json() as Array<{ listing: ListingDto }>;
    expect(queue.map((q) => q.listing.id)).toContain(c);
    expect((await app.inject({ method: "POST", url: `/admin/listings/${c}/moderate`, headers: internal(SELLER), payload: { decision: "approve" } })).statusCode).toBe(403);

    const ok = await app.inject({ method: "POST", url: `/admin/listings/${c}/moderate`, headers: internal(ADMIN), payload: { decision: "approve" } });
    expect(ok.json().status).toBe("active");
    expect(await listingStatus(c)).toBe("active");
    expect(posts.map((p) => p.channelId)).toEqual([-100_500]); // the channels chosen at publication
    expect(dmsTo(SELLER).at(-1)!.text).toContain("проверено и опубликовано");
  });

  it("duplicates: own photos → bump instead; another seller's photos → moderators", async () => {
    const first = await publishable(SELLER, [21, 22]);
    expect((await app.inject({ method: "POST", url: `/listings/${first}/publish`, headers: tma(SELLER), payload: {} })).json().listing.status).toBe("active");

    const same = await publishable(SELLER, [22]);
    const dup = await app.inject({ method: "POST", url: `/listings/${same}/publish`, headers: tma(SELLER), payload: {} });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ error: "duplicate", params: { id: first } });

    const stolen = await publishable(SELLER2, [21]);
    const res = await app.inject({ method: "POST", url: `/listings/${stolen}/publish`, headers: tma(SELLER2), payload: {} });
    expect(res.json().moderation).toBe("needs_review");
    const [row] = await db.select().from(listings).where(eq(listings.id, stolen));
    expect(row!.moderationReason).toBe("duplicate_photos");
    expect((row!.moderation as { duplicates: string[] }).duplicates).toContain(first);

    const fresh = await publishable(SELLER2, [23]);
    await app.inject({
      method: "PATCH",
      url: `/listings/${fresh}`,
      headers: tma(SELLER2),
      payload: { descriptionRu: "Другой телефон, своё описание продавца без копирования чужого текста.", descriptionUz: "Boshqa telefon." },
    });
    expect((await app.inject({ method: "POST", url: `/listings/${fresh}/publish`, headers: tma(SELLER2), payload: {} })).json().moderation).toBe(
      "approved",
    );
  });

  it("AI outage never blocks publication", async () => {
    moderationMock = () => {
      throw new Error("overloaded");
    };
    const id = await publishable(SELLER, [31]);
    const res = await app.inject({ method: "POST", url: `/listings/${id}/publish`, headers: tma(SELLER), payload: {} });
    expect(res.json().listing.status).toBe("active");
  });

  // ---------------- complaints ----------------

  it("three distinct complaints hide a listing until a moderator decides", async () => {
    const l = await liveListing(SELLER);
    const complain = (tg: number, reason = "scam") =>
      app.inject({ method: "POST", url: `/listings/${l.id}/complaints`, headers: tma(tg), payload: { reason, text: "пишите @scammer" } });

    expect((await complain(SELLER)).json().error).toBe("own_listing");
    expect((await complain(C1)).json()).toMatchObject({ ok: true, hidden: false });
    expect((await complain(C1)).json()).toMatchObject({ duplicate: true });
    expect((await complain(C2, "wrong_info")).json().hidden).toBe(false);
    expect((await complain(C3)).json().hidden).toBe(true);
    expect(await listingStatus(l.id)).toBe("pending");
    expect(dmsTo(SELLER).at(-1)!.text).toContain("временно скрыто");
    expect(dmsTo(MODERATION_CHAT).at(-1)!.text).toContain("scam ×2");
    const stored = await db.select().from(complaints).where(eq(complaints.listingId, l.id));
    expect(stored.every((c) => !c.text?.includes("@scammer"))).toBe(true);

    const rej = await app.inject({ method: "POST", url: `/admin/listings/${l.id}/moderate`, headers: tma(ADMIN), payload: { decision: "reject", reason: "misleading" } });
    expect(rej.json().status).toBe("rejected");
    expect(await listingStatus(l.id)).toBe("rejected");
    const open = (await app.inject({ url: "/admin/complaints", headers: tma(ADMIN) })).json() as Array<{ listingId: string }>;
    expect(open.map((c) => c.listingId)).not.toContain(l.id);
    expect(dmsTo(SELLER).at(-1)!.text).toContain("не прошло модерацию");

    // Seller-side view explains the reason.
    const mine = (await app.inject({ url: "/listings/mine?status=pending", headers: tma(SELLER) })).json() as ListingDto[];
    expect(mine.find((x) => x.id === l.id)?.moderation?.reason).toBe("misleading");
  });

  // ---------------- expiry ----------------

  it("expiry: reminder with a renew button, auto-archive, renew from the bot", async () => {
    const soon = await liveListing(SELLER, { expiresAt: new Date(Date.now() + 2 * 864e5) });
    const gone = await liveListing(SELLER, { titleRu: "Старое", expiresAt: new Date(Date.now() - 3600_000) });
    const later = await liveListing(SELLER, { titleRu: "Свежее" });

    const r = await app.services.listings.runExpiry();
    expect(r.reminded).toBeGreaterThanOrEqual(1);
    expect(r.archived).toBeGreaterThanOrEqual(1);
    const reminder = dmsTo(SELLER).find((d) => callbacks(d).includes(`renew:${soon.id}`) && d.text.includes("будет снято"));
    expect(reminder).toBeTruthy();
    expect(dmsTo(SELLER).some((d) => d.text.includes("истёк") && callbacks(d).includes(`renew:${gone.id}`))).toBe(true);
    expect(dmsTo(SELLER).some((d) => callbacks(d).includes(`renew:${later.id}`))).toBe(false);
    expect(await listingStatus(gone.id)).toBe("archived");

    // Second run: no duplicate reminders.
    dms.length = 0;
    await app.services.listings.runExpiry();
    expect(dmsTo(SELLER).some((d) => callbacks(d).includes(`renew:${soon.id}`))).toBe(false);

    const renewed = await app.inject({ method: "POST", url: `/listings/${gone.id}/renew`, headers: internal(SELLER) });
    expect(renewed.statusCode).toBe(200);
    expect((renewed.json() as ListingDto).status).toBe("active");
    expect(new Date((renewed.json() as ListingDto).expiresAt!).getTime()).toBeGreaterThan(Date.now() + 29 * 864e5);
    expect((await app.inject({ method: "POST", url: `/listings/${later.id}/renew`, headers: tma(BUYER) })).statusCode).toBe(403);
  });

  // ---------------- bans ----------------

  it("ban: listings hidden, open orders cancelled, API access refused; unban", async () => {
    const l = await liveListing(SELLER);
    const o = (await order(BUYER, { listingId: l.id, mode: "cod_seller", district: "chilonzor", address: "Chilonzor 5" })).json() as OrderDto;
    await app.inject({ method: "POST", url: `/orders/${o.id}/confirm`, headers: tma(SELLER) });
    const sellerId = await userId(SELLER);

    expect((await app.inject({ method: "POST", url: `/admin/users/${sellerId}/ban`, headers: tma(BUYER), payload: { reason: "scam" } })).statusCode).toBe(403);
    const found = (await app.inject({ url: `/admin/users?telegramId=${SELLER}`, headers: tma(ADMIN) })).json();
    expect(found.id).toBe(sellerId);

    const ban = await app.inject({ method: "POST", url: `/admin/users/${sellerId}/ban`, headers: tma(ADMIN), payload: { reason: "мошенничество" } });
    expect(ban.json()).toMatchObject({ ok: true, hiddenListings: 1 });
    expect(await listingStatus(l.id)).toBe("archived");
    expect(((await app.inject({ url: `/orders/${o.id}`, headers: tma(BUYER) })).json() as OrderDto).status).toBe("cancelled");
    expect(dmsTo(BUYER).at(-1)!.text).toContain("заблокирован");
    expect((await app.inject({ url: "/me", headers: tma(SELLER) })).statusCode).toBe(403);

    const adminId = await userId(ADMIN);
    expect((await app.inject({ method: "POST", url: `/admin/users/${adminId}/ban`, headers: tma(ADMIN), payload: { reason: "self" } })).statusCode).toBe(403);

    await app.inject({ method: "POST", url: `/admin/users/${sellerId}/unban`, headers: tma(ADMIN) });
    expect((await app.inject({ url: "/me", headers: tma(SELLER) })).statusCode).toBe(200);
  });

  it("tariffs are admin-only", async () => {
    expect((await app.inject({ url: "/admin/tariffs", headers: tma(BUYER) })).statusCode).toBe(403);
    expect((await app.inject({ url: "/admin/tariffs", headers: tma(ADMIN) })).json()).toHaveLength(3);
    const bad = await app.inject({ method: "PUT", url: "/admin/tariffs", headers: tma(ADMIN), payload: [{ name: "x", price: -1 }] });
    expect(bad.statusCode).toBe(400);
    expect((await app.inject({ url: "/operator/orders", headers: tma(OPERATOR) })).statusCode).toBe(200);
  });
});
