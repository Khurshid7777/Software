import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { eq, sql as dsql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { BundleQuote, CatalogItem, DeliveryQuote, ListingDto, OrderDto } from "@ishonch/shared";
import { buildApp } from "../src/app.js";
import { buildInitData } from "../src/auth/telegram.js";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { complaints, conversations, listingPhotos, listings, orders, reviews } from "../src/db/schema.js";
import sharp from "sharp";
import type { CourierProvider, ShipmentRequest } from "../src/modules/orders/courier.js";
import { FsStorage } from "../src/storage/storage.js";
import type { ChannelPublisher, Notifier, NotifyButton } from "../src/telegram/publisher.js";
import { mockAiByPrompt } from "./helpers.js";

const url = process.env.TEST_DATABASE_URL ?? "postgres://ishonch:ishonch@localhost:5432/ishonch";
const reachable = await postgres(url, { max: 1, connect_timeout: 2 })`select 1`
  .then(() => true)
  .catch(() => false);

const BOT_TOKEN = "123456:TEST";
const SELLER = 950_000_001;
const BUYER = 950_000_002;
const SELLER2 = 950_000_003;
const OPERATOR = 950_000_004;
const ALL = [SELLER, BUYER, SELLER2, OPERATOR];

describe.skipIf(!reachable)("reviews reminder, share, checklist, inspection, reply drafts, bundles (integration)", () => {
  let app: FastifyInstance;
  let close: () => Promise<unknown>;
  let db: ReturnType<typeof createDb>["db"];
  let storageDir: string;
  const dms: Array<{ chatId: number; text: string; buttons: NotifyButton[][] }> = [];
  const shipments: ShipmentRequest[] = [];
  let replies: string[] = ["Да, в продаже.", "Звоните +998 90 123 45 67", "Цена окончательная."];

  const ai = mockAiByPrompt({
    listing_moderate: { decision: "approved", reasons: [], seller_message_ru: "", seller_message_uz: "" },
    chat_suggest: () => ({ replies }),
  });
  const gateway: ChannelPublisher & Notifier = {
    post: async () => ({ messageId: 1 }),
    miniAppLink: async (p) => `https://t.me/ishonch_bot/app?startapp=${p}`,
    send: async (chatId, text, buttons = []) => void dms.push({ chatId, text, buttons }),
  };
  const courier: CourierProvider = {
    name: "manual",
    createShipment: async (req) => (shipments.push(req), { externalId: null }),
    cancelShipment: async () => undefined,
  };

  const tma = (id: number) => ({ authorization: `tma ${buildInitData({ id, language_code: "ru" }, BOT_TOKEN)}` });
  const internal = (id: number) => ({ authorization: "Internal internal-secret", "x-telegram-user": JSON.stringify({ id, language_code: "ru" }) });
  const userId = async (tg: number) => (await app.inject({ url: "/me", headers: tma(tg) })).json().id as string;
  const dmsTo = (tg: number) => dms.filter((d) => d.chatId === tg);
  const callbacks = (d: { buttons: NotifyButton[][] }) => d.buttons.flat().map((b) => ("callbackData" in b ? b.callbackData : b.url));

  async function liveListing(seller: number, extra: Partial<typeof listings.$inferInsert> = {}) {
    const [row] = await db
      .insert(listings)
      .values({
        sellerUserId: await userId(seller),
        category: "smartphone",
        titleRu: "iPhone 12 64 ГБ",
        titleUz: "iPhone 12 64 GB",
        descriptionRu: "Рабочий",
        descriptionUz: "Ishlaydi",
        attributes: { modelKey: "apple iphone 12 64gb", specs: [] },
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
  const order = (body: Record<string, unknown>) => app.inject({ method: "POST", url: "/orders", headers: tma(BUYER), payload: body });
  const card = async (who: number, id: string) => (await app.inject({ url: `/catalog/${id}`, headers: tma(who) })).json() as CatalogItem;
  const opStatus = (id: string, status: string, extra: Record<string, unknown> = {}) =>
    app.inject({ method: "POST", url: `/operator/orders/${id}/status`, headers: internal(OPERATOR), payload: { status, ...extra } });
  const status = async (id: string) => (await db.select().from(orders).where(eq(orders.id, id)))[0]!.status;
  const listingStatus = async (id: string) => (await db.select().from(listings).where(eq(listings.id, id)))[0]!.status;

  beforeAll(async () => {
    storageDir = mkdtempSync(join(tmpdir(), "ishonch-features-"));
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: url,
      BOT_TOKEN,
      INTERNAL_API_TOKEN: "internal-secret",
      OPERATOR_TELEGRAM_IDS: String(OPERATOR),
    } as NodeJS.ProcessEnv);
    const created = createDb(url);
    db = created.db;
    close = () => created.sql.end();
    app = await buildApp({ config, db, ai, storage: new FsStorage(storageDir), publisher: gateway, courier });
    await db.execute(dsql`update listings set status = 'archived' where status in ('active', 'pending', 'reserved')`);
    await app.services.orders.replaceTariffs([{ name: "default", vehicle: "courier", fromDistrict: null, toDistrict: null, price: 30_000, codFeePct: 1, liftPerFloor: 0, active: true }]);
  });

  beforeEach(async () => {
    dms.length = 0;
    shipments.length = 0;
    replies = ["Да, в продаже.", "Звоните +998 90 123 45 67", "Цена окончательная."];
    await db.execute(dsql.raw(`delete from users where telegram_id in (${ALL.join(",")})`));
    for (const tg of [SELLER, BUYER, SELLER2]) {
      await app.inject({ method: "POST", url: "/internal/phone", headers: internal(tg), payload: { phone: `+99890${String(tg).slice(-7)}` } });
    }
  });

  afterAll(async () => {
    await db.execute(dsql.raw(`delete from users where telegram_id in (${ALL.join(",")})`));
    await app.close();
    await close();
    rmSync(storageDir, { recursive: true, force: true });
  });

  /** Request → seller confirms; returns the order id. */
  async function confirmedOrder(listingId: string) {
    const o = (await order({ listingId, mode: "cod_seller", district: "yunusobod", address: "Amir Temur 1" })).json() as OrderDto;
    await app.inject({ method: "POST", url: `/orders/${o.id}/confirm`, headers: internal(SELLER) });
    return o.id;
  }

  // ---------------- review reminder ----------------

  it("review reminder: once, a day after delivery, only without a review", async () => {
    const a = await liveListing(SELLER);
    const b = await liveListing(SELLER);
    const idA = await confirmedOrder(a.id);
    const idB = await confirmedOrder(b.id);
    for (const id of [idA, idB]) {
      for (const s of ["courier_assigned", "picked_up", "delivered"]) await opStatus(id, s);
    }
    const dayAgo = new Date(Date.now() - 25 * 3600_000);
    await db.update(orders).set({ deliveredAt: dayAgo }).where(eq(orders.id, idA));
    await db.update(orders).set({ deliveredAt: dayAgo }).where(eq(orders.id, idB));
    await app.inject({ method: "POST", url: `/orders/${idB}/review`, headers: tma(BUYER), payload: { rating: 5 } });
    dms.length = 0;

    await app.services.orders.remindReviews();
    const reminders = dmsTo(BUYER);
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.text).toContain("Оцените продавца");
    expect(callbacks(reminders[0]!)[0]).toContain(`order_${idA}`);

    await app.services.orders.remindReviews();
    expect(dmsTo(BUYER)).toHaveLength(1); // never twice
    expect((await db.select().from(reviews).where(eq(reviews.orderId, idB))).length).toBe(1);
  });

  // ---------------- share ----------------

  it("share link: a deep link for live listings only", async () => {
    const l = await liveListing(SELLER);
    const res = (await app.inject({ url: `/listings/${l.id}/share` })).json();
    expect(res.url).toBe(`https://t.me/ishonch_bot/app?startapp=listing_${l.id}`);
    const draft = await liveListing(SELLER, { status: "draft" });
    expect((await app.inject({ url: `/listings/${draft.id}/share` })).statusCode).toBe(404);
  });

  // ---------------- checklist ----------------

  it("condition checklist: validated, shown to buyers, sent to AI moderation, frozen while reserved", async () => {
    const l = await liveListing(SELLER);
    const patch = (body: unknown) => app.inject({ method: "PATCH", url: `/listings/${l.id}`, headers: tma(SELLER), payload: body as object });
    expect((await patch({ checklist: { batteryPct: 140 } })).statusCode).toBe(400);
    expect((await patch({ checklist: { colour: "red" } })).statusCode).toBe(400);
    const ok = await patch({ checklist: { batteryPct: 87, biometrics: "ok", repairs: ["none", "screen"], kit: ["box", "box", "charger"] } });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as ListingDto).checklist).toEqual({ batteryPct: 87, biometrics: "ok", repairs: ["screen"], kit: ["box", "charger"] });
    expect((await card(BUYER, l.id)).listing.checklist.batteryPct).toBe(87);

    // The AI moderator sees the checklist when the listing is re-reviewed.
    await patch({ titleRu: "iPhone 12 64 ГБ, батарея 87%" });
    const call = ai.calls.filter((c) => c.promptId === "listing_moderate").at(-1)!;
    const sent = JSON.parse((call.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")!.text!);
    expect(sent.condition_checklist.batteryPct).toBe(87);

    await db.update(listings).set({ status: "reserved" }).where(eq(listings.id, l.id));
    expect((await patch({ checklist: { batteryPct: 100 } })).statusCode).toBe(409);
  });

  // ---------------- «Проверено Ishonch» ----------------

  it("inspection: operators only, a pass gives the listing a badge and counts for the seller, a fail removes it", async () => {
    const l = await liveListing(SELLER);
    const newOrder = (await order({ listingId: l.id, mode: "cod_seller", district: "yunusobod", address: "Amir Temur 1" })).json() as OrderDto;
    const inspect = (who: number, id: string, body: unknown) =>
      app.inject({ method: "POST", url: `/operator/orders/${id}/inspection`, headers: internal(who), payload: body as object });
    // Before the seller confirms there is nothing to inspect.
    expect((await inspect(OPERATOR, newOrder.id, { checks: { screen: true } })).statusCode).toBe(409);
    await app.inject({ method: "POST", url: `/orders/${newOrder.id}/confirm`, headers: internal(SELLER) });
    expect((await inspect(BUYER, newOrder.id, { checks: { screen: true } })).statusCode).toBe(403);
    expect((await inspect(OPERATOR, newOrder.id, { checks: {} })).statusCode).toBe(400);

    const passed = await inspect(OPERATOR, newOrder.id, { checks: { matches_description: true, screen: true, camera: true } });
    expect(passed.statusCode).toBe(200);
    expect((passed.json() as OrderDto).inspection).toMatchObject({ passed: true, checks: { screen: true } });

    // The buyer refuses at the door: the item is back on sale with the badge.
    for (const s of ["courier_assigned", "picked_up", "returned"]) await opStatus(newOrder.id, s);
    const item = await card(SELLER2, l.id);
    expect(item.listing.verified?.passed).toBe(true);
    expect(item.listing.seller!.inspections).toEqual({ passed: 1, failed: 0 });
    const buyerView = (await app.inject({ url: `/orders/${newOrder.id}`, headers: tma(BUYER) })).json() as OrderDto;
    expect(buyerView.inspection?.passed).toBe(true);

    // Next order: the courier finds a problem → no badge, counted against the seller.
    const second = await confirmedOrder(l.id);
    await inspect(OPERATOR, second, { checks: { screen: false, camera: true }, note: "царапина на экране" });
    const after = await card(SELLER2, l.id);
    expect(after.listing.verified).toBeNull();
    expect(after.listing.seller!.inspections).toEqual({ passed: 1, failed: 1 });
  });

  it("new categories: a monitor gets its own checklist, catalog filter and courier checks (no Face ID)", async () => {
    const l = await liveListing(SELLER, { category: "monitor", titleRu: "Монитор Samsung Odyssey G5", titleUz: "Samsung Odyssey G5 monitor" });
    const patch = (body: unknown) => app.inject({ method: "PATCH", url: `/listings/${l.id}`, headers: tma(SELLER), payload: body as object });
    const saved = await patch({ checklist: { deadPixels: "none", ageYears: 1, kit: ["box"] } });
    expect(saved.statusCode).toBe(200);
    expect((saved.json() as ListingDto).checklist).toEqual({ deadPixels: "none", ageYears: 1, kit: ["box"] });

    const page = (await app.inject({ url: "/catalog?category=monitor", headers: tma(BUYER) })).json() as { items: CatalogItem[] };
    expect(page.items.map((i) => i.listing.id)).toContain(l.id);
    expect(page.items.every((i) => i.listing.category === "monitor")).toBe(true);

    const id = await confirmedOrder(l.id);
    const inspect = (body: unknown) => app.inject({ method: "POST", url: `/operator/orders/${id}/inspection`, headers: internal(OPERATOR), payload: body as object });
    expect((await inspect({ checks: { biometrics: true } })).statusCode).toBe(400);
    const ok = await inspect({ checks: { matches_description: true, powers_on: true, dead_pixels: true } });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as OrderDto).inspection?.passed).toBe(true);
    const ops = (await app.inject({ url: "/operator/orders", headers: internal(OPERATOR) })).json() as Array<{ id: string; category: string }>;
    expect(ops.find((o) => o.id === id)?.category).toBe("monitor");
  });

  // ---------------- AI reply drafts ----------------

  it("reply drafts: the seller gets three AI options (no contacts), sends one with a tap", async () => {
    const l = await liveListing(SELLER);
    await app.inject({ method: "POST", url: `/listings/${l.id}/contact`, headers: tma(BUYER), payload: { text: "Ещё продаёте? Батарея какая?" } });
    const toSeller = dmsTo(SELLER).at(-1)!;
    const [conv] = await db.select().from(conversations).where(eq(conversations.listingId, l.id));
    expect(callbacks(toSeller)).toEqual(expect.arrayContaining([`reply:${conv!.id}`, `sugg:${conv!.id}`]));

    // Only the seller of this chat may ask (the buyer's own drafts are not offered).
    expect((await app.inject({ method: "POST", url: `/internal/conversations/${conv!.id}/suggestions`, headers: internal(BUYER) })).statusCode).toBe(404);
    const res = await app.inject({ method: "POST", url: `/internal/conversations/${conv!.id}/suggestions`, headers: internal(SELLER) });
    expect(res.statusCode).toBe(200);
    const { items } = res.json() as { items: string[] };
    expect(items).toHaveLength(3);
    expect(items[1]).not.toMatch(/\d{2}\s?\d{3}\s?\d{2}\s?\d{2}/); // the phone was scrubbed
    const prompt = JSON.stringify(ai.calls.filter((c) => c.promptId === "chat_suggest").at(-1)!.content);
    expect(prompt).toContain("Батарея какая?");

    dms.length = 0;
    const sent = await app.inject({ method: "POST", url: `/internal/conversations/${conv!.id}/suggestions/0/send`, headers: internal(SELLER) });
    expect(sent.json()).toMatchObject({ ok: true, text: "Да, в продаже." });
    expect(dmsTo(BUYER).at(-1)!.text).toContain("Да, в продаже.");
    // A draft is used once.
    expect((await app.inject({ method: "POST", url: `/internal/conversations/${conv!.id}/suggestions/1/send`, headers: internal(SELLER) })).statusCode).toBe(404);

    // Stale drafts can't be sent.
    await app.inject({ method: "POST", url: `/internal/conversations/${conv!.id}/suggestions`, headers: internal(SELLER) });
    await db
      .update(conversations)
      .set({ suggestions: dsql`jsonb_set(suggestions, '{at}', to_jsonb(${new Date(Date.now() - 3600_000).toISOString()}::text))` })
      .where(eq(conversations.id, conv!.id));
    expect((await app.inject({ method: "POST", url: `/internal/conversations/${conv!.id}/suggestions/0/send`, headers: internal(SELLER) })).statusCode).toBe(410);
  });

  // ---------------- bundles ----------------

  it("bundle: one delivery fee, one seller message, confirm reserves all, one operator card and one courier trip", async () => {
    const a = await liveListing(SELLER, { titleRu: "iPhone 12" });
    const b = await liveListing(SELLER, { titleRu: "AirPods Pro", price: 1_500_000, category: "headphones" });
    const foreign = await liveListing(SELLER2);

    const candidates = (await app.inject({ url: `/orders/bundle-candidates?listingId=${a.id}`, headers: tma(BUYER) })).json() as ListingDto[];
    expect(candidates.map((c) => c.id)).toEqual([b.id]);

    const quote = (await app.inject({ url: `/orders/quote?listingId=${a.id}&district=yunusobod&mode=cod_seller&extra=${b.id}`, headers: tma(BUYER) })).json() as DeliveryQuote & {
      bundle: BundleQuote;
    };
    expect(quote.deliveryFee).toBe(30_000);
    expect(quote.bundle.items[0]!.quote.deliveryFee).toBe(0);
    expect(quote.bundle.items[0]!.quote.codFee).toBe(15_000);
    expect(quote.bundle.saved).toBe(30_000);
    expect(quote.bundle.buyerTotal).toBe(4_000_000 + 30_000 + 40_000 + 1_500_000 + 15_000);
    const bad = await app.inject({ url: `/orders/quote?listingId=${a.id}&district=yunusobod&mode=cod_seller&extra=${foreign.id}`, headers: tma(BUYER) });
    expect(bad.json().error).toBe("bundle_invalid");

    const created = (await order({ listingId: a.id, extraListingIds: [b.id], mode: "cod_seller", district: "yunusobod", address: "Amir Temur 1" })).json() as OrderDto;
    expect(created.bundle).toHaveLength(1);
    const rows = await db.select().from(orders).where(eq(orders.bundleId, created.id));
    expect(rows).toHaveLength(2);
    const toSeller = dmsTo(SELLER);
    expect(toSeller).toHaveLength(1);
    expect(toSeller[0]!.text).toContain("AirPods Pro");
    expect(callbacks(toSeller[0]!)).toContain(`order:confirm:${created.id}`);

    dms.length = 0;
    await app.inject({ method: "POST", url: `/orders/${created.id}/confirm`, headers: internal(SELLER) });
    expect(await listingStatus(a.id)).toBe("reserved");
    expect(await listingStatus(b.id)).toBe("reserved");
    const cards = dmsTo(OPERATOR);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.text).toContain("Сборный заказ, 2 товара");
    expect(shipments).toHaveLength(1);
    expect(shipments[0]!.collectUzs).toBe(quote.bundle.buyerTotal);
    expect(dmsTo(BUYER)).toHaveLength(1);

    // One courier trip: assigning moves both; at the door the buyer keeps one item and returns the other.
    await opStatus(created.id, "courier_assigned", { courierName: "Akmal" });
    await opStatus(created.id, "picked_up");
    const sibling = rows.find((r) => r.id !== created.id)!.id;
    expect(await status(sibling)).toBe("picked_up");
    await opStatus(created.id, "delivered");
    await opStatus(sibling, "returned");
    expect(await listingStatus(a.id)).toBe("sold");
    expect(await listingStatus(b.id)).toBe("active");
  });

  it("bundle: cancelled as a whole by the buyer, and when one of its items leaves sale", async () => {
    const a = await liveListing(SELLER);
    const b = await liveListing(SELLER, { price: 1_000_000 });
    const first = (await order({ listingId: a.id, extraListingIds: [b.id], mode: "cod_seller", district: "yunusobod", address: "Amir Temur 1" })).json() as OrderDto;
    await app.inject({ method: "POST", url: `/orders/${first.id}/cancel`, headers: tma(BUYER) });
    const all1 = await db.select().from(orders).where(eq(orders.bundleId, first.id));
    expect(all1.map((o) => o.status)).toEqual(["cancelled", "cancelled"]);

    const second = (await order({ listingId: a.id, extraListingIds: [b.id], mode: "cod_seller", district: "yunusobod", address: "Amir Temur 1" })).json() as OrderDto;
    // The seller sells the extra item elsewhere: the bundle price no longer holds, the whole request closes.
    await app.inject({ method: "POST", url: `/listings/${b.id}/sold`, headers: tma(SELLER), payload: { via: "elsewhere" } });
    const all2 = await db.select().from(orders).where(eq(orders.bundleId, second.id));
    expect(all2.map((o) => o.status)).toEqual(["cancelled", "cancelled"]);
    expect(await listingStatus(a.id)).toBe("active");
  });
  // ---------------- hardening (review findings) ----------------

  it("platform sales count delivered orders only: the seller's own 'sold on Ishonch' mark does not raise trust", async () => {
    const own = await liveListing(SELLER);
    await app.inject({ method: "POST", url: `/listings/${own.id}/sold`, headers: tma(SELLER), payload: { via: "platform" } });
    const other = await liveListing(SELLER);
    expect((await card(BUYER, other.id)).listing.seller!.platformSales).toBe(0);
    const id = await confirmedOrder(other.id);
    for (const s of ["courier_assigned", "picked_up", "delivered"]) await opStatus(id, s);
    const third = await liveListing(SELLER);
    expect((await card(BUYER, third.id)).listing.seller!.platformSales).toBe(1);
  });

  it("confirming one buyer closes a rival bundle as a whole, with one message to its buyer", async () => {
    const a = await liveListing(SELLER);
    const c = await liveListing(SELLER, { price: 1_000_000 });
    const bundle = (await order({ listingId: a.id, extraListingIds: [c.id], mode: "cod_seller", district: "yunusobod", address: "Amir Temur 1" })).json() as OrderDto;
    const rival = (
      await app.inject({ method: "POST", url: "/orders", headers: tma(SELLER2), payload: { listingId: a.id, mode: "cod_seller", district: "yunusobod", address: "Chilonzor 9" } })
    ).json() as OrderDto;
    dms.length = 0;
    await app.inject({ method: "POST", url: `/orders/${rival.id}/confirm`, headers: internal(SELLER) });
    const rows = await db.select().from(orders).where(eq(orders.bundleId, bundle.id));
    expect(rows.map((r) => r.status)).toEqual(["cancelled", "cancelled"]);
    expect(dmsTo(BUYER)).toHaveLength(1);
    expect(await listingStatus(c.id)).toBe("active");
  });

  it("a bundle whose main item is gone closes entirely at confirmation (no delivery-free trip)", async () => {
    const a = await liveListing(SELLER);
    const c = await liveListing(SELLER, { price: 1_000_000 });
    const bundle = (await order({ listingId: a.id, extraListingIds: [c.id], mode: "cod_seller", district: "yunusobod", address: "Amir Temur 1" })).json() as OrderDto;
    // The main item disappears without the usual hooks (e.g. a race): confirmation must not ship the rest.
    await db.update(listings).set({ status: "sold" }).where(eq(listings.id, a.id));
    const res = await app.inject({ method: "POST", url: `/orders/${bundle.id}/confirm`, headers: internal(SELLER) });
    expect(res.statusCode).toBe(409);
    const rows = await db.select().from(orders).where(eq(orders.bundleId, bundle.id));
    expect(rows.every((r) => r.status === "cancelled")).toBe(true);
    expect(await listingStatus(c.id)).toBe("active");
    expect(shipments).toHaveLength(0);
  });

  it("a price change closes open requests (quoted at the old price); a bait-sized cut goes back to moderation", async () => {
    const l = await liveListing(SELLER);
    const o = (await order({ listingId: l.id, mode: "cod_seller", district: "yunusobod", address: "Amir Temur 1" })).json() as OrderDto;
    await app.inject({ method: "PATCH", url: `/listings/${l.id}`, headers: tma(SELLER), payload: { price: 3_800_000 } });
    expect(await status(o.id)).toBe("cancelled");
    expect((await db.select().from(orders).where(eq(orders.id, o.id)))[0]!.cancelReason).toBe("price_changed");
    expect(await listingStatus(l.id)).toBe("active");

    ai.calls.length = 0;
    await app.inject({ method: "PATCH", url: `/listings/${l.id}`, headers: tma(SELLER), payload: { price: 1_500_000 } });
    expect(ai.calls.some((c) => c.promptId === "listing_moderate")).toBe(true);
  });

  it("complaints collected while reserved hide the listing once it is back on sale", async () => {
    const l = await liveListing(SELLER);
    const id = await confirmedOrder(l.id);
    for (const [i, tg] of [BUYER, SELLER2, OPERATOR].entries()) {
      await db.insert(complaints).values({ listingId: l.id, userId: await userId(tg), reason: i ? "scam" : "wrong_info" });
    }
    await opStatus(id, "cancelled");
    expect(await listingStatus(l.id)).toBe("pending");
  });

  it("a route without a tariff refuses delivery instead of shipping for free", async () => {
    const l = await liveListing(SELLER);
    const saved = await app.services.orders.tariffs();
    await app.services.orders.replaceTariffs([]);
    try {
      const res = await app.inject({ url: `/orders/quote?listingId=${l.id}&district=yunusobod&mode=cod_seller`, headers: tma(BUYER) });
      expect(res.json().error).toBe("no_tariff");
    } finally {
      await app.services.orders.replaceTariffs(saved.map(({ id: _id, ...t }) => t));
    }
  });

  it("photos are served at card sizes (resized once, then from storage)", async () => {
    const l = await liveListing(SELLER);
    const big = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: { r: 200, g: 50, b: 50 } } }).jpeg().toBuffer();
    const key = `test/${l.id}.jpg`;
    await new FsStorage(storageDir).put(key, big);
    const [p] = await db.insert(listingPhotos).values({ listingId: l.id, storageKey: key, position: 0 }).returning();
    const url = app.services.listings.photoUrl(p!.id, key);
    const small = await app.inject({ url: `${url}&w=240` });
    expect(small.statusCode).toBe(200);
    expect((await sharp(small.rawPayload).metadata()).width).toBe(240);
    expect((await app.inject({ url: `${url}&w=333` })).rawPayload.length).toBe(big.length); // only the known sizes
    expect((await app.inject({ url: `${url.replace(/s=[^&]+/, "s=forged")}&w=240` })).statusCode).toBe(404);
  });
});
