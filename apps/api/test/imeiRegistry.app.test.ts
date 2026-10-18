import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { eq, sql as dsql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { isValidImei, type CatalogItem } from "@ishonch/shared";
import { buildApp } from "../src/app.js";
import { buildInitData } from "../src/auth/telegram.js";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { listings } from "../src/db/schema.js";
import { HttpImeiRegistry, type ImeiRegistry, type ImeiRegistryResult } from "../src/integrations/imeiRegistry.js";
import { FsStorage } from "../src/storage/storage.js";
import { mockAiByPrompt } from "./helpers.js";

const url = process.env.TEST_DATABASE_URL ?? "postgres://ishonch:ishonch@localhost:5432/ishonch";
const reachable = await postgres(url, { max: 1, connect_timeout: 2 })`select 1`
  .then(() => true)
  .catch(() => false);

const BOT_TOKEN = "123456:TEST";
const SELLER = 975_000_001;
const BUYER = 975_000_002;
const ALL = [SELLER, BUYER];
const CLEAN = "352099001761481";
const LISTED = "353322110098762";
const SILENT = "354444556677880";

describe("HttpImeiRegistry", () => {
  const reply = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });

  it("asks the adapter with the IMEI and a bearer token, accepts only the agreed answers", async () => {
    let seen: { url: string; auth: string | null } | null = null;
    const registry = new HttpImeiRegistry({
      url: "https://imei.example/check",
      token: "secret",
      fetch: (async (u: URL, init?: RequestInit) => {
        seen = { url: String(u), auth: new Headers(init?.headers).get("authorization") };
        return new Response(JSON.stringify({ status: "listed" }));
      }) as typeof fetch,
    });
    expect(await registry.check(CLEAN)).toEqual({ status: "listed", provider: "http" });
    expect(seen).toEqual({ url: `https://imei.example/check?imei=${CLEAN}`, auth: "Bearer secret" });

    const of = (f: () => Promise<Response>) => new HttpImeiRegistry({ url: "https://imei.example/check", fetch: f as typeof fetch });
    expect(await of(reply(200, { status: "clean" })).check(CLEAN)).toEqual({ status: "clean", provider: "http" });
    expect(await of(reply(500, { status: "clean" })).check(CLEAN)).toBeNull();
    expect(await of(reply(200, { status: "maybe" })).check(CLEAN)).toBeNull();
    expect(await of(async () => Promise.reject(new Error("down"))).check(CLEAN)).toBeNull();
  });
});

