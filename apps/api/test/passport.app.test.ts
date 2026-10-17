import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { eq, sql as dsql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { computeGrade, CONDITIONS, type CatalogItem, type CatalogPage, type ConditionChecklist, type ListingInsights, type OrderDto } from "@ishonch/shared";
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
const SELLER = 990_200_001;
const BUYER = 990_200_002;
const OPERATOR = 990_200_003;
const ADMIN = 990_200_004;
const SELLER2 = 990_200_005;
const ALL = [SELLER, BUYER, OPERATOR, ADMIN, SELLER2];
const MODERATORS = -100_990_200;
// A model of our own, so the price reference of other tests and seeds does not matter.
const MODEL = "testbrand phone p9 256gb";

describe.skipIf(!reachable)("item passport: grade, checks, IMEI history, grade filter (integration)", () => {
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

  async function liveListing(extra: Partial<typeof listings.$inferInsert> = {}, seller = SELLER) {
    const [row] = await db
      .insert(listings)
      .values({
        sellerUserId: await userId(seller),
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
    storageDir = mkdtempSync(join(tmpdir(), "ishonch-passport-"));
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
    for (const tg of [SELLER, BUYER, SELLER2]) {
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

  it("the stored grade (generated column) always equals computeGrade()", async () => {
    const lists: ConditionChecklist[] = [
      {},
      { batteryPct: 90 },
      { batteryPct: 84 },
      { batteryPct: 79 },
      { repairs: ["none"] },
      { repairs: ["screen", "battery"] },
      { biometrics: "broken" },
      { deadPixels: "few" },
      { deadPixels: "many" },
      { mining: "yes" },
      { batteryPct: 82, repairs: ["back"], deadPixels: "few" },
    ];
    for (const condition of CONDITIONS) {
      for (const checklist of lists) {
        const l = await liveListing({ condition, checklist });
        const [row] = await db.select({ grade: listings.grade }).from(listings).where(eq(listings.id, l.id));
        expect([condition, checklist, row!.grade]).toEqual([condition, checklist, computeGrade(condition, checklist).grade]);
      }
    }
    const none = await liveListing({ condition: null });
    expect((await db.select({ grade: listings.grade }).from(listings).where(eq(listings.id, none.id)))[0]!.grade).toBeNull();
  });

  it("passport: grade with reasons, checks naming who confirmed them, history by IMEI without who sold it", async () => {
    const imei = "356938035643809";
    // The same phone sold earlier by someone else; the courier's inspection then passed.
    const earlier = await liveListing({ imei, status: "sold", soldAt: new Date(Date.now() - 60 * 864e5), publishedAt: new Date(Date.now() - 70 * 864e5), price: 5_200_000 }, SELLER2);
    const buyer = await userId(BUYER);
    await db.insert(orders).values({
      listingId: earlier.id,
      buyerUserId: buyer,
      sellerUserId: earlier.sellerUserId,
      mode: "cod_seller",
      status: "delivered",
      district: "chilonzor",
      address: "x",
      quote: {},
      feePayer: "buyer",
      inspection: { checks: { screen: true }, passed: true, note: null, at: new Date().toISOString() },
    });
    const l = await liveListing({
      imei,
      condition: "like_new",
      checklist: { accountUnlocked: true, batteryPct: 82, repairs: ["none"], kit: ["box", "charger"] },
    });

    const item = await get<CatalogItem>(BUYER, `/catalog/${l.id}`);
    const p = item.passport!;
    expect(item.listing.grade).toBe("B");
    expect(p).toMatchObject({ grade: "B", reasons: ["battery_worn"] });
    const check = (code: string) => p.checks.find((c) => c.code === code);
    expect(check("inspection")).toMatchObject({ status: "unknown", source: "courier" });
    expect(check("imei")).toMatchObject({ status: "ok", source: "ishonch" });
    expect(check("account")).toMatchObject({ status: "ok", source: "seller" });
    expect(check("battery")).toMatchObject({ status: "ok", params: { pct: 82 } });
    expect(check("repairs")).toMatchObject({ status: "ok" });
    expect(check("photos")).toMatchObject({ status: "warn", params: { n: 0 } });
    expect(check("documents")).toMatchObject({ status: "ok" });
    expect(p.total).toBe(p.checks.length);
    expect(p.passed).toBe(p.checks.filter((c) => c.status === "ok").length);
    expect(p.history).toEqual({
      listings: 1,
      sold: 1,
      prices: [{ at: earlier.publishedAt!.toISOString(), price: 5_200_000 }],
      inspections: { passed: 1, failed: 0 },
    });
    expect(JSON.stringify(p.history)).not.toContain(earlier.sellerUserId);

    // A live listing of the same IMEI by another seller makes the IMEI check fail.
    await liveListing({ imei }, SELLER2);
    expect((await get<CatalogItem>(BUYER, `/catalog/${l.id}`)).passport!.checks.find((c) => c.code === "imei")!.status).toBe("fail");
  });

  it("checks follow the category: a monitor has no IMEI or account; no checklist → 'not stated', not failed", async () => {
    const monitor = await liveListing({ category: "monitor", condition: "good", checklist: { deadPixels: "few" }, attributes: { modelKey: null, specs: [] } });
    const p = (await get<CatalogItem>(BUYER, `/catalog/${monitor.id}`)).passport!;
    expect(p.grade).toBe("B");
    expect(p.checks.map((c) => c.code)).toEqual(["inspection", "repairs", "photos", "price", "documents"]);
    expect(p.checks.find((c) => c.code === "repairs")!.status).toBe("unknown");
    expect(p.checks.find((c) => c.code === "price")!.status).toBe("unknown");
    expect(p.history).toBeNull();
  });

  it("catalog filter «Класс A–B» and the seller's tip to confirm the account is unlinked", async () => {
    const good = await liveListing({ titleRu: "Passport filter A", condition: "like_new", checklist: { batteryPct: 95 } });
    const worn = await liveListing({ titleRu: "Passport filter C", condition: "like_new", checklist: { batteryPct: 70 } });
    const page = await get<CatalogPage>(BUYER, "/catalog?goodGrade=true&q=Passport%20filter");
    const ids = page.items.map((i) => i.listing.id);
    expect(ids).toContain(good.id);
    expect(ids).not.toContain(worn.id);
    expect(page.items.every((i) => i.listing.grade === "A" || i.listing.grade === "B")).toBe(true);

    const tips = (await get<ListingInsights>(SELLER, `/listings/${good.id}/insights`)).tips.map((t) => t.code);
    expect(tips).toContain("no_account_check");
    await db.update(listings).set({ checklist: { batteryPct: 95, accountUnlocked: true } }).where(eq(listings.id, good.id));
    expect((await get<ListingInsights>(SELLER, `/listings/${good.id}/insights`)).tips.map((t) => t.code)).not.toContain("no_account_check");
  });
});
