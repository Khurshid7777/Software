import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { eq, sql as dsql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ListingSeller, MeetingDto } from "@ishonch/shared";
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
const SELLER = 990_190_001;
const BUYER = 990_190_002;
const OPERATOR = 990_190_003;
const ADMIN = 990_190_004;
const LIKER = 990_190_005;
const ALL = [SELLER, BUYER, OPERATOR, ADMIN, LIKER];
const MODERATORS = -100_990_190;
// A model of our own, so the price reference of other tests and seeds does not matter.
const MODEL = "testbrand phone x19 128gb";

describe.skipIf(!reachable)("meetings in person (integration)", () => {
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
    storageDir = mkdtempSync(join(tmpdir(), "ishonch-meet-"));
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

  /** Tomorrow 12:00 in Tashkent: always bookable (daytime, 7–31 hours ahead). */
  const noonTomorrow = () => {
    const d = new Date(Date.now() + 864e5);
    d.setUTCHours(7, 0, 0, 0);
    return d;
  };
  const meet = (who: number, listingId: string, body: object) => post(who, `/listings/${listingId}/meetings`, body);
  const act = (who: number, id: string, action: string, body: object = {}) => post(who, `/meetings/${id}/${action}`, body);

  it("request: daytime, ahead, a place; the seller gets bot buttons; one open request per item", async () => {
    const l = await liveListing();
    const at = noonTomorrow();
    expect((await meet(SELLER, l.id, { spot: "compass", at: at.toISOString() })).json().error).toBe("own_listing");
    const night = new Date(at);
    night.setUTCHours(17, 0, 0, 0); // 22:00 Tashkent
    const res = await meet(BUYER, l.id, { spot: "compass", at: night.toISOString() });
    expect(res.json()).toMatchObject({ error: "night" });
    expect(res.json().message).toContain("9:00");
    expect((await meet(BUYER, l.id, { spot: "compass", at: new Date(Date.now() + 10 * 60_000).toISOString() })).json().error).toBe("too_soon");
    expect((await meet(BUYER, l.id, { spot: "compass", at: new Date(Date.now() + 9 * 864e5).toISOString() })).json().error).toBe("too_far");
    expect((await meet(BUYER, l.id, { place: "тут", at: at.toISOString() })).json().error).toBe("bad_place");
    expect((await meet(BUYER, l.id, { spot: "somewhere", at: at.toISOString() })).statusCode).toBe(400);

    const ok = await meet(BUYER, l.id, { spot: "compass", at: at.toISOString(), note: "Посмотрю батарею" });
    expect(ok.statusCode).toBe(200);
    const m = ok.json() as MeetingDto;
    expect(m).toMatchObject({ role: "buyer", spot: "compass", status: "pending", actions: ["cancel"] });
    const [dm] = dmsTo(SELLER);
    expect(dm!.text).toContain("Compass");
    expect(dm!.text).toContain("12:00");
    expect(dm!.text).toContain("Посмотрю батарею");
    expect(callbacks(dm!)).toEqual([`meet:accept:${m.id}`, `meet:decline:${m.id}`]);
    expect((await meet(BUYER, l.id, { place: "Метро Минор, выход 1", at: at.toISOString() })).json().error).toBe("meeting_exists");
  });

  it("accept → reminder once → the buyer reports «bought», the seller confirms: sold, not counted as a platform sale", async () => {
    const l = await liveListing();
    const at = noonTomorrow();
    const m = (await meet(BUYER, l.id, { place: "Метро Минор, выход 1", at: at.toISOString() })).json() as MeetingDto;
    expect((await act(BUYER, m.id, "accept")).statusCode).toBe(404);
    const seen = (await get<MeetingDto[]>(SELLER, "/meetings")).find((x) => x.id === m.id)!;
    expect(seen).toMatchObject({ role: "seller", place: "Метро Минор, выход 1", actions: ["accept", "decline", "cancel"] });
    expect((await act(SELLER, m.id, "accept")).json()).toMatchObject({ status: "accepted" });
    expect((await act(SELLER, m.id, "accept")).json().error).toBe("bad_state");
    expect(dmsTo(BUYER).at(-1)!.text).toContain("согласен");

    // Reminders: not yet 3 hours before; once within 2 hours, to both.
    expect(await app.services.meetings.runMaintenance(new Date(at.getTime() - 3 * 36e5))).toBe(0);
    expect(await app.services.meetings.runMaintenance(new Date(at.getTime() - 90 * 60_000))).toBe(1);
    expect(await app.services.meetings.runMaintenance(new Date(at.getTime() - 60 * 60_000))).toBe(0);
    expect(dmsTo(BUYER).at(-1)!.text).toContain("Проверьте товар до оплаты");
    expect(dmsTo(SELLER).at(-1)!.text).toContain("Скоро встреча с покупателем");

    expect((await act(BUYER, m.id, "report", { bought: true })).json().error).toBe("bad_state"); // not yet
    await db.update(meetings).set({ at: new Date(Date.now() - 60_000) }).where(eq(meetings.id, m.id));
    expect((await get<MeetingDto[]>(BUYER, "/meetings")).find((x) => x.id === m.id)!.actions).toEqual(["cancel", "report"]);
    expect((await act(BUYER, m.id, "report", { bought: true })).json()).toMatchObject({ status: "bought" });
    // The buyer alone cannot close the listing: it stays on sale until the seller confirms.
    expect((await db.select().from(listings).where(eq(listings.id, l.id)))[0]!.status).toBe("active");
    const ask = dmsTo(SELLER).at(-1)!;
    expect(ask.text).toContain("снимите объявление");
    expect(callbacks(ask)).toEqual([`meet:sold:${m.id}`]);
    expect((await act(BUYER, m.id, "confirm_sold")).statusCode).toBe(404);
    expect((await get<MeetingDto[]>(SELLER, "/meetings")).find((x) => x.id === m.id)!.actions).toEqual(["confirm_sold"]);
    expect((await act(SELLER, m.id, "confirm_sold")).statusCode).toBe(200);
    const [row] = await db.select().from(listings).where(eq(listings.id, l.id));
    expect(row).toMatchObject({ status: "sold", soldVia: "platform" });
    expect((await act(SELLER, m.id, "confirm_sold")).json().error).toBe("not_available");
    const page = await get<{ seller: ListingSeller }>(BUYER, `/sellers/${l.sellerUserId}/page`);
    expect(page.seller.platformSales).toBe(0);
  });

  it("decline, cancel, and the item leaving sale call meetings off for both", async () => {
    const [a, b, c] = [await liveListing(), await liveListing(), await liveListing()];
    const at = noonTomorrow().toISOString();
    const ma = (await meet(BUYER, a.id, { spot: "malika", at })).json() as MeetingDto;
    expect((await act(SELLER, ma.id, "decline")).json()).toMatchObject({ status: "declined" });
    expect(dmsTo(BUYER).at(-1)!.text).toContain("не подходит");

    const mb = (await meet(BUYER, b.id, { spot: "riviera", at })).json() as MeetingDto;
    expect((await act(BUYER, mb.id, "cancel")).json()).toMatchObject({ status: "cancelled" });
    expect(dmsTo(SELLER).at(-1)!.text).toContain("отменена");

    const mc = (await meet(BUYER, c.id, { spot: "mega_planet", at })).json() as MeetingDto;
    await act(SELLER, mc.id, "accept");
    await post(SELLER, `/listings/${c.id}/archive`);
    expect((await get<MeetingDto[]>(BUYER, "/meetings")).find((x) => x.id === mc.id)!.status).toBe("cancelled");
    expect(dmsTo(BUYER).at(-1)!.text).toContain("больше не продаётся");

    // A request nobody answered before its time is over at the next hourly run.
    const d = await liveListing();
    const md = (await meet(BUYER, d.id, { spot: "compass", at })).json() as MeetingDto;
    await db.update(meetings).set({ at: new Date(Date.now() - 60_000) }).where(eq(meetings.id, md.id));
    await app.services.meetings.runMaintenance();
    expect((await get<MeetingDto[]>(BUYER, "/meetings")).find((x) => x.id === md.id)!.status).toBe("cancelled");
  });

  it("no more than 5 requests a day from one buyer", async () => {
    const at = noonTomorrow().toISOString();
    for (let i = 0; i < 5; i++) expect((await meet(BUYER, (await liveListing()).id, { spot: "compass", at })).statusCode).toBe(200);
    expect((await meet(BUYER, (await liveListing()).id, { spot: "compass", at })).json().error).toBe("too_many_meetings");
  });
});
