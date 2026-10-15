import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { eq, sql as dsql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { CatalogItem, ListingInsights, ListingSeller, TrustLevel } from "@ishonch/shared";
import { buildApp } from "../src/app.js";
import { buildInitData } from "../src/auth/telegram.js";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { listings, users } from "../src/db/schema.js";
import type { CourierProvider } from "../src/modules/orders/courier.js";
import { FsStorage } from "../src/storage/storage.js";
import type { ChannelPublisher, Notifier } from "../src/telegram/publisher.js";
import { mockAiByPrompt } from "./helpers.js";

const url = process.env.TEST_DATABASE_URL ?? "postgres://ishonch:ishonch@localhost:5432/ishonch";
const reachable = await postgres(url, { max: 1, connect_timeout: 2 })`select 1`
  .then(() => true)
  .catch(() => false);

const BOT_TOKEN = "123456:TEST";
const SELLER = 970_000_001;
const BUYER = 970_000_002;
const SELLER2 = 970_000_003;
const ALL = [SELLER, BUYER, SELLER2];

describe.skipIf(!reachable)("similar listings, recently viewed, seller page, seller insights (integration)", () => {
  let app: FastifyInstance;
  let close: () => Promise<unknown>;
  let db: ReturnType<typeof createDb>["db"];
  let storageDir: string;
  const ai = mockAiByPrompt({ listing_moderate: { decision: "approved", reasons: [], seller_message_ru: "", seller_message_uz: "" } });
  const gateway: ChannelPublisher & Notifier = {
    post: async () => ({ messageId: 1 }),
    miniAppLink: async (p) => `https://t.me/ishonch_bot/app?startapp=${p}`,
    send: async () => undefined,
  };
  const courier: CourierProvider = { name: "manual", createShipment: async () => ({ externalId: null }), cancelShipment: async () => undefined };
  const tma = (id: number) => ({ authorization: `tma ${buildInitData({ id, language_code: "ru" }, BOT_TOKEN)}` });
  const userId = async (tg: number) => (await app.inject({ url: "/me", headers: tma(tg) })).json().id as string;
  const get = async <T>(url: string, who = BUYER) => (await app.inject({ url, headers: tma(who) })).json() as T;

  async function live(seller: number, extra: Partial<typeof listings.$inferInsert> = {}) {
    const [row] = await db
      .insert(listings)
      .values({
        sellerUserId: await userId(seller),
        category: "smartphone",
        titleRu: "Телефон",
        titleUz: "Telefon",
        descriptionRu: "Коротко",
        descriptionUz: "Qisqa",
        attributes: { modelKey: "testphone z9 64gb", specs: [] },
        condition: "good",
        price: 2_000_000,
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
    storageDir = mkdtempSync(join(tmpdir(), "ishonch-discovery-"));
    const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: url, BOT_TOKEN, INTERNAL_API_TOKEN: "internal-secret" } as NodeJS.ProcessEnv);
    const created = createDb(url);
    db = created.db;
    close = () => created.sql.end();
    app = await buildApp({ config, db, ai, storage: new FsStorage(storageDir), publisher: gateway, courier });
  });
  beforeEach(async () => {
    await db.execute(dsql`update listings set status = 'archived' where status in ('active', 'pending', 'reserved')`);
    await db.execute(dsql.raw(`delete from users where telegram_id in (${ALL.join(",")})`));
  });
  afterAll(async () => {
    await db.execute(dsql.raw(`delete from users where telegram_id in (${ALL.join(",")})`));
    await app.close();
    await close();
    rmSync(storageDir, { recursive: true, force: true });
  });

  it("similar: same category and price band, the same model first, never itself or inactive ones", async () => {
    const base = await live(SELLER, { price: 2_000_000 });
    const sameModel = await live(SELLER2, { price: 2_900_000 });
    const otherModel = await live(SELLER2, { price: 2_050_000, attributes: { modelKey: "otherbrand q1 32gb", specs: [] } });
    await live(SELLER2, { price: 9_000_000 }); // outside the price band
    await live(SELLER2, { category: "laptop" }); // another category
    await live(SELLER2, { status: "sold" });
    const ids = (await get<CatalogItem[]>(`/catalog/${base.id}/similar`)).map((i) => i.listing.id);
    expect(ids).toEqual([sameModel.id, otherModel.id]);
    expect((await app.inject({ url: "/catalog/not-a-uuid/similar" })).statusCode).toBe(404);
  });

  it("batch (recently viewed): keeps the order, skips what is no longer for sale", async () => {
    const a = await live(SELLER);
    const b = await live(SELLER2);
    const gone = await live(SELLER2, { status: "sold" });
    const draft = await live(SELLER2, { status: "draft" });
    const ids = (await get<CatalogItem[]>(`/catalog/batch?ids=${[b.id, gone.id, "junk", a.id, draft.id].join(",")}`)).map((i) => i.listing.id);
    expect(ids).toEqual([b.id, a.id]);
  });

  it("seller page: public facts and live listings only; a banned seller has no page", async () => {
    const mine = await live(SELLER);
    await live(SELLER, { status: "sold" });
    const page = await get<{ seller: ListingSeller; trust: TrustLevel; items: CatalogItem[] }>(`/sellers/${await userId(SELLER)}/page`);
    expect(page.seller.id).toBe(await userId(SELLER));
    expect(page.items.map((i) => i.listing.id)).toEqual([mine.id]);
    expect(["high", "medium", "low"]).toContain(page.trust);
    await db.update(users).set({ bannedAt: new Date() }).where(eq(users.telegramId, SELLER));
    expect((await app.inject({ url: `/sellers/${await userId(SELLER2)}/page` })).statusCode).toBe(200);
    const bannedId = (await db.select().from(users).where(eq(users.telegramId, SELLER)))[0]!.id;
    expect((await app.inject({ url: `/sellers/${bannedId}/page` })).statusCode).toBe(404);
  });

  it("insights: owner only; price vs market, favorites without requests, photos, checklist, IMEI, COD", async () => {
    for (const p of [2_000_000, 2_100_000, 1_900_000]) await live(SELLER2, { price: p, attributes: { modelKey: "rarephone x7 64gb", specs: [] } });
    const l = await live(SELLER, {
      price: 3_000_000,
      attributes: { modelKey: "rarephone x7 64gb", specs: [] },
      favoritesCount: 4,
      allowedDeliveryModes: ["delivery_only"],
    });
    expect((await app.inject({ url: `/listings/${l.id}/insights`, headers: tma(BUYER) })).statusCode).toBe(404);
    const res = await get<ListingInsights>(`/listings/${l.id}/insights`, SELLER);
    // The model's market median (the catalog's own listings, this one included) is ~2 M: +40…50 %.
    expect(res.market!.median).toBeGreaterThanOrEqual(2_000_000);
    expect(res.market!.median).toBeLessThanOrEqual(2_100_000);
    expect(res.market!.diffPct).toBeGreaterThanOrEqual(40);
    const codes = res.tips.map((x) => x.code);
    expect(codes.slice(0, 2)).toEqual(["price_above_market", "favorites_no_requests"]);
    expect(codes).toEqual(expect.arrayContaining(["few_photos", "short_description", "no_checklist", "no_imei", "no_cod"]));
    expect(res.stats).toMatchObject({ favorites: 4, requests: 0, daysOnSale: 1 });

    // A well-filled listing at the market price gets no price / checklist / COD tips.
    await db
      .update(listings)
      .set({ price: 2_000_000, checklist: { batteryPct: 90 }, allowedDeliveryModes: ["delivery_only", "cod_seller"], favoritesCount: 0 })
      .where(eq(listings.id, l.id));
    const better = (await get<ListingInsights>(`/listings/${l.id}/insights`, SELLER)).tips.map((x) => x.code);
    expect(better).not.toContain("price_above_market");
    expect(better).not.toContain("no_checklist");
    expect(better).not.toContain("no_cod");
  });
});
