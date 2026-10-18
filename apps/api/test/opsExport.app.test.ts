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
import { listings, orders } from "../src/db/schema.js";
import type { ChannelPublisher, Notifier } from "../src/telegram/publisher.js";
import { FsStorage } from "../src/storage/storage.js";
import { mockAiByPrompt } from "./helpers.js";

const url = process.env.TEST_DATABASE_URL ?? "postgres://ishonch:ishonch@localhost:5432/ishonch";
const reachable = await postgres(url, { max: 1, connect_timeout: 2 })`select 1`
  .then(() => true)
  .catch(() => false);

const BOT_TOKEN = "123456:TEST";
const SELLER = 981_000_001;
const BUYER = 981_000_002;
const ALL = [SELLER, BUYER];

describe.skipIf(!reachable)("«Скачать мои данные» and /metrics (integration)", () => {
  let app: FastifyInstance;
  let close: () => Promise<unknown>;
  let db: ReturnType<typeof createDb>["db"];
  let storageDir: string;
  const files: Array<{ chatId: number; name: string; data: Buffer }> = [];
  const gateway: ChannelPublisher & Notifier = {
    post: async () => ({ messageId: 1 }),
    miniAppLink: async (p) => `https://t.me/ishonch_bot/app?startapp=${p}`,
    send: async () => undefined,
    sendDocument: async (chatId, file) => void files.push({ chatId, ...file }),
  };
  const tma = (id: number) => ({ authorization: `tma ${buildInitData({ id, language_code: "ru" }, BOT_TOKEN)}` });
  const internal = (id: number) => ({ authorization: "Internal internal-secret", "x-telegram-user": JSON.stringify({ id, language_code: "ru" }) });
  const userId = async (tg: number) => (await app.inject({ url: "/me", headers: tma(tg) })).json().id as string;

  beforeAll(async () => {
    storageDir = mkdtempSync(join(tmpdir(), "ishonch-export-"));
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: url,
      BOT_TOKEN,
      INTERNAL_API_TOKEN: "internal-secret",
      METRICS_TOKEN: "scrape-secret",
    } as NodeJS.ProcessEnv);
    const created = createDb(url);
    db = created.db;
    close = () => created.sql.end();
    app = await buildApp({ config, db, ai: mockAiByPrompt({}), storage: new FsStorage(storageDir), publisher: gateway });
  });
  beforeEach(async () => {
    files.length = 0;
    await db.execute(dsql.raw(`delete from users where telegram_id in (${ALL.join(",")})`));
  });
  afterAll(async () => {
    await db.execute(dsql.raw(`delete from users where telegram_id in (${ALL.join(",")})`));
    await app.close();
    await close();
    rmSync(storageDir, { recursive: true, force: true });
  });

  it("the bot sends one JSON file a day with the person's own data; a seller's copy has no buyer address", async () => {
    await app.inject({ method: "POST", url: "/internal/phone", headers: internal(BUYER), payload: { phone: "+998901112233" } });
    const sellerId = await userId(SELLER);
    const buyerId = await userId(BUYER);
    const [l] = await db
      .insert(listings)
      .values({
        sellerUserId: sellerId,
        category: "smartphone",
        titleRu: "Exportphone E1",
        titleUz: "Exportphone E1",
        descriptionRu: "Рабочий",
        descriptionUz: "Ishlaydi",
        attributes: {},
        price: 1_000_000,
        allowedDeliveryModes: ["delivery_only"],
        feePayer: "buyer",
        status: "active",
      })
      .returning();
    await db.insert(orders).values({
      listingId: l!.id,
      buyerUserId: buyerId,
      sellerUserId: sellerId,
      mode: "delivery_only",
      district: "chilonzor",
      address: "Bunyodkor 1, kv 5",
      quote: {},
      feePayer: "buyer",
    });
    await app.inject({ method: "POST", url: "/searches", headers: tma(BUYER), payload: { q: "exportphone" } });

    expect((await app.inject({ method: "POST", url: "/me/export", headers: tma(BUYER) })).statusCode).toBe(200);
    const [file] = files;
    expect(file!.chatId).toBe(BUYER);
    expect(file!.name).toMatch(/^ishonch-data-\d{4}-\d{2}-\d{2}\.json$/);
    const data = JSON.parse(file!.data.toString());
    expect(data.profile).toMatchObject({ id: buyerId, phone: "+998901112233" });
    expect(data.orders).toEqual([expect.objectContaining({ role: "buyer", address: "Bunyodkor 1, kv 5" })]);
    expect(data.savedSearches).toHaveLength(1);

    // Once a day.
    const again = await app.inject({ method: "POST", url: "/me/export", headers: tma(BUYER) });
    expect(again.statusCode).toBe(429);
    expect(again.json().message).toContain("раз в день");

    await app.inject({ method: "POST", url: "/me/export", headers: tma(SELLER) });
    const seller = JSON.parse(files.at(-1)!.data.toString());
    expect(seller.listings.map((x: { titleRu: string }) => x.titleRu)).toEqual(["Exportphone E1"]);
    expect(seller.orders).toEqual([expect.objectContaining({ role: "seller" })]);
    expect(JSON.stringify(seller)).not.toContain("Bunyodkor");
    expect(JSON.stringify(seller)).not.toContain("+998901112233");
  });

  it("/metrics: hidden without the token; counts requests by route pattern, not by URL", async () => {
    await app.inject({ url: `/catalog/${"0".repeat(8)}-0000-0000-0000-000000000000` });
    await app.inject({ url: `/catalog/${"1".repeat(8)}-0000-0000-0000-000000000000` });
    expect((await app.inject({ url: "/metrics" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/metrics", headers: { authorization: "Bearer wrong" } })).statusCode).toBe(404);
    const res = await app.inject({ url: "/metrics", headers: { authorization: "Bearer scrape-secret" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    const line = res.body.split("\n").find((x) => x.startsWith('ishonch_http_requests_total{method="GET",route="/catalog/:id",status="404"}'));
    expect(Number(line?.split(" ").at(-1))).toBeGreaterThanOrEqual(2);
    expect(res.body).toMatch(/ishonch_jobs\{state="due"\} \d+/);
    expect(res.body).not.toContain("00000000-0000");
  });
});
