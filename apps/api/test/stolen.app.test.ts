import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { eq, sql as dsql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { isValidImei, type CatalogItem } from "@ishonch/shared";
import { buildApp } from "../src/app.js";
import { buildInitData } from "../src/auth/telegram.js";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { listings } from "../src/db/schema.js";
import { FsStorage } from "../src/storage/storage.js";
import { mockAiByPrompt } from "./helpers.js";

const url = process.env.TEST_DATABASE_URL ?? "postgres://ishonch:ishonch@localhost:5432/ishonch";
const reachable = await postgres(url, { max: 1, connect_timeout: 2 })`select 1`
  .then(() => true)
  .catch(() => false);

const BOT_TOKEN = "123456:TEST";
const OWNER = 979_000_001; // reports the phone
const SELLER = 979_000_002;
const BUYER = 979_000_003;
const ADMIN = 979_000_004;
const NO_PHONE = 979_000_005;
const ALL = [OWNER, SELLER, BUYER, ADMIN, NO_PHONE];
const IMEI = "356100112233448";
const OTHER = ["356200223344553", "356300334455668", "356400445566773"];

describe.skipIf(!reachable)("«Украли телефон»: owner-reported IMEIs (integration)", () => {
  let app: FastifyInstance;
  let close: () => Promise<unknown>;
  let db: ReturnType<typeof createDb>["db"];
  let storageDir: string;
  const tma = (id: number) => ({ authorization: `tma ${buildInitData({ id, language_code: "ru" }, BOT_TOKEN)}` });
  const internal = (id: number) => ({ authorization: "Internal internal-secret", "x-telegram-user": JSON.stringify({ id, language_code: "ru" }) });
  const userId = async (tg: number) => (await app.inject({ url: "/me", headers: tma(tg) })).json().id as string;
  const report = (who: number, imei: string, extra: object = {}) =>
    app.inject({ method: "POST", url: "/me/stolen", headers: tma(who), payload: { imei, kind: "stolen", ...extra } });
  const fetchRow = async (id: string) => (await db.select().from(listings).where(eq(listings.id, id)))[0]!;
  const card = async (id: string) => (await app.inject({ url: `/catalog/${id}`, headers: tma(BUYER) })).json() as CatalogItem;

  async function liveListing(seller: number, imei: string) {
    const [row] = await db
      .insert(listings)
      .values({
        sellerUserId: await userId(seller),
        category: "smartphone",
        titleRu: "iPhone 15 128 ГБ",
        titleUz: "iPhone 15 128 GB",
        descriptionRu: "Как новый",
        descriptionUz: "Yangidek",
        attributes: { modelKey: "apple iphone 15 128gb", specs: [] },
        condition: "good",
        price: 9_000_000,
        imei,
        district: "yunusobod",
        allowedDeliveryModes: ["delivery_only"],
        feePayer: "buyer",
        status: "active",
        publishedAt: new Date(),
        bumpedAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 864e5),
      })
      .returning();
    return row!;
  }

  beforeAll(async () => {
    for (const x of [IMEI, ...OTHER]) expect(isValidImei(x)).toBe(true);
    storageDir = mkdtempSync(join(tmpdir(), "ishonch-stolen-"));
    const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: url, BOT_TOKEN, INTERNAL_API_TOKEN: "internal-secret", ADMIN_TELEGRAM_IDS: String(ADMIN) } as NodeJS.ProcessEnv);
    const created = createDb(url);
    db = created.db;
    close = () => created.sql.end();
    const ai = mockAiByPrompt({ listing_moderate: { decision: "approved", reasons: [], seller_message_ru: "", seller_message_uz: "" } });
    app = await buildApp({ config, db, ai, storage: new FsStorage(storageDir), publisher: null });
  });
  beforeEach(async () => {
    await db.execute(dsql.raw(`delete from users where telegram_id in (${ALL.join(",")})`));
    await db.execute(dsql`update listings set imei = null where imei in (${IMEI}, ${OTHER[0]!}, ${OTHER[1]!}, ${OTHER[2]!})`);
    for (const tg of [OWNER, SELLER, BUYER]) {
      await app.inject({ method: "POST", url: "/internal/phone", headers: internal(tg), payload: { phone: `+99890${String(tg).slice(-7)}` } });
    }
  });
  afterAll(async () => {
    await db.execute(dsql.raw(`delete from users where telegram_id in (${ALL.join(",")})`));
    await app.close();
    await close();
    rmSync(storageDir, { recursive: true, force: true });
  });

  it("a report sends live listings with the IMEI to a moderator; approval sticks; «Нашёлся» clears the passport", async () => {
    const l = await liveListing(SELLER, IMEI);
    const res = await report(OWNER, IMEI, { policeReport: "№ 123/45" });
    expect(res.statusCode).toBe(200);
    expect(res.json().held).toBe(1);
    const held = await fetchRow(l.id);
    expect(held.status).toBe("pending");
    expect(held.moderationReason).toBe("imei_listed");
    expect(JSON.stringify(held.moderation)).toContain("Владелец сообщил");
    // The owner sees the report without the full IMEI.
    const mine = (await app.inject({ url: "/me/stolen", headers: tma(OWNER) })).json();
    expect(mine).toEqual([expect.objectContaining({ imeiTail: "3448", kind: "stolen", policeReport: "№ 123/45" })]);
    expect(JSON.stringify(mine)).not.toContain(IMEI);

    // A moderator lets it through (say, the seller showed the receipt): edits don't send it back.
    expect((await app.inject({ method: "POST", url: `/admin/listings/${l.id}/moderate`, headers: tma(ADMIN), payload: { decision: "approve" } })).statusCode).toBe(200);
    await app.inject({ method: "PATCH", url: `/listings/${l.id}`, headers: tma(SELLER), payload: { descriptionRu: "Как новый, чек есть" } });
    expect((await fetchRow(l.id)).status).toBe("active");
    expect((await card(l.id)).passport!.checks.find((c) => c.code === "imei_registry")?.status).toBe("fail");

    // «Нашёлся»: the passport line goes, and a new listing with the IMEI stays live.
    const [r] = mine as Array<{ id: number }>;
    expect((await app.inject({ method: "DELETE", url: `/me/stolen/${r!.id}`, headers: tma(OWNER) })).statusCode).toBe(200);
    expect((await fetchRow(l.id)).imeiRegistry).toBeNull();
    expect((await card(l.id)).passport!.checks.map((c) => c.code)).not.toContain("imei_registry");
    expect((await app.inject({ url: "/me/stolen", headers: tma(OWNER) })).json()).toEqual([]);
  });

  it("checks: valid IMEI, a phone on the account, no duplicates, at most 3 open; own listings untouched", async () => {
    expect((await report(OWNER, "356100112233449")).statusCode).toBe(400);
    expect((await report(NO_PHONE, IMEI)).statusCode).toBe(409);
    const own = await liveListing(OWNER, IMEI);
    expect((await report(OWNER, IMEI)).json().held).toBe(0);
    expect((await fetchRow(own.id)).status).toBe("active");
    expect((await report(OWNER, IMEI)).statusCode).toBe(409);
    expect((await report(OWNER, OTHER[0]!)).statusCode).toBe(200);
    expect((await report(OWNER, OTHER[1]!)).statusCode).toBe(200);
    const fourth = await report(OWNER, OTHER[2]!);
    expect(fourth.statusCode).toBe(409);
    expect(fourth.json().message).toContain("3");
    // Someone else's report reaches a listing published later, too.
    const later = await liveListing(SELLER, OTHER[0]!);
    await app.inject({ method: "PATCH", url: `/listings/${later.id}`, headers: tma(SELLER), payload: { descriptionRu: "Новый текст объявления" } });
    expect((await fetchRow(later.id)).status).toBe("pending");
  });
});
