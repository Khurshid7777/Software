import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { eq, sql as dsql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { MeetingDto } from "@ishonch/shared";
import { buildApp } from "../src/app.js";
import { buildInitData } from "../src/auth/telegram.js";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { listings, meetings, priceReference } from "../src/db/schema.js";
import type { CourierProvider } from "../src/modules/orders/courier.js";
import { FsStorage } from "../src/storage/storage.js";
import type { ChannelPublisher, Notifier, NotifyButton } from "../src/telegram/publisher.js";
import { mockAiByPrompt } from "./helpers.js";

const url = process.env.TEST_DATABASE_URL ?? "postgres://ishonch:ishonch@localhost:5432/ishonch";
const reachable = await postgres(url, { max: 1, connect_timeout: 2 })`select 1`
  .then(() => true)
  .catch(() => false);

const BOT_TOKEN = "123456:TEST";
const SELLER = 990_210_001;
const BUYER = 990_210_002;
const OPERATOR = 990_210_003;
const ADMIN = 990_210_004;
const LIKER = 990_210_005;
const ALL = [SELLER, BUYER, OPERATOR, ADMIN, LIKER];
const MODERATORS = -100_990_210;
// A model of our own, so the price reference of other tests and seeds does not matter.
const MODEL = "testbrand phone x21 128gb";

describe.skipIf(!reachable)("safe conversations: block, report, no-shows (integration)", () => {
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
    storageDir = mkdtempSync(join(tmpdir(), "ishonch-safety-"));
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

  const contact = (who: number, listingId: string, text: string) => post(who, `/listings/${listingId}/contact`, { text });
  const asBot = (who: number, path: string, payload: object = {}) => app.inject({ method: "POST", url: path, headers: internal(who), payload });
  const noonTomorrow = () => {
    const d = new Date(Date.now() + 864e5);
    d.setUTCHours(7, 0, 0, 0);
    return d.toISOString();
  };

  it("block: the blocked side can neither write nor ask to meet; the owner sees and lifts the block", async () => {
    const l = await liveListing();
    const first = await contact(BUYER, l.id, "Здравствуйте, ещё продаёте?");
    expect(first.statusCode).toBe(200);
    const conv = first.json().conversationId as string;
    const dm = dmsTo(SELLER).at(-1)!;
    expect(callbacks(dm)).toEqual(expect.arrayContaining([`rep:${conv}`, `blk:${conv}`]));

    expect((await asBot(OPERATOR, `/internal/conversations/${conv}/block`)).statusCode).toBe(404); // not a participant
    expect((await asBot(SELLER, `/internal/conversations/${conv}/block`)).json()).toEqual({ ok: true });
    const blocked = await contact(BUYER, l.id, "Ответьте пожалуйста");
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().message).toContain("недоступна");
    // The blocker cannot write either (no one-sided harassment through the block).
    expect((await asBot(SELLER, `/internal/conversations/${conv}/messages`, { text: "привет" })).statusCode).toBe(403);
    expect((await post(BUYER, `/listings/${l.id}/meetings`, { spot: "compass", at: noonTomorrow() })).json().error).toBe("blocked");

    const blocks = await get<Array<{ userId: string; title: string; role: string }>>(SELLER, "/me/blocks");
    expect(blocks).toEqual([expect.objectContaining({ userId: await userId(BUYER), title: "Testbrand X7 128 ГБ", role: "buyer" })]);
    await app.inject({ method: "DELETE", url: `/me/blocks/${await userId(BUYER)}`, headers: tma(SELLER) });
    expect((await contact(BUYER, l.id, "Снова здравствуйте")).statusCode).toBe(200);
  });

  it("report: moderators get the case with the last messages; the admin sees counts on the user card", async () => {
    const l = await liveListing();
    const conv = (await contact(BUYER, l.id, "Сколько последняя цена?")).json().conversationId as string;
    await asBot(SELLER, `/internal/conversations/${conv}/messages`, { text: "Переведите 500 000 предоплату на карту" });
    expect((await asBot(BUYER, `/internal/conversations/${conv}/report`, { reason: "nonsense" })).statusCode).toBe(400);
    expect((await asBot(BUYER, `/internal/conversations/${conv}/report`, { reason: "prepayment" })).json()).toMatchObject({ duplicate: false });
    expect((await asBot(BUYER, `/internal/conversations/${conv}/report`, { reason: "prepayment" })).json()).toMatchObject({ duplicate: true });
    expect(dmsTo(MODERATORS).at(-1)!.text).toContain("Жалоба на переписку: продавца");

    expect((await app.inject({ url: "/admin/chat-reports", headers: tma(BUYER) })).statusCode).toBe(403);
    const reports = await get<Array<{ id: number; reason: string; reported: { role: string; reports: number }; messages: Array<{ from: string; text: string }> }>>(
      ADMIN,
      "/admin/chat-reports",
    );
    const r = reports.find((x) => x.reason === "prepayment")!;
    expect(r.reported).toMatchObject({ role: "seller", reports: 1 });
    expect(r.messages.map((m) => m.from)).toEqual(["buyer", "seller"]);
    expect(r.messages[1]!.text).toContain("предоплату");
    const card = await get<{ chatReports: number }>(ADMIN, `/admin/users?telegramId=${SELLER}`);
    expect(card.chatReports).toBe(1);
    expect((await post(ADMIN, `/admin/chat-reports/${r.id}/resolve`, { resolution: "warned" })).json()).toEqual({ ok: true });
    expect((await get<Array<{ id: number }>>(ADMIN, "/admin/chat-reports")).some((x) => x.id === r.id)).toBe(false);
  });

  it("no-shows: the buyer reports a seller who did not come, the seller a buyer who did not; admins see the count", async () => {
    const [a, b] = [await liveListing(), await liveListing()];
    const ma = (await post(BUYER, `/listings/${a.id}/meetings`, { spot: "compass", at: noonTomorrow() })).json() as MeetingDto;
    const mb = (await post(BUYER, `/listings/${b.id}/meetings`, { spot: "riviera", at: noonTomorrow() })).json() as MeetingDto;
    for (const m of [ma, mb]) await post(SELLER, `/meetings/${m.id}/accept`);
    expect((await post(SELLER, `/meetings/${ma.id}/no_show`)).json().error).toBe("bad_state"); // not yet
    await db.execute(dsql`update meetings set at = now() - interval '1 hour' where id in (${ma.id}, ${mb.id})`);
    expect((await post(SELLER, `/meetings/${ma.id}/no_show`)).json()).toMatchObject({ status: "buyer_no_show" });
    expect((await post(BUYER, `/meetings/${mb.id}/report`, { bought: false, noShow: true })).json()).toMatchObject({ status: "seller_no_show" });
    expect((await get<{ noShows: number }>(ADMIN, `/admin/users?telegramId=${BUYER}`)).noShows).toBe(1);
    expect((await get<{ noShows: number }>(ADMIN, `/admin/users?telegramId=${SELLER}`)).noShows).toBe(1);
  });
});