describe.skipIf(!reachable)("lost/stolen IMEI registry in moderation and the passport (integration)", () => {
  let app: FastifyInstance;
  let close: () => Promise<unknown>;
  let db: ReturnType<typeof createDb>["db"];
  let storageDir: string;
  const calls: string[] = [];
  const answers: Record<string, ImeiRegistryResult | null> = {
    [CLEAN]: { status: "clean", provider: "fake" },
    [LISTED]: { status: "listed", provider: "fake" },
    [SILENT]: null,
  };
  const registry: ImeiRegistry = {
    name: "fake",
    check: async (imei) => {
      calls.push(imei);
      return answers[imei] ?? null;
    },
  };

  const tma = (id: number) => ({ authorization: `tma ${buildInitData({ id, language_code: "ru" }, BOT_TOKEN)}` });
  const userId = async (tg: number) => (await app.inject({ url: "/me", headers: tma(tg) })).json().id as string;
  const patch = (who: number, id: string, body: Record<string, unknown>) =>
    app.inject({ method: "PATCH", url: `/listings/${id}`, headers: tma(who), payload: body });
  const card = async (who: number, id: string) => (await app.inject({ url: `/catalog/${id}`, headers: tma(who) })).json() as CatalogItem;
  const fetchRow = async (id: string) => (await db.select().from(listings).where(eq(listings.id, id)))[0]!;

  async function liveListing() {
    const [row] = await db
      .insert(listings)
      .values({
        sellerUserId: await userId(SELLER),
        category: "smartphone",
        titleRu: "iPhone 14 128 ГБ",
        titleUz: "iPhone 14 128 GB",
        descriptionRu: "Хорошее состояние",
        descriptionUz: "Yaxshi holatda",
        attributes: { modelKey: "apple iphone 14 128gb", specs: [] },
        condition: "good",
        price: 7_000_000,
        district: "yunusobod",
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
    for (const imei of [CLEAN, LISTED, SILENT]) expect(isValidImei(imei)).toBe(true);
    storageDir = mkdtempSync(join(tmpdir(), "ishonch-imei-registry-"));
    const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: url, BOT_TOKEN, INTERNAL_API_TOKEN: "internal-secret" } as NodeJS.ProcessEnv);
    const created = createDb(url);
    db = created.db;
    close = () => created.sql.end();
    const ai = mockAiByPrompt({ listing_moderate: { decision: "approved", reasons: [], seller_message_ru: "", seller_message_uz: "" } });
    app = await buildApp({ config, db, ai, storage: new FsStorage(storageDir), publisher: null, imeiRegistry: registry });
  });
  beforeEach(async () => {
    calls.length = 0;
    await db.execute(dsql.raw(`delete from users where telegram_id in (${ALL.join(",")})`));
    // Other test files may leave live listings with these IMEIs behind: no duplicate hits here.
    await db.execute(dsql`update listings set imei = null where imei in (${CLEAN}, ${LISTED}, ${SILENT})`);
  });
  afterAll(async () => {
    await db.execute(dsql.raw(`delete from users where telegram_id in (${ALL.join(",")})`));
    await app.close();
    await close();
    rmSync(storageDir, { recursive: true, force: true });
  });

  it("a listed IMEI goes to a moderator with the reason; nothing else happens on its own", async () => {
    const l = await liveListing();
    expect((await patch(SELLER, l.id, { imei: LISTED })).statusCode).toBe(200);
    const held = await fetchRow(l.id);
    expect(held.status).toBe("pending");
    expect(held.moderationReason).toBe("imei_listed");
    expect(held.imeiRegistry).toMatchObject({ imei: LISTED, status: "listed", provider: "fake" });
  });

  it("a clean IMEI shows in the passport with the registry as its source, and the answer is reused", async () => {
    const l = await liveListing();
    expect((await patch(SELLER, l.id, { imei: CLEAN })).statusCode).toBe(200);
    expect((await fetchRow(l.id)).status).toBe("active");
    const check = (await card(BUYER, l.id)).passport!.checks.find((c) => c.code === "imei_registry");
    expect(check).toEqual({ code: "imei_registry", source: "registry", status: "ok" });

    // A text edit re-moderates the listing, but the same IMEI is not sent to the registry again.
    expect((await patch(SELLER, l.id, { descriptionRu: "Хорошее состояние, полный комплект" })).statusCode).toBe(200);
    expect(calls).toEqual([CLEAN]);
    // A month later the answer is stale and the next re-moderation asks again.
    const stale = { ...(await fetchRow(l.id)).imeiRegistry!, at: new Date(Date.now() - 31 * 864e5).toISOString() };
    await db.update(listings).set({ imeiRegistry: stale }).where(eq(listings.id, l.id));
    expect((await patch(SELLER, l.id, { descriptionRu: "Хорошее состояние, чек и коробка" })).statusCode).toBe(200);
    expect(calls).toEqual([CLEAN, CLEAN]);
  });

  it("no answer from the registry: the listing stays live and the passport has no registry line", async () => {
    const l = await liveListing();
    expect((await patch(SELLER, l.id, { imei: SILENT })).statusCode).toBe(200);
    const row = await fetchRow(l.id);
    expect(row.status).toBe("active");
    expect(row.imeiRegistry).toBeNull();
    const codes = (await card(BUYER, l.id)).passport!.checks.map((c) => c.code);
    expect(codes).toContain("imei");
    expect(codes).not.toContain("imei_registry");
  });
});
