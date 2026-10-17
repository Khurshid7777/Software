import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { eq, sql as dsql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AdminMetrics, MeetingDto } from "@ishonch/shared";
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
const SELLER = 990_230_001;
const BUYER = 990_230_002;
const OPERATOR = 990_230_003;
const ADMIN = 990_230_004;
const LIKER = 990_230_005;
const ALL = [SELLER, BUYER, OPERATOR, ADMIN, LIKER];
const MODERATORS = -100_990_230;
// A model of our own, so the price reference of other tests and seeds does not matter.
const MODEL = "testbrand phone x23 128gb";

describe.skipIf(!reachable)("search misses and the meeting funnel (integration)", () => {
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
    storageDir = mkdtempSync(join(tmpdir(), "ishonch-funnels-"));
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

  it("searches without results are listed for admins and in the morning digest; meetings form a funnel", async () => {
    const miss = `zzqx${Date.now() % 100000}`;
    for (const who of [BUYER, SELLER]) await get(who, `/catalog?q=${miss}`);
    await get(BUYER, `/catalog?q=${miss.toUpperCase()}`); // the same query, other case
    const m = await get<AdminMetrics>(ADMIN, "/admin/metrics?days=1");
    expect(m.searchMisses.find((x) => x.q === miss)).toEqual({ q: miss, count: 3, users: 2 });

    const l = await liveListing();
    await post(BUYER, `/listings/${l.id}/contact`, { text: "Здравствуйте, можно посмотреть?" });
    const at = new Date(Date.now() + 864e5);
    at.setUTCHours(7, 0, 0, 0);
    const meet = (await post(BUYER, `/listings/${l.id}/meetings`, { spot: "compass", at: at.toISOString() })).json() as MeetingDto;
    await post(SELLER, `/meetings/${meet.id}/accept`);
    const after = await get<AdminMetrics>(ADMIN, "/admin/metrics?days=1");
    expect(after.meetingFunnel.map((s) => s.step)).toEqual(["buyer_contacted_seller", "meeting_requested", "meeting_accepted", "meeting_bought"]);
    expect(after.meetingFunnel[1]!.users).toBeGreaterThanOrEqual(1);
    expect(after.meetingFunnel[2]!.users).toBeGreaterThanOrEqual(1);

    // The digest covers yesterday: move today's misses one day back.
    await db.execute(dsql`update events set created_at = created_at - interval '1 day' where name = 'catalog_search' and props->>'q' ilike ${miss}`);
    expect(await app.services.metrics.digest()).toContain(`«${miss}» ×3`);
  });
});
