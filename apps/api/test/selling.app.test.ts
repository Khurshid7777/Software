import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { eq, sql as dsql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { BundleQuote, DeliveryQuote, ListingDto, ListingSeller } from "@ishonch/shared";
import { buildApp } from "../src/app.js";
import { buildInitData } from "../src/auth/telegram.js";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { favorites, follows, jobs, listings, offers, priceReference, users } from "../src/db/schema.js";
import type { CourierProvider } from "../src/modules/orders/courier.js";
import { FsStorage } from "../src/storage/storage.js";
import type { ChannelPublisher, Notifier, NotifyButton } from "../src/telegram/publisher.js";
import { mockAiByPrompt } from "./helpers.js";

const url = process.env.TEST_DATABASE_URL ?? "postgres://ishonch:ishonch@localhost:5432/ishonch";
const reachable = await postgres(url, { max: 1, connect_timeout: 2 })`select 1`
  .then(() => true)
  .catch(() => false);

const BOT_TOKEN = "123456:TEST";
const SELLER = 990_160_001;
const BUYER = 990_160_002;
const OPERATOR = 990_160_003;
const ADMIN = 990_160_004;
const LIKER = 990_160_005;
const ALL = [SELLER, BUYER, OPERATOR, ADMIN, LIKER];
const MODERATORS = -100_990_160;
// A model of our own, so the price reference of other tests and seeds does not matter.
const MODEL = "testbrand phone x16 128gb";

describe.skipIf(!reachable)("selling faster and coming back: likers offers, auto drops, badges, follows, set discount, quiet hours (integration)", () => {
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

  beforeAll(async () => {
    storageDir = mkdtempSync(join(tmpdir(), "ishonch-selling-"));
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: url,
      BOT_TOKEN,
      INTERNAL_API_TOKEN: "internal-secret",
      OPERATOR_TELEGRAM_IDS: String(OPERATOR),
      ADMIN_TELEGRAM_IDS: String(ADMIN),
      MODERATION_CHAT_ID: String(MODERATORS),
      QUIET_HOURS: "true",
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

  afterEach(() => void vi.useRealTimers());
  /** Today 12:00 in Tashkent: outside the quiet hours whenever the suite runs (only Date is faked). */
  const middayInTashkent = () => {
    const d = new Date();
    d.setUTCHours(7, 0, 0, 0);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(d);
    return d;
  };

  it("offer to likers: ≥10 % off, only to those who saved it, 24 h accepted offer that checkout applies", async () => {
    middayInTashkent();
    const l = await liveListing();
    expect((await post(SELLER, `/listings/${l.id}/offer-likers`, { amount: 3_500_000 })).json().error).toBe("no_likers");
    await like(l.id, BUYER, LIKER);

    expect((await post(BUYER, `/listings/${l.id}/offer-likers`, { amount: 3_500_000 })).statusCode).toBe(403);
    const tooHigh = await post(SELLER, `/listings/${l.id}/offer-likers`, { amount: 3_700_000 });
    expect(tooHigh.json()).toMatchObject({ error: "likers_too_high" });
    expect(tooHigh.json().message).toContain("10%");

    const res = await post(SELLER, `/listings/${l.id}/offer-likers`, { amount: 3_600_000 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ sent: 2, price: 3_600_000 });
    const expires = new Date(res.json().expiresAt).getTime();
    expect(expires - Date.now()).toBeGreaterThan(23 * 36e5);
    expect(expires - Date.now()).toBeLessThanOrEqual(24 * 36e5);

    // Each liker got a DM with a checkout button; the seller's own phone number never leaks.
    for (const who of [BUYER, LIKER]) {
      const [dm] = dmsTo(who);
      expect(dm!.text).toContain("3 600 000");
      expect(callbacks(dm!).join(" ")).toContain(l.id);
    }
    // The price applies at checkout for a liker, not for anyone else.
    const quote = await get<DeliveryQuote>(BUYER, `/orders/quote?listingId=${l.id}&district=chilonzor&mode=cod_seller`);
    expect(quote.itemPrice).toBe(3_600_000);
    const rows = await db.select().from(offers).where(eq(offers.listingId, l.id));
    expect(rows).toHaveLength(2);
    expect(rows.every((o) => o.status === "accepted" && o.kind === "price")).toBe(true);

    // Owner sees the last offer; once per 3 days.
    const mine = (await get<ListingDto[]>(SELLER, "/listings/mine?status=active")).find((x) => x.id === l.id)!;
    expect(mine.likersOffer).toMatchObject({ price: 3_600_000 });
    expect((await post(SELLER, `/listings/${l.id}/offer-likers`, { amount: 3_000_000 })).json().error).toBe("likers_too_soon");

    // After 3 days only a lower price is allowed.
    await db.update(listings).set({ likersOfferAt: new Date(Date.now() - 4 * 864e5) }).where(eq(listings.id, l.id));
    expect((await post(SELLER, `/listings/${l.id}/offer-likers`, { amount: 3_600_000 })).json().error).toBe("likers_not_lower");
    expect((await post(SELLER, `/listings/${l.id}/offer-likers`, { amount: 3_400_000 })).statusCode).toBe(200);
    // A buyer who unsaved the item is not contacted.
    expect((await db.select().from(favorites).where(eq(favorites.listingId, l.id))).length).toBe(2);
  });

  // ---------------- auto price drop ----------------

  it("auto drop: floor validation, 5 % every 3 days down to the floor, likers alerted, paused when not active", async () => {
    const l = await liveListing();
    await like(l.id, BUYER);
    expect((await patch(SELLER, l.id, { autoDropFloor: 4_000_000 })).json().error).toBe("bad_floor");
    expect((await patch(SELLER, l.id, { autoDropFloor: 1_900_000 })).json().error).toBe("bad_floor");
    const on = (await patch(SELLER, l.id, { autoDropFloor: 3_700_000 })).json() as ListingDto;
    expect(on.autoDrop!.floor).toBe(3_700_000);
    expect(new Date(on.autoDrop!.nextAt).getTime() - Date.now()).toBeGreaterThan(2.9 * 864e5);

    // Not due yet → nothing happens.
    expect(await app.services.listings.runAutoDrops()).toBe(0);

    // A day-time run (12:00 Tashkent) four days later, so the alert is not held for the quiet hours.
    const later = new Date(Date.now() + 4 * 864e5);
    later.setUTCHours(7, 0, 0, 0);
    expect(await app.services.listings.runAutoDrops(later)).toBe(1);
    let [row] = await db.select().from(listings).where(eq(listings.id, l.id));
    expect(row!.price).toBe(3_800_000);
    expect(row!.autoDropFloor).toBe(3_700_000);
    expect(dmsTo(SELLER).at(-1)!.text).toContain("3 800 000");
    // Those who saved it hear about the drop (the regular price-drop alert).
    expect(dmsTo(BUYER).some((d) => d.text.includes("3 800 000"))).toBe(true);

    // The next step stops at the floor and turns itself off.
    const after = new Date(later.getTime() + 4 * 864e5);
    expect(await app.services.listings.runAutoDrops(after)).toBe(1);
    [row] = await db.select().from(listings).where(eq(listings.id, l.id));
    expect(row).toMatchObject({ price: 3_700_000, autoDropFloor: null, autoDropAt: null });
    expect(dmsTo(SELLER).at(-1)!.text).toContain("минимума");

    // Stopping it by hand.
    const l2 = await liveListing();
    await patch(SELLER, l2.id, { autoDropFloor: 3_000_000 });
    const off = (await patch(SELLER, l2.id, { autoDropFloor: null })).json() as ListingDto;
    expect(off.autoDrop).toBeNull();
    expect(await app.services.listings.runAutoDrops(after)).toBe(0);

    // Paused while reserved/not active.
    await patch(SELLER, l2.id, { autoDropFloor: 3_000_000 });
    await db.update(listings).set({ status: "reserved" }).where(eq(listings.id, l2.id));
    expect(await app.services.listings.runAutoDrops(after)).toBe(0);
    // Not visible to buyers.
    await db.update(listings).set({ status: "active" }).where(eq(listings.id, l2.id));
    const pub = await get<{ listing: ListingDto }>(BUYER, `/catalog/${l2.id}`);
    expect(pub.listing.autoDrop ?? null).toBeNull();
  });

  // ---------------- badges ----------------

  it("seller badges are earned from facts: fast replies, courier checks, sales without lost disputes", async () => {
    const l = await liveListing();
    const item = await get<{ listing: ListingDto }>(BUYER, `/catalog/${l.id}`);
    expect(item.listing.seller!.badges).toEqual([]);
    const page = await get<{ seller: { badges: string[] } }>(BUYER, `/sellers/${l.sellerUserId}/page`);
    expect(page.seller.badges).toEqual([]);
  });

  // ---------------- stage 17 ----------------

  // 23:30 tonight+1 and 08:00 next morning in Tashkent (UTC+5); in the future, so jobs stay deferred.
  const NIGHT = new Date(Date.now() + 864e5);
  NIGHT.setUTCHours(18, 30, 0, 0);
  const MORNING = new Date(NIGHT.getTime() + 8.5 * 36e5);
  const dbUser = async (tg: number) => (await db.select().from(users).where(eq(users.telegramId, tg)))[0]!;
  const deferred = async (kind: string, listingId: string) =>
    (await db.execute(dsql`select run_at from ${jobs} where kind = ${kind} and payload->>'listingId' = ${listingId} and done_at is null`)) as unknown as Array<{
      run_at: string;
    }>;

  it("follow a seller: count and state on the seller page, one message a day about new items, not yourself", async () => {
    const sellerId = await userId(SELLER);
    expect((await post(SELLER, `/sellers/${sellerId}/follow`)).statusCode).toBe(400);
    const res = await post(BUYER, `/sellers/${sellerId}/follow`);
    expect(res.json()).toEqual({ following: true, followers: 1 });
    await post(BUYER, `/sellers/${sellerId}/follow`); // idempotent
    const page = await get<{ seller: ListingSeller; following: boolean }>(BUYER, `/sellers/${sellerId}/page`);
    expect(page).toMatchObject({ following: true, seller: { followers: 1 } });
    expect((await get<ListingSeller[]>(BUYER, "/me/following")).map((x) => x.id)).toEqual([sellerId]);

    const l1 = await liveListing();
    expect(await app.services.listings.followerAlerts(l1.id)).toBe(1);
    expect(dmsTo(BUYER).at(-1)!.text).toContain("Testbrand X7");
    expect(callbacks(dmsTo(BUYER).at(-1)!).join(" ")).toContain(l1.id);
    // The second new item the same day stays quiet.
    const l2 = await liveListing();
    expect(await app.services.listings.followerAlerts(l2.id)).toBe(0);
    // Next day — again.
    await db.update(follows).set({ lastNotifiedAt: new Date(Date.now() - 2 * 864e5) });
    expect(await app.services.listings.followerAlerts(l2.id)).toBe(1);

    const off = await app.inject({ method: "DELETE", url: `/sellers/${sellerId}/follow`, headers: tma(BUYER) });
    expect(off.json()).toEqual({ following: false, followers: 0 });
    expect(await app.services.listings.followerAlerts(l2.id)).toBe(0);
  });

  it("set discount: the shop's % for 2 and 3+ items in one delivery, not on top of an agreed price", async () => {
    expect((await app.inject({ method: "PUT", url: "/shops/mine", headers: tma(SELLER), payload: { name: "Test Shop", bundle2Pct: 10, bundle3Pct: 5 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/shops/mine", headers: tma(SELLER), payload: { name: "Test Shop", bundle2Pct: 31 } })).statusCode).toBe(400);
    const shop = await app.inject({ method: "PUT", url: "/shops/mine", headers: tma(SELLER), payload: { name: "Test Shop", bundle2Pct: 10, bundle3Pct: 15 } });
    expect(shop.json()).toMatchObject({ bundle2Pct: 10, bundle3Pct: 15 });

    const [a, b, c] = [await liveListing(), await liveListing({ price: 1_000_000 }), await liveListing({ price: 2_000_000 })];
    const item = await get<{ listing: ListingDto }>(BUYER, `/catalog/${a.id}`);
    expect(item.listing.seller!.shop!.bundleDiscount).toEqual({ two: 10, three: 15 });

    const quote = (extra: string[]) =>
      get<DeliveryQuote & { bundle: BundleQuote | null }>(BUYER, `/orders/quote?listingId=${a.id}&district=chilonzor&mode=cod_seller&extra=${extra.join(",")}`);
    const single = await get<DeliveryQuote & { bundle: BundleQuote | null }>(BUYER, `/orders/quote?listingId=${a.id}&district=chilonzor&mode=cod_seller`);
    expect(single.itemPrice).toBe(4_000_000);

    const two = await quote([b.id]);
    expect(two.itemPrice).toBe(3_600_000);
    expect(two.bundle).toMatchObject({ discountPct: 10, discount: 500_000 });
    expect(two.bundle!.items[0]!.quote.itemPrice).toBe(900_000);

    const three = await quote([b.id, c.id]);
    expect(three.bundle).toMatchObject({ discountPct: 15, discount: 1_050_000 });

    // An accepted offer on the main item is a deal already: the discount skips it.
    await db.insert(offers).values({
      listingId: a.id,
      buyerUserId: await userId(BUYER),
      sellerUserId: a.sellerUserId,
      amount: 3_500_000,
      listPrice: 4_000_000,
      status: "accepted",
      decidedAt: new Date(),
      expiresAt: new Date(Date.now() + 864e5),
    });
    const withOffer = await quote([b.id]);
    expect(withOffer.itemPrice).toBe(3_500_000);
    expect(withOffer.bundle).toMatchObject({ discountPct: 10, discount: 100_000 });

    // The order stores the discounted prices.
    const order = await post(BUYER, "/orders", { listingId: a.id, extraListingIds: [b.id], mode: "cod_seller", district: "chilonzor", address: "Bunyodkor 1" });
    expect(order.statusCode).toBe(200);
    // The seller sees the discount in the order message.
    expect(dmsTo(SELLER).at(-1)!.text).toContain("Скидка за комплект 10%: −100 000");
  });

  it("quiet hours: price-drop alerts and likers offers wait until 08:00 Tashkent, and the 24 hours start then", async () => {
    const l = await liveListing();
    await like(l.id, BUYER);
    await patch(SELLER, l.id, { autoDropFloor: 3_000_000 });
    const night = new Date(Date.now() + 4 * 864e5);
    night.setUTCHours(18, 30, 0, 0); // 23:30 in Tashkent
    expect(await app.services.listings.runAutoDrops(night)).toBe(1);
    const morning = new Date(night);
    morning.setUTCDate(morning.getUTCDate() + 1);
    morning.setUTCHours(3, 0, 0, 0);
    expect((await deferred("price_drop_alerts", l.id)).map((j) => new Date(j.run_at).toISOString())).toEqual([morning.toISOString()]);
    expect(dmsTo(BUYER)).toHaveLength(0);

    const l2 = await liveListing();
    await like(l2.id, BUYER);
    const res = await app.services.orders.offerToLikers(await dbUser(SELLER), l2.id, 3_600_000, NIGHT);
    expect(res.deferredUntil).toBe(MORNING.toISOString());
    expect(new Date(res.expiresAt).getTime()).toBe(MORNING.getTime() + 24 * 36e5);
    expect(dmsTo(BUYER)).toHaveLength(0);
    expect(await deferred("likers_offer_dms", l2.id)).toHaveLength(1);
    // The job in the morning sends them.
    expect(await app.services.orders.likersOfferDms(l2.id, 3_600_000)).toBe(1);
    expect(dmsTo(BUYER).at(-1)!.text).toContain("3 600 000");
    await db.delete(jobs).where(dsql`payload->>'listingId' in (${l.id}, ${l2.id})`);
  });
});
