import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { eq, sql as dsql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { CatalogItem, CatalogPage } from "@ishonch/shared";
import { buildApp } from "../src/app.js";
import { buildInitData } from "../src/auth/telegram.js";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { listings, users } from "../src/db/schema.js";
import { FsStorage } from "../src/storage/storage.js";
import { mockAiByPrompt } from "./helpers.js";

const url = process.env.TEST_DATABASE_URL ?? "postgres://ishonch:ishonch@localhost:5432/ishonch";
const reachable = await postgres(url, { max: 1, connect_timeout: 2 })`select 1`
  .then(() => true)
  .catch(() => false);

const BOT_TOKEN = "123456:TEST";
const SELLER = 980_000_001;
const BUYER = 980_000_002;
const ALL = [SELLER, BUYER];

describe.skipIf(!reachable)("«В отъезде»: seller away mode (integration)", () => {
  let app: FastifyInstance;
  let close: () => Promise<unknown>;
  let db: ReturnType<typeof createDb>["db"];
  let storageDir: string;
  const tma = (id: number) => ({ authorization: `tma ${buildInitData({ id, language_code: "ru" }, BOT_TOKEN)}` });
  const userId = async (tg: number) => (await app.inject({ url: "/me", headers: tma(tg) })).json().id as string;
  const away = (until: string | null) => app.inject({ method: "PUT", url: "/me/away", headers: tma(SELLER), payload: { until } });
  const fetchRow = async (id: string) => (await db.select().from(listings).where(eq(listings.id, id)))[0]!;
  const search = async () => ((await app.inject({ url: "/catalog?q=awayphone", headers: tma(BUYER) })).json() as CatalogPage).items.map((i) => i.listing.id);

  async function liveListing() {
    const [row] = await db
      .insert(listings)
      .values({
        sellerUserId: await userId(SELLER),
        category: "smartphone",
        titleRu: "Awayphone A1 64 ГБ",
        titleUz: "Awayphone A1 64 GB",
        descriptionRu: "Рабочий",
        descriptionUz: "Ishlaydi",
        attributes: { modelKey: "awayphone a1 64gb", specs: [] },
        condition: "good",
        price: 2_000_000,
        district: "chilonzor",
        allowedDeliveryModes: ["delivery_only"],
        feePayer: "buyer",
        status: "active",
        publishedAt: new Date(),
        bumpedAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 864e5),
        autoDropFloor: 1_500_000,
        autoDropAt: new Date(Date.now() - 60_000),
      })
      .returning();
    return row!;
  }

  beforeAll(async () => {
    storageDir = mkdtempSync(join(tmpdir(), "ishonch-away-"));
    const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: url, BOT_TOKEN, INTERNAL_API_TOKEN: "internal-secret" } as NodeJS.ProcessEnv);
    const created = createDb(url);
    db = created.db;
    close = () => created.sql.end();
    app = await buildApp({ config, db, ai: mockAiByPrompt({}), storage: new FsStorage(storageDir), publisher: null });
  });
  beforeEach(async () => {
    await db.execute(dsql.raw(`delete from users where telegram_id in (${ALL.join(",")})`));
  });
  afterAll(async () => {
    await db.execute(dsql.raw(`delete from users where telegram_id in (${ALL.join(",")})`));
    await app.close();
    await close();
    rmSync(storageDir, { recursive: true, force: true });
  });

  it("while away: hidden from the catalog, no offers or meetings, no price drops; back — all returns", async () => {
    const l = await liveListing();
    expect(await search()).toContain(l.id);
    expect((await away(new Date(Date.now() - 864e5).toISOString())).statusCode).toBe(400);
    expect((await away(new Date(Date.now() + 31 * 864e5).toISOString())).statusCode).toBe(400);
    const until = new Date(Date.now() + 7 * 864e5).toISOString();
    expect((await away(until)).json()).toEqual({ awayUntil: until });
    expect((await app.inject({ url: "/me", headers: tma(SELLER) })).json().awayUntil).toBe(until);

    expect(await search()).not.toContain(l.id);
    const item = (await app.inject({ url: `/catalog/${l.id}`, headers: tma(BUYER) })).json() as CatalogItem;
    expect(item.listing.seller!.awayUntil).toBe(until);
    const offer = await app.inject({ method: "POST", url: `/listings/${l.id}/offers`, headers: tma(BUYER), payload: { amount: 1_800_000 } });
    expect(offer.statusCode).toBe(409);
    expect(offer.json().message).toContain("в отъезде");
    const at = new Date(Date.now() + 2 * 864e5);
    at.setUTCHours(9, 0, 0, 0); // 14:00 Tashkent
    const meet = await app.inject({ method: "POST", url: `/listings/${l.id}/meetings`, headers: tma(BUYER), payload: { spot: "compass", at: at.toISOString() } });
    expect(meet.statusCode).toBe(409);
    await app.services.listings.runAutoDrops();
    expect((await fetchRow(l.id)).price).toBe(2_000_000);

    expect((await away(null)).json()).toEqual({ awayUntil: null });
    expect(await search()).toContain(l.id);
    expect((await app.inject({ method: "POST", url: `/listings/${l.id}/offers`, headers: tma(BUYER), payload: { amount: 1_800_000 } })).statusCode).toBe(200);
    await app.services.listings.runAutoDrops();
    expect((await fetchRow(l.id)).price).toBeLessThan(2_000_000);
  });

  it("away mode ends by itself", async () => {
    const l = await liveListing();
    await away(new Date(Date.now() + 864e5).toISOString());
    expect(await search()).not.toContain(l.id);
    await db.update(users).set({ awayUntil: new Date(Date.now() - 1000) }).where(eq(users.telegramId, SELLER));
    expect(await search()).toContain(l.id);
    expect((await app.inject({ url: "/me", headers: tma(SELLER) })).json().awayUntil).toBeNull();
  });
});
