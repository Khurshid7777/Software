import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { sql as dsql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { buildInitData } from "../src/auth/telegram.js";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { fixtures, mockAi } from "./helpers.js";

/**
 * Integration test against a real PostgreSQL (migrated + seeded).
 * Skipped when TEST_DATABASE_URL is not reachable.
 */
const url = process.env.TEST_DATABASE_URL ?? "postgres://ishonch:ishonch@localhost:5432/ishonch";
const reachable = await postgres(url, { max: 1, connect_timeout: 2 })`select 1`
  .then(() => true)
  .catch(() => false);

const BOT_TOKEN = "123456:TEST";
const BUYER = 900_000_001;
const ADMIN = 900_000_002;

describe.skipIf(!reachable)("API (integration)", () => {
  let app: FastifyInstance;
  let close: () => Promise<unknown>;
  let db: ReturnType<typeof createDb>["db"];
  const iphone = fixtures.find((f) => f.name === "iphone13_prepay_ru")!;

  const tma = (id: number, lang = "ru") => ({ authorization: `tma ${buildInitData({ id, language_code: lang }, BOT_TOKEN)}` });

  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: url,
      BOT_TOKEN,
      INTERNAL_API_TOKEN: "internal-secret",
      ADMIN_TELEGRAM_IDS: String(ADMIN),
    } as NodeJS.ProcessEnv);
    const created = createDb(url);
    db = created.db;
    close = () => created.sql.end();
    app = await buildApp({ config, db, ai: mockAi(iphone.mock_extract) });
  });

  beforeEach(async () => {
    await db.execute(dsql`delete from users where telegram_id in (${BUYER}, ${ADMIN})`);
  });

  afterAll(async () => {
    await db.execute(dsql`delete from users where telegram_id in (${BUYER}, ${ADMIN})`);
    await app.close();
    await close();
  });

  it("health: database check, version, uptime; every response carries a request id", async () => {
    const res = await app.inject("/health");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, db: { ok: true }, version: "dev" });
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    // An upstream id (nginx, the bot) is kept, so one id follows the request across services.
    const traced = await app.inject({ url: "/health/live", headers: { "x-request-id": "req-from-nginx-42" } });
    expect(traced.headers["x-request-id"]).toBe("req-from-nginx-42");
  });

  it("rejects requests without a valid signature", async () => {
    const res = await app.inject({ url: "/me", headers: { authorization: "tma auth_date=1&hash=00" } });
    expect(res.statusCode).toBe(401);
  });

  it("creates the user on first open and stores terms consent", async () => {
    const me = (await app.inject({ url: "/me", headers: tma(BUYER) })).json();
    expect(me).toMatchObject({ telegramId: BUYER, language: "ru", role: "buyer", acceptedTerms: false });
    expect(me.checks).toEqual({ perDay: 5, remaining: 5 });

    await app.inject({ method: "POST", url: "/me/accept-terms", headers: tma(BUYER) });
    await app.inject({ method: "PATCH", url: "/me", headers: tma(BUYER), payload: { language: "uz" } });
    const again = (await app.inject({ url: "/me", headers: tma(BUYER) })).json();
    expect(again).toMatchObject({ acceptedTerms: true, language: "uz" });
  });

  it("bot can act on behalf of a user with the internal token", async () => {
    const res = await app.inject({
      url: "/me",
      headers: { authorization: "Internal internal-secret", "x-telegram-user": JSON.stringify({ id: BUYER, language_code: "uz" }) },
    });
    expect(res.json()).toMatchObject({ telegramId: BUYER, language: "uz" });
    const bad = await app.inject({
      url: "/me",
      headers: { authorization: "Internal wrong", "x-telegram-user": JSON.stringify({ id: BUYER }) },
    });
    expect(bad.statusCode).toBe(401);
  });

  it("runs a check, stores it anonymised, shares it and enforces the daily limit", async () => {
    const res = await app.inject({ method: "POST", url: "/checks", headers: tma(BUYER), payload: { text: iphone.input } });
    expect(res.statusCode).toBe(200);
    const check = res.json();
    expect(check.risk.level).toBe("high");
    expect(check.price).toMatchObject({ verdict: "below", source: "reference", diffPct: -40 });
    expect(check.remainingToday).toBe(4);

    const shared = await app.inject({ url: `/checks/${check.id}` });
    expect(shared.json()).toMatchObject({ id: check.id, risk: { level: "high" } });

    const [row] = (await db.execute(dsql`select extracted::text as e from checks where id = ${check.id}`)) as unknown as [{ e: string }];
    expect(row.e).not.toMatch(/\+998|\d{2}[ -]\d{3}[ -]\d{2}[ -]\d{2}/);

    for (let i = 0; i < 4; i++) {
      await app.inject({ method: "POST", url: "/checks", headers: tma(BUYER), payload: { text: iphone.input } });
    }
    const limited = await app.inject({ method: "POST", url: "/checks", headers: tma(BUYER), payload: { text: iphone.input } });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().message).toMatch(/5/);
  });

  it("asks for a screenshot when only a link is sent", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/checks",
      headers: tma(BUYER),
      payload: { text: "https://www.olx.uz/d/obyavlenie/iphone-13-ID3abc.html" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: "link_not_supported" });
  });

  it("accepts screenshots via multipart", async () => {
    const boundary = "----ishonch";
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="lang"\r\n\r\nuz\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="images"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/checks",
      headers: { ...tma(BUYER), "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().lang).toBe("uz");
  });

  it("admin-only price reference endpoints with CSV import", async () => {
    expect((await app.inject({ url: "/admin/price-reference", headers: tma(BUYER) })).statusCode).toBe(403);

    const csv = "model_key,price_min,price_median,price_max\napple iphone 99 test 1tb,1,2,3\nbroken,5,4,3\n";
    const imported = await app.inject({
      method: "POST",
      url: "/admin/price-reference/import",
      headers: { ...tma(ADMIN), "content-type": "text/csv" },
      payload: csv,
    });
    expect(imported.json()).toMatchObject({ imported: 1 });
    expect(imported.json().errors).toHaveLength(1);

    const list = (await app.inject({ url: "/admin/price-reference", headers: tma(ADMIN) })).json() as Array<{ id: number; modelKey: string }>;
    const row = list.find((r) => r.modelKey === "apple iphone 99 test 1tb")!;
    expect(row).toBeTruthy();
    await app.inject({ method: "DELETE", url: `/admin/price-reference/${row.id}`, headers: tma(ADMIN) });

    const usage = (await app.inject({ url: "/admin/ai-usage", headers: tma(ADMIN) })).json();
    expect(usage).toHaveProperty("monthlyLimitUsd");
  });

  it("deletes the account on request", async () => {
    await app.inject({ url: "/me", headers: tma(BUYER) });
    const res = await app.inject({ method: "DELETE", url: "/me", headers: tma(BUYER) });
    expect(res.json()).toEqual({ ok: true });
    const [row] = (await db.execute(dsql`select count(*)::int as n from users where telegram_id = ${BUYER}`)) as unknown as [{ n: number }];
    expect(row.n).toBe(0);
  });
});
