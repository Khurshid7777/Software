import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { eq, sql as dsql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { WantedRequest } from "@ishonch/shared";
import { buildApp } from "../src/app.js";
import { buildInitData } from "../src/auth/telegram.js";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { listings, userBlocks } from "../src/db/schema.js";
import { FsStorage } from "../src/storage/storage.js";
import type { ChannelPublisher, Notifier, NotifyButton } from "../src/telegram/publisher.js";
import { mockAiByPrompt } from "./helpers.js";

const url = process.env.TEST_DATABASE_URL ?? "postgres://ishonch:ishonch@localhost:5432/ishonch";
const reachable = await postgres(url, { max: 1, connect_timeout: 2 })`select 1`
  .then(() => true)
  .catch(() => false);

const BOT_TOKEN = "123456:TEST";
const SELLER = 978_000_001;
const BUYER = 978_000_002; // opens the search to sellers
const PRIVATE = 978_000_003; // keeps the search private
const BLOCKER = 978_000_004; // opened it, but blocked the seller
const OTHER_SELLER = 978_000_005;
const ALL = [SELLER, BUYER, PRIVATE, BLOCKER, OTHER_SELLER];

describe.skipIf(!reachable)("«Куплю»: buyers' requests answered by sellers (integration)", () => {
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
  const wanted = async (who: number) => (await app.inject({ url: "/wanted", headers: tma(who) })).json() as WantedRequest[];

  async function live(seller: number, title: string, price: number) {
    const [row] = await db
      .insert(listings)
      .values({
        sellerUserId: await userId(seller),
        category: "smartphone",
        titleRu: title,
        titleUz: title,
        descriptionRu: "Рабочий",
        descriptionUz: "Ishlaydi",
        attributes: { modelKey: title.toLowerCase(), specs: [] },
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
  async function search(who: number, q: string, priceMax: number, open: boolean) {
    const s = (await post(who, "/searches", { q, priceMax })).json() as { id: number };
    if (open) expect((await app.inject({ method: "PATCH", url: `/searches/${s.id}`, headers: tma(who), payload: { public: true } })).statusCode).toBe(200);
    return s.id;
  }

  beforeAll(async () => {
    storageDir = mkdtempSync(join(tmpdir(), "ishonch-wanted-"));
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

  it("sellers see open requests without names, with their own matching listings; the buyer gets the answer once", async () => {
    const fits = await live(SELLER, "Wantedphone Q5 256 ГБ", 3_000_000);
    await live(SELLER, "Othertab K1", 2_000_000);
    const open = await search(BUYER, "wantedphone q5", 3_500_000, true);
    await search(PRIVATE, "wantedphone q5", 3_500_000, false);
    const blocked = await search(BLOCKER, "wantedphone q5", 3_500_000, true);
    await db.insert(userBlocks).values({ blockerUserId: await userId(BLOCKER), blockedUserId: await userId(SELLER) });

    const list = (await wanted(SELLER)).filter((r) => [open, blocked].includes(r.id));
    expect(list).toHaveLength(1);
    const [r] = list;
    expect(r).toMatchObject({ id: open, priceMax: 3_500_000, matches: [{ id: fits.id, offered: false }] });
    expect(JSON.stringify(r)).not.toContain(await userId(BUYER));
    // The buyer doesn't see their own request.
    expect((await wanted(BUYER)).some((x) => x.id === open)).toBe(false);

    expect((await post(SELLER, `/wanted/${open}/offer`, { listingId: fits.id })).statusCode).toBe(200);
    const msg = dms.find((d) => d.chatId === BUYER)!;
    expect(msg.text).toContain("Wantedphone Q5 256 ГБ");
    expect(msg.text).toContain("3 000 000");
    expect(msg.buttons.flat().map((b) => ("callbackData" in b ? b.callbackData : b.url))).toContain("unsub:saved_search");
    expect((await wanted(SELLER)).find((x) => x.id === open)!.matches[0]!.offered).toBe(true);

    // The same listing twice, a listing that doesn't fit, someone else's listing, a blocked buyer: refused.
    expect((await post(SELLER, `/wanted/${open}/offer`, { listingId: fits.id })).statusCode).toBe(409);
    const tab = await live(SELLER, "Othertab K2", 2_000_000);
    expect((await post(SELLER, `/wanted/${open}/offer`, { listingId: tab.id })).statusCode).toBe(400);
    const foreign = await live(OTHER_SELLER, "Wantedphone Q5 128 ГБ", 2_500_000);
    expect((await post(SELLER, `/wanted/${open}/offer`, { listingId: foreign.id })).statusCode).toBe(404);
    expect((await post(SELLER, `/wanted/${blocked}/offer`, { listingId: fits.id })).statusCode).toBe(404);

    // Closing the request hides it.
    await app.inject({ method: "PATCH", url: `/searches/${open}`, headers: tma(BUYER), payload: { public: false } });
    expect((await wanted(OTHER_SELLER)).some((x) => x.id === open)).toBe(false);
  });

  it("a buyer gets at most 3 such messages a day", async () => {
    const open = await search(BUYER, "wantedphone", 9_000_000, true);
    for (let i = 0; i < 3; i++) {
      const l = await live(i % 2 ? SELLER : OTHER_SELLER, `Wantedphone R${i}`, 3_000_000 + i);
      expect((await post(i % 2 ? SELLER : OTHER_SELLER, `/wanted/${open}/offer`, { listingId: l.id })).statusCode).toBe(200);
    }
    const fourth = await live(SELLER, "Wantedphone R9", 3_100_000);
    const res = await post(SELLER, `/wanted/${open}/offer`, { listingId: fourth.id });
    expect(res.statusCode).toBe(429);
    expect(res.json().message).toContain("завтра");
  });
});
