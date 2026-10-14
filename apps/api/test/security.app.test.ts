import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { eq, sql as dsql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { OrderDto } from "@ishonch/shared";
import { buildApp } from "../src/app.js";
import { buildInitData } from "../src/auth/telegram.js";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { conversationMessages, conversations, listings } from "../src/db/schema.js";
import { FsStorage } from "../src/storage/storage.js";
import { mockAiByPrompt } from "./helpers.js";

const url = process.env.TEST_DATABASE_URL ?? "postgres://ishonch:ishonch@localhost:5432/ishonch";
const reachable = await postgres(url, { max: 1, connect_timeout: 2 })`select 1`
  .then(() => true)
  .catch(() => false);

const BOT_TOKEN = "123456:TEST";
const SELLER = 960_000_001;
const BUYER = 960_000_002;
const OTHER = 960_000_003;
const ADMIN = 960_000_004;
const ALL = [SELLER, BUYER, OTHER, ADMIN];

describe.skipIf(!reachable)("rate limits, chat and order limits, audit, auth hardening (integration)", () => {
  let app: FastifyInstance;
  let close: () => Promise<unknown>;
  let db: ReturnType<typeof createDb>["db"];
  const tma = (id: number, authDate?: number) => ({
    authorization: `tma ${buildInitData({ id, language_code: "ru" }, BOT_TOKEN, authDate)}`,
  });
  const internal = (user: unknown) => ({ authorization: "Internal internal-secret", "x-telegram-user": JSON.stringify(user) });
  const userId = async (tg: number) => (await app.inject({ url: "/me", headers: tma(tg) })).json().id as string;

  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: url,
      BOT_TOKEN,
      INTERNAL_API_TOKEN: "internal-secret",
      ADMIN_TELEGRAM_IDS: String(ADMIN),
      RATE_LIMITS: "on",
    } as NodeJS.ProcessEnv);
    const created = createDb(url);
    db = created.db;
    close = () => created.sql.end();
    app = await buildApp({ config, db, ai: mockAiByPrompt({}), storage: new FsStorage("/tmp/ishonch-security"), publisher: null });
  });
  beforeEach(async () => {
    await db.execute(dsql.raw(`delete from users where telegram_id in (${ALL.join(",")})`));
  });
  afterAll(async () => {
    await db.execute(dsql.raw(`delete from users where telegram_id in (${ALL.join(",")})`));
    await app.close();
    await close();
  });

  it("AI routes are limited per Telegram user, not per IP", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await app.inject({ method: "POST", url: "/checks", headers: tma(BUYER), payload: {} })).statusCode);
    expect(codes.slice(0, 6).every((c) => c !== 429)).toBe(true);
    const limited = await app.inject({ method: "POST", url: "/checks", headers: tma(BUYER), payload: {} });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toBe("rate_limited");
    // Same IP, another user: not affected.
    expect((await app.inject({ method: "POST", url: "/checks", headers: tma(OTHER), payload: {} })).statusCode).not.toBe(429);
  });

  it("the bot may only assert a numeric Telegram id and a language", async () => {
    for (const bad of [{ id: "5" }, { id: -1 }, { id: 1.5 }, { name: "x" }]) {
      expect((await app.inject({ url: "/me", headers: internal(bad) })).statusCode).toBe(401);
    }
    expect((await app.inject({ url: "/me", headers: internal({ id: OTHER, language_code: "uz" }) })).statusCode).toBe(200);
  });

  it("a Mini App launch older than 4 hours is rejected", async () => {
    const old = Math.floor(Date.now() / 1000) - 5 * 3600;
    expect((await app.inject({ url: "/me", headers: tma(OTHER, old) })).statusCode).toBe(401);
    expect((await app.inject({ url: "/me", headers: tma(OTHER) })).statusCode).toBe(200);
  });

  it("one side cannot flood a conversation", async () => {
    const [l] = await db
      .insert(listings)
      .values({ sellerUserId: await userId(SELLER), titleRu: "T", titleUz: "T", status: "active", price: 1, expiresAt: new Date(Date.now() + 864e5) })
      .returning();
    const buyer = await userId(BUYER);
    const [conv] = await db.insert(conversations).values({ listingId: l!.id, buyerUserId: buyer, sellerUserId: l!.sellerUserId }).returning();
    await db.insert(conversationMessages).values(Array.from({ length: 30 }, () => ({ conversationId: conv!.id, senderUserId: buyer, text: "?" })));
    const res = await app.inject({ method: "POST", url: `/listings/${l!.id}/contact`, headers: tma(BUYER), payload: { text: "ещё" } });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe("message_limit");
  });

  it("order → cancel loops stop after 3 requests per item a day", async () => {
    const [l] = await db
      .insert(listings)
      .values({
        sellerUserId: await userId(SELLER),
        titleRu: "T",
        titleUz: "T",
        status: "active",
        price: 1_000_000,
        expiresAt: new Date(Date.now() + 864e5),
      })
      .returning();
    await app.inject({ method: "POST", url: "/internal/phone", headers: internal({ id: OTHER }), payload: { phone: "+998901110011" } });
    const body = { listingId: l!.id, mode: "delivery_only", district: "chilonzor", address: "Chilonzor 1" };
    for (let i = 0; i < 3; i++) {
      const o = (await app.inject({ method: "POST", url: "/orders", headers: tma(OTHER), payload: body })).json() as OrderDto;
      await app.inject({ method: "POST", url: `/orders/${o.id}/cancel`, headers: tma(OTHER) });
    }
    const fourth = await app.inject({ method: "POST", url: "/orders", headers: tma(OTHER), payload: body });
    expect(fourth.json().error).toBe("too_many_attempts");
  });

  it("staff actions land in the audit log with the actor", async () => {
    const target = await userId(OTHER);
    await app.inject({ method: "POST", url: `/admin/users/${target}/ban`, headers: tma(ADMIN), payload: { reason: "спам" } });
    await app.inject({ method: "PUT", url: "/admin/settings", headers: tma(ADMIN), payload: { checks_per_day: 6 } });
    const log = (await app.inject({ url: "/admin/audit", headers: tma(ADMIN) })).json() as Array<{ action: string; target: string; actorTelegramId: number }>;
    expect(log.find((e) => e.action === "user.ban")).toMatchObject({ target, actorTelegramId: ADMIN });
    expect(log.some((e) => e.action === "settings.update")).toBe(true);
    expect((await app.inject({ url: "/admin/audit", headers: tma(BUYER) })).statusCode).toBe(403);
    await db.execute(dsql`delete from settings where key = 'checks_per_day'`);
    await db.delete(listings).where(eq(listings.titleRu, "T"));
  });
});
