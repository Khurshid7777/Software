import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { eq, sql as dsql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.js";
import { buildInitData } from "../src/auth/telegram.js";
import { loadConfig, productionWarnings } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { conversationMessages, conversations, disputes, listings, orders, priceReference, reviews, users } from "../src/db/schema.js";
import type { CourierProvider } from "../src/modules/orders/courier.js";
import { FsStorage } from "../src/storage/storage.js";
import type { ChannelPublisher, Notifier, NotifyButton } from "../src/telegram/publisher.js";
import { mockAiByPrompt } from "./helpers.js";

const url = process.env.TEST_DATABASE_URL ?? "postgres://ishonch:ishonch@localhost:5432/ishonch";
const reachable = await postgres(url, { max: 1, connect_timeout: 2 })`select 1`
  .then(() => true)
  .catch(() => false);

const BOT_TOKEN = "123456:TEST";
const SELLER = 990_200_001;
const BUYER = 990_200_002;
const OPERATOR = 990_200_003;
const ADMIN = 990_200_004;
const LIKER = 990_200_005;
const ALL = [SELLER, BUYER, OPERATOR, ADMIN, LIKER];
const MODERATORS = -100_990_200;
// A model of our own, so the price reference of other tests and seeds does not matter.
const MODEL = "testbrand phone x20 128gb";

describe.skipIf(!reachable)("privacy and account deletion (integration)", () => {
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
    storageDir = mkdtempSync(join(tmpdir(), "ishonch-privacy-"));
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

  it("retention: old closed orders lose the address, old chat messages and events go; open ones stay", async () => {
    const l = await liveListing();
    const buyer = await userId(BUYER);
    const old = new Date(Date.now() - 100 * 864e5);
    const quote = { itemPrice: 1, buyerTotal: 1 };
    const [closed] = await db
      .insert(orders)
      .values({ listingId: l.id, buyerUserId: buyer, sellerUserId: l.sellerUserId, mode: "cod_seller", status: "delivered", district: "chilonzor", address: "Bunyodkor 1, kv 5", comment: "домофон 12", courierPhone: "+998901234567", quote, feePayer: "buyer", updatedAt: old })
      .returning();
    const [fresh] = await db
      .insert(orders)
      .values({ listingId: l.id, buyerUserId: buyer, sellerUserId: l.sellerUserId, mode: "cod_seller", status: "cancelled", district: "chilonzor", address: "Navoiy 2", quote, feePayer: "buyer" })
      .returning();
    const [conv] = await db.insert(conversations).values({ listingId: l.id, buyerUserId: buyer, sellerUserId: l.sellerUserId }).returning();
    await db.insert(conversationMessages).values([
      { conversationId: conv!.id, senderUserId: buyer, text: "старое", createdAt: new Date(Date.now() - 400 * 864e5) },
      { conversationId: conv!.id, senderUserId: buyer, text: "новое" },
    ]);

    const r = await app.services.repo.runRetention();
    expect(r.orders).toBeGreaterThanOrEqual(1);
    const [c] = await db.select().from(orders).where(eq(orders.id, closed!.id));
    expect(c).toMatchObject({ address: "", comment: null, courierPhone: null, status: "delivered" });
    expect((await db.select().from(orders).where(eq(orders.id, fresh!.id)))[0]!.address).toBe("Navoiy 2");
    const msgs = await db.select().from(conversationMessages).where(eq(conversationMessages.conversationId, conv!.id));
    expect(msgs.map((m) => m.text)).toEqual(["новое"]);
  });

  it("account deletion waits for the dispute window and open disputes", async () => {
    const l = await liveListing();
    const buyer = await userId(BUYER);
    await db.insert(orders).values({
      listingId: l.id,
      buyerUserId: buyer,
      sellerUserId: l.sellerUserId,
      mode: "cod_seller",
      status: "delivered",
      deliveredAt: new Date(),
      district: "chilonzor",
      address: "x",
      quote: { itemPrice: 1 },
      feePayer: "buyer",
    });
    const res = await app.inject({ method: "DELETE", url: "/me", headers: tma(SELLER) });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("3 дня");
    await db.update(orders).set({ deliveredAt: new Date(Date.now() - 4 * 864e5) }).where(eq(orders.listingId, l.id));
    expect((await app.inject({ method: "DELETE", url: "/me", headers: tma(SELLER) })).statusCode).toBe(200);
    expect(await db.select().from(users).where(eq(users.telegramId, SELLER))).toHaveLength(0);
  });

  it("unsafe production settings are reported", () => {
    const base = { NODE_ENV: "production", INTERNAL_API_TOKEN: "x".repeat(40), BOT_TOKEN: "1:x" } as NodeJS.ProcessEnv;
    expect(productionWarnings(loadConfig(base))).toHaveLength(2); // default DB password, CORS *
    const safe = loadConfig({ ...base, DATABASE_URL: "postgres://ishonch:Str0ng-pass@db:5432/ishonch", CORS_ORIGIN: "https://app.example" });
    expect(productionWarnings(safe)).toEqual([]);
  });

  it("a deleted seller's sales stay in the buyer's history, anonymised; the rest of the account is gone", async () => {
    const l = await liveListing({ status: "sold" });
    const other = await liveListing(); // never ordered: deleted with the account
    const buyer = await userId(BUYER);
    const [o] = await db
      .insert(orders)
      .values({ listingId: l.id, buyerUserId: buyer, sellerUserId: l.sellerUserId, mode: "cod_seller", status: "delivered", deliveredAt: new Date(Date.now() - 10 * 864e5), district: "chilonzor", address: "", quote: { itemPrice: 1 }, feePayer: "buyer" })
      .returning();
    await db.insert(reviews).values({ orderId: o!.id, listingId: l.id, sellerUserId: l.sellerUserId, buyerUserId: buyer, rating: 2 });
    await db.insert(disputes).values({ orderId: o!.id, listingId: l.id, buyerUserId: buyer, sellerUserId: l.sellerUserId, reason: "not_working", text: "Сломался на второй день", status: "resolved", resolution: "refund" });

    expect((await app.inject({ method: "DELETE", url: "/me", headers: tma(SELLER) })).statusCode).toBe(200);
    expect(await db.select().from(users).where(eq(users.telegramId, SELLER))).toHaveLength(0);
    expect(await db.select().from(listings).where(eq(listings.id, other.id))).toHaveLength(0);

    const [kept] = await db.select().from(orders).where(eq(orders.id, o!.id));
    expect(kept).toBeTruthy();
    const [ghost] = await db.select().from(users).where(eq(users.id, kept!.sellerUserId));
    expect(ghost).toMatchObject({ role: "deleted", phone: null, banReason: "account_deleted" });
    expect(ghost!.telegramId).toBeLessThan(0);
    expect((await db.select().from(disputes).where(eq(disputes.orderId, o!.id)))[0]!.sellerUserId).toBe(ghost!.id);
    expect((await db.select().from(reviews).where(eq(reviews.orderId, o!.id)))[0]!.sellerUserId).toBe(ghost!.id);
    // The buyer still sees the order; the placeholder is not listed among banned users.
    const mine = (await app.inject({ url: "/orders/mine?role=buyer", headers: tma(BUYER) })).json() as Array<{ id: string }>;
    expect(mine.some((x) => x.id === o!.id)).toBe(true);
    const banned = (await app.inject({ url: "/admin/users/banned", headers: tma(ADMIN) })).json() as Array<{ id: string }>;
    expect(banned.some((b) => b.id === ghost!.id)).toBe(false);
  });
});
