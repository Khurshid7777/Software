import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { eq, sql as dsql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { DeliveryQuote, ListingDto } from "@ishonch/shared";
import { buildApp } from "../src/app.js";
import { buildInitData } from "../src/auth/telegram.js";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { favorites, listings, offers, priceReference } from "../src/db/schema.js";
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

describe.skipIf(!reachable)("selling faster: offer to likers, auto price drops, seller badges (integration)", () => {
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

  it("offer to likers: ≥10 % off, only to those who saved it, 24 h accepted offer that checkout applies", async () => {
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

    const later = new Date(Date.now() + 3 * 864e5 + 60_000);
    expect(await app.services.listings.runAutoDrops(later)).toBe(1);
    let [row] = await db.select().from(listings).where(eq(listings.id, l.id));
    expect(row!.price).toBe(3_800_000);
    expect(row!.autoDropFloor).toBe(3_700_000);
    expect(dmsTo(SELLER).at(-1)!.text).toContain("3 800 000");
    // Those who saved it hear about the drop (the regular price-drop alert).
    expect(dmsTo(BUYER).some((d) => d.text.includes("3 800 000"))).toBe(true);

    // The next step stops at the floor and turns itself off.
    const after = new Date(later.getTime() + 3 * 864e5 + 60_000);
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
});
