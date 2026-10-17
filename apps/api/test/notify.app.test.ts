import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { eq, sql as dsql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.js";
import { buildInitData } from "../src/auth/telegram.js";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { follows, listings, offers, priceReference, users } from "../src/db/schema.js";
import type { CourierProvider } from "../src/modules/orders/courier.js";
import { FsStorage } from "../src/storage/storage.js";
import type { ChannelPublisher, Notifier, NotifyButton } from "../src/telegram/publisher.js";
import { mockAiByPrompt } from "./helpers.js";

const url = process.env.TEST_DATABASE_URL ?? "postgres://ishonch:ishonch@localhost:5432/ishonch";
const reachable = await postgres(url, { max: 1, connect_timeout: 2 })`select 1`
  .then(() => true)
  .catch(() => false);

const BOT_TOKEN = "123456:TEST";
const SELLER = 990_220_001;
const BUYER = 990_220_002;
const OPERATOR = 990_220_003;
const ADMIN = 990_220_004;
const LIKER = 990_220_005;
const ALL = [SELLER, BUYER, OPERATOR, ADMIN, LIKER];
const MODERATORS = -100_990_220;
// A model of our own, so the price reference of other tests and seeds does not matter.
const MODEL = "testbrand phone x22 128gb";

describe.skipIf(!reachable)("notifications under control (integration)", () => {
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
    storageDir = mkdtempSync(join(tmpdir(), "ishonch-notify-"));
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

  const setNotify = (who: number, type: string, on: boolean) =>
    app.inject({ method: "PATCH", url: "/me/notifications", headers: tma(who), payload: { type, on } });

  it("settings: switch types off and on; unknown types are refused; /me shows the list", async () => {
    expect((await setNotify(BUYER, "orders", false)).statusCode).toBe(400);
    expect((await setNotify(BUYER, "price_drop", false)).json()).toEqual({ notifyOff: ["price_drop"] });
    expect((await setNotify(BUYER, "price_drop", false)).json()).toEqual({ notifyOff: ["price_drop"] }); // no duplicates
    expect((await setNotify(BUYER, "follow", false)).json()).toEqual({ notifyOff: ["price_drop", "follow"] });
    expect((await get<{ notifyOff: string[] }>(BUYER, "/me")).notifyOff).toEqual(["price_drop", "follow"]);
    expect((await setNotify(BUYER, "price_drop", true)).json()).toEqual({ notifyOff: ["follow"] });
  });

  it("switched-off types are not sent; the others carry «Не присылать такое»", async () => {
    // Price drop: on → a message with the unsubscribe button.
    const l = await liveListing();
    await post(BUYER, `/favorites/${l.id}`);
    await app.inject({ method: "PATCH", url: `/listings/${l.id}`, headers: tma(SELLER), payload: { price: 3_600_000 } });
    const drop = dmsTo(BUYER).at(-1)!;
    expect(drop.text).toContain("3 600 000");
    expect(callbacks(drop)).toContain("unsub:price_drop");

    // Off → nothing more.
    await setNotify(BUYER, "price_drop", false);
    dms.length = 0;
    await app.inject({ method: "PATCH", url: `/listings/${l.id}`, headers: tma(SELLER), payload: { price: 3_300_000 } });
    expect(dmsTo(BUYER)).toHaveLength(0);

    // Offer to likers: the personal price still applies, only the message is skipped.
    await setNotify(BUYER, "likers_offer", false);
    await db.update(listings).set({ price: 4_000_000 }).where(eq(listings.id, l.id));
    const res = await post(SELLER, `/listings/${l.id}/offer-likers`, { amount: 3_000_000 });
    expect(res.json()).toMatchObject({ sent: 1 });
    expect(dmsTo(BUYER)).toHaveLength(0);
    expect((await db.select().from(offers).where(eq(offers.listingId, l.id))).some((o) => o.amount === 3_000_000)).toBe(true);

    // Follow alerts.
    await post(BUYER, `/sellers/${l.sellerUserId}/follow`);
    await setNotify(BUYER, "follow", false);
    const l2 = await liveListing();
    expect(await app.services.listings.followerAlerts(l2.id)).toBe(0);
    await setNotify(BUYER, "follow", true);
    await db.update(follows).set({ lastNotifiedAt: null });
    expect(await app.services.listings.followerAlerts(l2.id)).toBe(1);
    expect(callbacks(dmsTo(BUYER).at(-1)!)).toContain("unsub:follow");
    expect((await db.select().from(users).where(eq(users.telegramId, BUYER)))[0]!.notifyOff).toEqual(["price_drop", "likers_offer"]);
  });
});
