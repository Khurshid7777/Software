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
import { listings, priceReference } from "../src/db/schema.js";
import { FsStorage } from "../src/storage/storage.js";
import type { ChannelPublisher, Notifier, NotifyButton } from "../src/telegram/publisher.js";
import { mockAiByPrompt } from "./helpers.js";

const url = process.env.TEST_DATABASE_URL ?? "postgres://ishonch:ishonch@localhost:5432/ishonch";
const reachable = await postgres(url, { max: 1, connect_timeout: 2 })`select 1`
  .then(() => true)
  .catch(() => false);

const BOT_TOKEN = "123456:TEST";
const SELLER = 982_000_001;
const BUYER = 982_000_002;
const ALL = [SELLER, BUYER];
const MODEL = "marketphone m3 128gb";

describe.skipIf(!reachable)("saved search «ниже рынка» (integration)", () => {
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
  const price = (id: string, p: number) => app.inject({ method: "PATCH", url: `/listings/${id}`, headers: tma(SELLER), payload: { price: p } });

  beforeAll(async () => {
    storageDir = mkdtempSync(join(tmpdir(), "ishonch-below-market-"));
    const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: url, BOT_TOKEN, INTERNAL_API_TOKEN: "internal-secret" } as NodeJS.ProcessEnv);
    const created = createDb(url);
    db = created.db;
    close = () => created.sql.end();
    app = await buildApp({ config, db, ai: mockAiByPrompt({}), storage: new FsStorage(storageDir), publisher: gateway });
    await db.delete(priceReference).where(eq(priceReference.modelKey, MODEL));
    await db.insert(priceReference).values({ modelKey: MODEL, priceMin: 4_500_000, priceMedian: 5_000_000, priceMax: 5_500_000 });
  });
  beforeEach(async () => {
    dms.length = 0;
    await db.execute(dsql.raw(`delete from users where telegram_id in (${ALL.join(",")})`));
  });
  afterAll(async () => {
    await db.execute(dsql.raw(`delete from users where telegram_id in (${ALL.join(",")})`));
    await db.delete(priceReference).where(eq(priceReference.modelKey, MODEL));
    await app.close();
    await close();
    rmSync(storageDir, { recursive: true, force: true });
  });

  it("alerts only once the item is the chosen share below the model's market price", async () => {
    const s = (await app.inject({ method: "POST", url: "/searches", headers: tma(BUYER), payload: { q: "marketphone" } })).json() as { id: number };
    const set = await app.inject({ method: "PATCH", url: `/searches/${s.id}`, headers: tma(BUYER), payload: { belowMarketPct: 20 } });
    expect(set.statusCode).toBe(200);
    expect(set.json().title).toContain("ниже рынка на 20%");
    expect((await app.inject({ method: "PATCH", url: `/searches/${s.id}`, headers: tma(BUYER), payload: { belowMarketPct: 33 } })).statusCode).toBe(400);

    const [l] = await db
      .insert(listings)
      .values({
        sellerUserId: await userId(SELLER),
        category: "smartphone",
        titleRu: "Marketphone M3 128 ГБ",
        titleUz: "Marketphone M3 128 GB",
        descriptionRu: "Рабочий",
        descriptionUz: "Ishlaydi",
        attributes: { modelKey: MODEL, specs: [] },
        condition: "good",
        price: 4_800_000,
        district: "chilonzor",
        allowedDeliveryModes: ["delivery_only"],
        feePayer: "buyer",
        status: "active",
        publishedAt: new Date(),
        bumpedAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 864e5),
      })
      .returning();
    // 4.4 M is 12 % below the 5 M median: not enough for a 20 % search.
    await price(l!.id, 4_400_000);
    expect(dms.filter((d) => d.chatId === BUYER)).toHaveLength(0);
    // The seller's «Спрос» counts that buyer as waiting for a lower price: up to 4 M.
    const insights = (await app.inject({ url: `/listings/${l!.id}/insights`, headers: tma(SELLER) })).json();
    expect(insights.demand).toMatchObject({ searching: 0, cheaper: 1, cheaperMax: 4_000_000 });
    // 3.9 M is 22 % below: the buyer hears about it.
    await price(l!.id, 3_900_000);
    expect(dms.filter((d) => d.chatId === BUYER).some((d) => d.text.includes("3 900 000"))).toBe(true);

    // Off again: the title loses the note.
    const off = await app.inject({ method: "PATCH", url: `/searches/${s.id}`, headers: tma(BUYER), payload: { belowMarketPct: null } });
    expect(off.json().filters.belowMarketPct).toBeUndefined();
    expect(off.json().title).not.toContain("рынка");
  });
});
