import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { eq, sql as dsql, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { CatalogPage, OrderDto } from "@ishonch/shared";
import { buildApp } from "../src/app.js";
import { buildInitData } from "../src/auth/telegram.js";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { botPendingReplies, complaints, conversations, listings, orders, users } from "../src/db/schema.js";
import { FsStorage } from "../src/storage/storage.js";
import type { ChannelPost, ChannelPublisher, Notifier } from "../src/telegram/publisher.js";
import { mockAiByPrompt } from "./helpers.js";

/** Regression tests for the bugs found in the full review (one block per finding). */
const url = process.env.TEST_DATABASE_URL ?? "postgres://ishonch:ishonch@localhost:5432/ishonch";
const reachable = await postgres(url, { max: 1, connect_timeout: 2 })`select 1`
  .then(() => true)
  .catch(() => false);

const BOT_TOKEN = "123456:TEST";
const SELLER = 950_000_001;
const BUYER = 950_000_002;
const OTHER = 950_000_003;
const ADMIN = 950_000_004;
const ADMIN2 = 950_000_005;
const C = [950_000_011, 950_000_012, 950_000_013];
const ALL = [SELLER, BUYER, OTHER, ADMIN, ADMIN2, ...C];

describe.skipIf(!reachable)("review regressions (integration)", () => {
  let app: FastifyInstance;
  let close: () => Promise<unknown>;
  let db: ReturnType<typeof createDb>["db"];
  const dms: Array<{ chatId: number; text: string }> = [];
  const posts: ChannelPost[] = [];
  const gateway: ChannelPublisher & Notifier = {
    post: async (_c, p) => (posts.push(p), { messageId: posts.length }),
    miniAppLink: async (p) => `https://t.me/x/app?startapp=${p}`,
    send: async (chatId, text) => void dms.push({ chatId, text }),
  };
  const ai = mockAiByPrompt({
    listing_moderate: { decision: "approved", reasons: [], seller_message_ru: "", seller_message_uz: "" },
    assistant_compare: { summary: "ok", verdicts: [] },
  });
  const tma = (id: number) => ({ authorization: `tma ${buildInitData({ id, language_code: "ru" }, BOT_TOKEN)}` });
  const internal = (id: number) => ({ authorization: "Internal internal-secret", "x-telegram-user": JSON.stringify({ id, language_code: "ru" }) });
  const userId = async (tg: number) => (await app.inject({ url: "/me", headers: tma(tg) })).json().id as string;
  const status = async (id: string) => (await db.select().from(listings).where(eq(listings.id, id)))[0]!.status;

  async function live(seller: number, extra: Partial<typeof listings.$inferInsert> = {}) {
    const [row] = await db
      .insert(listings)
      .values({
        sellerUserId: await userId(seller),
        category: "smartphone",
        titleRu: "Apple iPhone 13 128 ГБ",
        titleUz: "Apple iPhone 13 128 GB",
        descriptionRu: "Хорошее состояние",
        descriptionUz: "Yaxshi holat",
        price: 5_000_000,
        district: "chilonzor",
        status: "active",
        publishedAt: new Date(),
        bumpedAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 864e5),
        ...extra,
      })
      .returning();
    return row!;
  }
  const order = (who: number, listingId: string) =>
    app.inject({ method: "POST", url: "/orders", headers: tma(who), payload: { listingId, mode: "cod_seller", district: "yunusobod", address: "Amir Temur 1" } });

  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: url,
      BOT_TOKEN,
      INTERNAL_API_TOKEN: "internal-secret",
      ADMIN_TELEGRAM_IDS: `${ADMIN},${ADMIN2}`,
    } as NodeJS.ProcessEnv);
    const created = createDb(url);
    db = created.db;
    close = () => created.sql.end();
    app = await buildApp({ config, db, ai, storage: new FsStorage("/tmp/ishonch-regressions"), publisher: gateway });
    await db.execute(dsql`update listings set status = 'archived' where status in ('active', 'pending', 'reserved')`);
  });

  beforeEach(async () => {
    dms.length = 0;
    posts.length = 0;
    await db.execute(dsql.raw(`delete from users where telegram_id in (${ALL.join(",")})`));
    for (const tg of [SELLER, BUYER, OTHER]) {
      await app.inject({ method: "POST", url: "/internal/phone", headers: internal(tg), payload: { phone: `+99890${String(tg).slice(-7)}` } });
    }
  });

  afterAll(async () => {
    await db.execute(dsql.raw(`delete from users where telegram_id in (${ALL.join(",")})`));
    await app.close();
    await close();
  });

  it("compare and favorites never expose drafts or hidden listings of others", async () => {
    const draft = await live(SELLER, { status: "draft", titleRu: "Черновик" });
    const pub = await live(SELLER);
    const res = await app.inject({ method: "POST", url: "/assistant/compare", headers: tma(OTHER), payload: { ids: [draft.id, pub.id] } });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain("Черновик");
    expect((await app.inject({ method: "POST", url: `/favorites/${draft.id}`, headers: tma(OTHER) })).statusCode).toBe(404);
  });

  it("malformed ids are 404, not 500", async () => {
    for (const [method, path] of [
      ["POST", "/favorites/abc"],
      ["POST", "/listings/abc/contact"],
      ["DELETE", "/searches/abc"],
      ["GET", "/photos/abc?s=x"],
      ["DELETE", "/channels/abc"],
    ] as const) {
      const r = await app.inject({ method, url: path, headers: tma(OTHER), payload: method === "POST" ? { text: "hi" } : undefined });
      expect(r.statusCode, path).toBeLessThan(500);
    }
  });

  it("a listing that leaves sale closes its pending delivery requests and tells the buyer", async () => {
    const l = await live(SELLER);
    const o = (await order(BUYER, l.id)).json() as OrderDto;
    await app.inject({ method: "POST", url: `/listings/${l.id}/sold`, headers: tma(SELLER), payload: { via: "elsewhere" } });
    const [row] = await db.select().from(orders).where(eq(orders.id, o.id));
    expect(row!.status).toBe("cancelled");
    expect(row!.cancelReason).toBe("listing_unavailable");
    expect(dms.some((d) => d.text.includes("больше не продаётся"))).toBe(true);
  });

  it("requests the seller ignores for 48 h are cancelled", async () => {
    const l = await live(SELLER);
    const o = (await order(BUYER, l.id)).json() as OrderDto;
    await db.update(orders).set({ createdAt: new Date(Date.now() - 49 * 3600_000) }).where(eq(orders.id, o.id));
    expect(await app.services.orders.expireStale()).toBeGreaterThanOrEqual(1);
    expect((await db.select().from(orders).where(eq(orders.id, o.id)))[0]!.cancelReason).toBe("seller_timeout");
  });

  it("archive → republish cannot escape a complaint hide", async () => {
    const l = await live(SELLER, { aiDraft: {} });
    for (const c of C) await app.inject({ url: "/me", headers: tma(c) });
    await db.update(users).set({ createdAt: new Date(Date.now() - 10 * 864e5), phone: "+998901112233" }).where(inArray(users.telegramId, C));
    for (const c of C) await app.inject({ method: "POST", url: `/listings/${l.id}/complaints`, headers: tma(c), payload: { reason: "scam" } });
    expect(await status(l.id)).toBe("pending");
    await app.inject({ method: "POST", url: `/listings/${l.id}/archive`, headers: tma(SELLER) });
    // A photo is required to publish.
    await db.execute(dsql`insert into listing_photos (listing_id, storage_key, phash) values (${l.id}, 'x.jpg', '0f0f0f0f0f0f0f0f')`);
    const re = await app.inject({ method: "POST", url: `/listings/${l.id}/publish`, headers: tma(SELLER), payload: {} });
    expect(re.json().moderation).toBe("needs_review");
    expect(await status(l.id)).toBe("pending");
    const open = await db.select().from(complaints).where(eq(complaints.listingId, l.id));
    expect(open.every((c) => c.resolvedAt === null)).toBe(true);
  });

  it("two moderators approving at once activate once; a hidden listing keeps its expiry", async () => {
    const expiresAt = new Date(Date.now() + 10 * 864e5);
    const l = await live(SELLER, { status: "pending", expiresAt, moderation: { decision: "needs_review", source: "complaints", reasons: [], pendingChannelIds: [], at: "" } });
    const [a, b] = await Promise.all([
      app.inject({ method: "POST", url: `/admin/listings/${l.id}/moderate`, headers: tma(ADMIN), payload: { decision: "approve" } }),
      app.inject({ method: "POST", url: `/admin/listings/${l.id}/moderate`, headers: tma(ADMIN2), payload: { decision: "approve" } }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const [row] = await db.select().from(listings).where(eq(listings.id, l.id));
    expect(row!.status).toBe("active");
    expect(row!.expiresAt!.getTime()).toBe(expiresAt.getTime());
  });

  it("live listings are not regenerated wholesale; reserved ones keep their text and price", async () => {
    const l = await live(SELLER, { aiDraft: { analysis: {} } });
    expect((await app.inject({ method: "POST", url: `/listings/${l.id}/generate`, headers: tma(SELLER), payload: {} })).statusCode).toBe(409);
    const o = (await order(BUYER, l.id)).json() as OrderDto;
    await app.inject({ method: "POST", url: `/orders/${o.id}/confirm`, headers: tma(SELLER) });
    const edit = await app.inject({ method: "PATCH", url: `/listings/${l.id}`, headers: tma(SELLER), payload: { price: 1_000 } });
    expect(edit.json().error).toBe("bad_state");
    const nullPrice = await app.inject({ method: "PATCH", url: `/listings/${(await live(SELLER)).id}`, headers: tma(SELLER), payload: { price: null } });
    expect(nullPrice.json().error).toBe("fill_required");
  });

  it("an account with open orders cannot be deleted", async () => {
    const l = await live(SELLER);
    await order(BUYER, l.id);
    const del = await app.inject({ method: "DELETE", url: "/me", headers: tma(BUYER) });
    expect(del.statusCode).toBe(409);
    expect(del.json().error).toBe("open_orders");
  });

  it("staff role is removed when the id leaves the env list", async () => {
    const id = await userId(OTHER);
    await db.update(users).set({ role: "admin" }).where(eq(users.id, id));
    expect((await app.inject({ url: "/me", headers: tma(OTHER) })).json().role).toBe("buyer");
    expect((await app.inject({ url: "/me", headers: tma(ADMIN) })).json().role).toBe("admin");
  });

  it("orders CSV neutralises spreadsheet formulas", async () => {
    const l = await live(SELLER, { titleRu: "=HYPERLINK(\"http://x\")" });
    await order(BUYER, l.id);
    const csv = (await app.inject({ url: "/admin/reports/orders.csv?days=1", headers: tma(ADMIN) })).body;
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(csv).not.toMatch(/;=HYPERLINK/);
  });

  it("search does not mix other model numbers into results", async () => {
    const l13 = await live(SELLER);
    const l10 = await live(SELLER, { titleRu: "Apple iPhone 10 64 ГБ", titleUz: "Apple iPhone 10 64 GB" });
    const page = (await app.inject({ url: "/catalog?q=iphone%2013&sort=newest" })).json() as CatalogPage;
    const ids = page.items.map((i) => i.listing.id);
    expect(ids).toContain(l13.id);
    expect(ids).not.toContain(l10.id);
  });

  it("banned users browse anonymously (no staff powers, no views)", async () => {
    const id = await userId(ADMIN);
    const draft = await live(SELLER, { status: "draft" });
    await db.update(users).set({ bannedAt: new Date() }).where(eq(users.id, id));
    expect((await app.inject({ url: `/listings/${draft.id}`, headers: tma(ADMIN) })).statusCode).toBe(404);
  });

  it("bot reply state: only participants, taken once, expiry reported", async () => {
    const l = await live(SELLER);
    const [conv] = await db
      .insert(conversations)
      .values({ listingId: l.id, buyerUserId: await userId(BUYER), sellerUserId: l.sellerUserId })
      .returning();
    const set = (tg: number) =>
      app.inject({ method: "POST", url: "/internal/pending-reply", headers: internal(tg), payload: { conversationId: conv!.id } });
    const take = (tg: number) => app.inject({ method: "POST", url: "/internal/pending-reply/take", headers: internal(tg) });
    expect((await set(OTHER)).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/internal/pending-reply", headers: tma(SELLER), payload: { conversationId: conv!.id } })).statusCode).toBe(403);
    expect((await set(SELLER)).statusCode).toBe(200);
    expect((await take(SELLER)).json()).toEqual({ conversationId: conv!.id });
    expect((await take(SELLER)).json()).toEqual({});
    await set(BUYER);
    await db.update(botPendingReplies).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(botPendingReplies.telegramUserId, BUYER));
    expect((await take(BUYER)).json()).toEqual({ expired: true });
  });
});
