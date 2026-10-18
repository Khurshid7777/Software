import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { eq, sql as dsql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ListingInsights } from "@ishonch/shared";
import { buildApp } from "../src/app.js";
import { buildInitData } from "../src/auth/telegram.js";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { listings } from "../src/db/schema.js";
import { FsStorage } from "../src/storage/storage.js";
import type { ChannelPublisher, Notifier, NotifyButton } from "../src/telegram/publisher.js";
import { mockAiByPrompt } from "./helpers.js";

const url = process.env.TEST_DATABASE_URL ?? "postgres://ishonch:ishonch@localhost:5432/ishonch";
const reachable = await postgres(url, { max: 1, connect_timeout: 2 })`select 1`
  .then(() => true)
  .catch(() => false);

const BOT_TOKEN = "123456:TEST";
const SELLER = 977_000_001;
const FITS = 977_000_002; // searches for it at this price
const CHEAPER = 977_000_003; // searches for it, but up to 4.6 M
const OTHER = 977_000_004; // searches for something else
const FAN = 977_000_005; // saved the same model elsewhere
const ALL = [SELLER, FITS, CHEAPER, OTHER, FAN];
const MODEL = "demandphone z9 128gb";

describe.skipIf(!reachable)("«Спрос»: who is looking for the seller's item (integration)", () => {
  let app: FastifyInstance;
  let close: () => Promise<unknown>;
  let db: ReturnType<typeof createDb>["db"];
  let storageDir: string;
  const dms: Array<{ chatId: number; text: string; buttons: NotifyButton[][] }> = [];
  const gateway: ChannelPublisher & Notifier = {
    post: async () => ({ messageId: 1 }),
    miniAppLink: async (p) => `https://t.me/ishonch_bot/app?startapp=${p}`,
    send: async (chatId, text, buttons = []) => void dms.push({ chatId, text, buttons }),
  };
  const tma = (id: number) => ({ authorization: `tma ${buildInitData({ id, language_code: "ru" }, BOT_TOKEN)}` });
  const userId = async (tg: number) => (await app.inject({ url: "/me", headers: tma(tg) })).json().id as string;
  const post = (who: number, path: string, payload: object = {}) => app.inject({ method: "POST", url: path, headers: tma(who), payload });
  const insights = async (id: string) => (await app.inject({ url: `/listings/${id}/insights`, headers: tma(SELLER) })).json() as ListingInsights;

  async function live(seller: number, price: number) {
    const [row] = await db
      .insert(listings)
      .values({
        sellerUserId: await userId(seller),
        category: "smartphone",
        titleRu: "Demandphone Z9 128 ГБ",
        titleUz: "Demandphone Z9 128 GB",
        descriptionRu: "Рабочий",
        descriptionUz: "Ishlaydi",
        attributes: { modelKey: MODEL, specs: [] },
        condition: "good",
        price,
        district: "chilonzor",
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
    storageDir = mkdtempSync(join(tmpdir(), "ishonch-demand-"));
    const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: url, BOT_TOKEN, INTERNAL_API_TOKEN: "internal-secret" } as NodeJS.ProcessEnv);
    const created = createDb(url);
    db = created.db;
    close = () => created.sql.end();
    app = await buildApp({ config, db, ai: mockAiByPrompt({}), storage: new FsStorage(storageDir), publisher: gateway });
  });
  beforeEach(async () => {
    dms.length = 0;
    await db.execute(dsql.raw(`delete from users where telegram_id in (${ALL.join(",")})`));
  });
  afterAll(async () => {
    await db.execute(dsql.raw(`delete from users where telegram_id in (${ALL.join(",")})`));
    await app.close();
    await close();
    rmSync(storageDir, { recursive: true, force: true });
  });

  it("counts matching saved searches with and without their price cap, and fans of the model", async () => {
    const l = await live(SELLER, 5_000_000);
    expect((await post(FITS, "/searches", { q: "demandphone z9", priceMax: 6_000_000 })).statusCode).toBe(200);
    expect((await post(CHEAPER, "/searches", { q: "demandphone z9", priceMax: 4_600_000 })).statusCode).toBe(200);
    expect((await post(CHEAPER, "/searches", { q: "demandphone", priceMax: 4_200_000 })).statusCode).toBe(200);
    expect((await post(OTHER, "/searches", { q: "galaxy s23" })).statusCode).toBe(200);
    const elsewhere = await live(OTHER, 4_900_000);
    await post(FAN, `/favorites/${elsewhere.id}`);

    const before = await insights(l.id);
    expect(before.demand).toEqual({ searching: 1, cheaper: 1, cheaperMax: 4_600_000, modelFavorites: 1 });
    const tip = before.tips.find((x) => x.code === "searchers_cheaper");
    expect(tip?.params).toEqual({ n: 1, max: "4 600 000 UZS" });

    // The seller meets the cap: the waiting buyer hears about it, and the tip is gone.
    expect((await app.inject({ method: "PATCH", url: `/listings/${l.id}`, headers: tma(SELLER), payload: { price: 4_500_000 } })).statusCode).toBe(200);
    expect(dms.filter((d) => d.chatId === CHEAPER).some((d) => d.text.includes("4 500 000"))).toBe(true);
    const after = await insights(l.id);
    expect(after.demand).toMatchObject({ searching: 2, cheaper: 0, cheaperMax: null });
    expect(after.tips.map((x) => x.code)).not.toContain("searchers_cheaper");
  });
});
