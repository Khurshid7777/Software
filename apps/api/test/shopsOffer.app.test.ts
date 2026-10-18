import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { eq, sql as dsql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ListingDto } from "@ishonch/shared";
import { buildApp } from "../src/app.js";
import { buildInitData } from "../src/auth/telegram.js";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { listings, shops, userBlocks } from "../src/db/schema.js";
import { FsStorage } from "../src/storage/storage.js";
import type { ChannelPublisher, Notifier, NotifyButton } from "../src/telegram/publisher.js";
import { mockAiByPrompt } from "./helpers.js";

const url = process.env.TEST_DATABASE_URL ?? "postgres://ishonch:ishonch@localhost:5432/ishonch";
const reachable = await postgres(url, { max: 1, connect_timeout: 2 })`select 1`
  .then(() => true)
  .catch(() => false);

const BOT_TOKEN = "123456:TEST";
const SELLER = 976_000_001;
const SHOP = 976_000_002; // verified: gets the request
const BLOCKED_SHOP = 976_000_003; // verified, but the seller blocked it
const NEW_SHOP = 976_000_004; // not verified yet
const QUIET_SHOP = 976_000_005; // verified, switched the requests off
const STRANGER = 976_000_006;
const ALL = [SELLER, SHOP, BLOCKED_SHOP, NEW_SHOP, QUIET_SHOP, STRANGER];

describe.skipIf(!reachable)("«Предложить магазинам» (integration)", () => {
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
  const dmsTo = (tg: number) => dms.filter((d) => d.chatId === tg);
  const buttons = (d: { buttons: NotifyButton[][] }) => d.buttons.flat().map((b) => ("callbackData" in b ? b.callbackData : b.url));

  async function shopOf(tg: number, verified: boolean, name: string) {
    await db.insert(shops).values({ ownerUserId: await userId(tg), name, verified, verifiedAt: verified ? new Date() : null });
  }

  async function liveListing() {
    const [row] = await db
      .insert(listings)
      .values({
        sellerUserId: await userId(SELLER),
        category: "smartphone",
        titleRu: "iPhone 12 64 ГБ",
        titleUz: "iPhone 12 64 GB",
        descriptionRu: "Рабочий, без ремонта",
        descriptionUz: "Ishlaydi, ta'mirlanmagan",
        attributes: { modelKey: "apple iphone 12 64gb", specs: [] },
        condition: "good",
        price: 4_500_000,
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
    storageDir = mkdtempSync(join(tmpdir(), "ishonch-shops-offer-"));
    const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: url, BOT_TOKEN, INTERNAL_API_TOKEN: "internal-secret" } as NodeJS.ProcessEnv);
    const created = createDb(url);
    db = created.db;
    close = () => created.sql.end();
    app = await buildApp({ config, db, ai: mockAiByPrompt({}), storage: new FsStorage(storageDir), publisher: gateway });
  });
  beforeEach(async () => {
    dms.length = 0;
    await db.execute(dsql.raw(`delete from users where telegram_id in (${ALL.join(",")})`));
    await shopOf(SHOP, true, "Malika Mobile");
    await shopOf(BLOCKED_SHOP, true, "Blocked Store");
    await shopOf(NEW_SHOP, false, "New Store");
    await shopOf(QUIET_SHOP, true, "Quiet Store");
    await db.insert(userBlocks).values({ blockerUserId: await userId(SELLER), blockedUserId: await userId(BLOCKED_SHOP) });
    await app.inject({ method: "PATCH", url: "/me/notifications", headers: tma(QUIET_SHOP), payload: { type: "shops_request", on: false } });
  });
  afterAll(async () => {
    await db.execute(dsql.raw(`delete from users where telegram_id in (${ALL.join(",")})`));
    await app.close();
    await close();
    rmSync(storageDir, { recursive: true, force: true });
  });

  it("verified shops get the request once a week; blocked, unverified and switched-off ones don't", async () => {
    const l = await liveListing();
    expect((await post(STRANGER, `/listings/${l.id}/offer-shops`)).statusCode).toBe(403);

    const res = await post(SELLER, `/listings/${l.id}/offer-shops`);
    expect(res.statusCode).toBe(200);
    expect(res.json().sent).toBeGreaterThanOrEqual(1); // other verified shops in the shared database count too
    const [msg] = dmsTo(SHOP);
    expect(msg!.text).toContain("iPhone 12 64 ГБ");
    expect(msg!.text).toContain("4 500 000");
    expect(buttons(msg!)).toEqual([`https://t.me/ishonch_bot/app?startapp=listing_${l.id}`, "unsub:shops_request"]);
    for (const tg of [BLOCKED_SHOP, NEW_SHOP, QUIET_SHOP, SELLER]) expect(dmsTo(tg)).toHaveLength(0);

    // A second tap within the week is refused with the reason; the owner sees when it was sent.
    const again = await post(SELLER, `/listings/${l.id}/offer-shops`);
    expect(again.statusCode).toBe(409);
    expect(again.json().message).toContain("7 дней");
    const mine = (await app.inject({ url: "/listings/mine", headers: tma(SELLER) })).json() as ListingDto[] | { items: ListingDto[] };
    const dto = (Array.isArray(mine) ? mine : mine.items).find((x) => x.id === l.id)!;
    expect(dto.shopsOfferAt).toBeTruthy();

    // A week later it can be sent again.
    await db.update(listings).set({ shopsOfferAt: new Date(Date.now() - 8 * 864e5) }).where(eq(listings.id, l.id));
    expect((await post(SELLER, `/listings/${l.id}/offer-shops`)).statusCode).toBe(200);
  });

  it("a shop answers with an ordinary offer, and the seller sees it comes from a verified shop", async () => {
    const l = await liveListing();
    await post(SELLER, `/listings/${l.id}/offer-shops`);
    dms.length = 0;
    expect((await post(SHOP, `/listings/${l.id}/offers`, { amount: 3_800_000 })).statusCode).toBe(200);
    const [toSeller] = dmsTo(SELLER);
    expect(toSeller!.text).toContain("3 800 000");
    expect(toSeller!.text).toContain("проверенный магазин «Malika Mobile»");
    expect(buttons(toSeller!).some((b) => b.startsWith("offer:accept:"))).toBe(true);

    // A private buyer's offer carries no shop line.
    dms.length = 0;
    expect((await post(STRANGER, `/listings/${l.id}/offers`, { amount: 4_000_000 })).statusCode).toBe(200);
    expect(dmsTo(SELLER)[0]!.text).not.toContain("магазин");
  });
});
