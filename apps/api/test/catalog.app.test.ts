import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { eq, inArray, sql as dsql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AssistantResponse, CatalogPage, CompareResponse } from "@ishonch/shared";
import { PROMPTS_DIR } from "@ishonch/shared/node";
import { buildApp } from "../src/app.js";
import { buildInitData } from "../src/auth/telegram.js";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { listings, shops, users } from "../src/db/schema.js";
import { prefixQuery } from "../src/modules/catalog/service.js";
import { FsStorage } from "../src/storage/storage.js";
import type { ChannelPublisher, Notifier, NotifyButton } from "../src/telegram/publisher.js";
import { listingFixtures, mockAiByPrompt } from "./helpers.js";

const url = process.env.TEST_DATABASE_URL ?? "postgres://ishonch:ishonch@localhost:5432/ishonch";
const reachable = await postgres(url, { max: 1, connect_timeout: 2 })`select 1`
  .then(() => true)
  .catch(() => false);

interface FixtureListing {
  key: string;
  category: string;
  titleRu: string;
  titleUz: string;
  descriptionRu: string;
  descriptionUz: string;
  modelKey: string;
  price: number;
  condition: string;
  district: string;
}
const ASSISTANT = JSON.parse(readFileSync(`${PROMPTS_DIR}__fixtures__/assistant.json`, "utf8")) as {
  catalog: FixtureListing[];
  cases: Array<{ name: string; lang: "ru" | "uz"; messages: Array<{ role: "user" | "assistant"; content: string }>; expect: Record<string, unknown>; mock_query: Record<string, unknown> }>;
};

const BOT_TOKEN = "123456:TEST";
const SHOP_SELLER = 920_000_001; // verified shop
const NEW_SELLER = 920_000_002; // brand-new private seller
const BUYER = 920_000_003;
const BUYER2 = 920_000_004;
const IDS = [SHOP_SELLER, NEW_SELLER, BUYER, BUYER2].join(",");

describe.skipIf(!reachable)("catalog, assistant, subscriptions, masked chat (integration)", () => {
  let app: FastifyInstance;
  let close: () => Promise<unknown>;
  let db: ReturnType<typeof createDb>["db"];
  const byKey = new Map<string, string>(); // fixture key -> listing id
  const dms: Array<{ chatId: number; text: string; buttons: NotifyButton[][] }> = [];
  const aiCalls: string[] = [];
  let queryMock: Record<string, unknown> = ASSISTANT.cases[0]!.mock_query;
  let recommendIds: (candidates: string[]) => string[] = (c) => c.slice(0, 3);

  const gateway: ChannelPublisher & Notifier = {
    post: async () => ({ messageId: 1 }),
    miniAppLink: async (p) => `https://t.me/ishonch_bot/app?startapp=${p}`,
    send: async (chatId, text, buttons = []) => void dms.push({ chatId, text, buttons }),
  };
  const ai = mockAiByPrompt({
    assistant_query: () => (aiCalls.push("query"), queryMock),
    assistant_recommend: (call: { content: Array<{ text: string }> }) => {
      aiCalls.push("recommend");
      const ctx = JSON.parse(call.content[0]!.text) as { candidates: Array<{ id: string }> };
      const ids = recommendIds(ctx.candidates.map((c) => c.id));
      return {
        summary: "Совет: осмотрите перед оплатой.",
        options: [
          ...ids.map((id) => ({ listing_id: id, pros: ["плюс"], cons: ["минус"], fit: "подходит" })),
          { listing_id: "00000000-0000-0000-0000-000000000000", pros: ["выдуманный"], cons: [], fit: "нет" },
        ],
      };
    },
    assistant_compare: (call: { content: Array<{ text: string }> }) => {
      aiCalls.push("compare");
      const ctx = JSON.parse(call.content[0]!.text) as { listings: Array<{ id: string }> };
      return { summary: "Берите первый.", verdicts: [...ctx.listings.map((l) => ({ listing_id: l.id, best_for: "цена" })), { listing_id: "fake", best_for: "x" }] };
    },
    listing_analyze: listingFixtures[0]!.mock_analysis,
    listing_generate: listingFixtures[0]!.mock_text,
  });

  const tma = (id: number, lang = "ru") => ({ authorization: `tma ${buildInitData({ id, language_code: lang }, BOT_TOKEN)}` });
  const internal = (id: number) => ({ authorization: "Internal internal-secret", "x-telegram-user": JSON.stringify({ id }) });
  const userId = async (tg: number) => (await app.inject({ url: "/me", headers: tma(tg) })).json().id as string;
  const catalog = async (qs: string, who?: number) =>
    (await app.inject({ url: `/catalog?${qs}`, headers: who ? tma(who) : {} })).json() as CatalogPage;
  const keys = (p: CatalogPage) => p.items.map((i) => [...byKey].find(([, id]) => id === i.listing.id)?.[0] ?? i.listing.id);

  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: url,
      BOT_TOKEN,
      INTERNAL_API_TOKEN: "internal-secret",
      ASSISTANT_PER_DAY: "100",
    } as NodeJS.ProcessEnv);
    const created = createDb(url);
    db = created.db;
    close = () => created.sql.end();
    app = await buildApp({ config, db, ai, storage: new FsStorage("/tmp/ishonch-catalog-test"), publisher: gateway });

    await db.execute(dsql.raw(`delete from users where telegram_id in (${IDS})`));
    // Isolate from listings created by other test files.
    await db.execute(dsql`update listings set status = 'archived' where status = 'active'`);
    const shopSeller = await userId(SHOP_SELLER);
    const newSeller = await userId(NEW_SELLER);
    await db.update(users).set({ createdAt: new Date(Date.now() - 400 * 864e5) }).where(eq(users.id, shopSeller));
    const [shop] = await db.insert(shops).values({ ownerUserId: shopSeller, name: "Malika Tech", verified: true, verifiedAt: new Date() }).returning();

    for (const [i, f] of ASSISTANT.catalog.entries()) {
      const fromShop = ["mba_m1", "redmi_note13", "airpods_pro2"].includes(f.key);
      const [row] = await db
        .insert(listings)
        .values({
          sellerUserId: fromShop ? shopSeller : newSeller,
          shopId: fromShop ? shop!.id : null,
          category: f.category,
          titleRu: f.titleRu,
          titleUz: f.titleUz,
          descriptionRu: f.descriptionRu,
          descriptionUz: f.descriptionUz,
          attributes: { brand: null, model: null, modelKey: f.modelKey, specs: [{ name: "storage", value: "256 GB" }] },
          condition: f.condition,
          price: f.price,
          district: f.district,
          status: "active",
          publishedAt: new Date(),
          bumpedAt: new Date(Date.now() - i * 60_000),
          expiresAt: new Date(Date.now() + 30 * 864e5),
        })
        .returning();
      byKey.set(f.key, row!.id);
    }
    // Sold HP laptops give a catalog median for "hp 250 g8" (not in the price reference).
    for (const p of [3_000_000, 3_400_000, 3_600_000]) {
      await db.insert(listings).values({
        sellerUserId: newSeller,
        category: "laptop",
        titleRu: "HP 250 G8",
        titleUz: "HP 250 G8",
        attributes: { modelKey: "hp 250 g8", specs: [] },
        price: p,
        status: "sold",
        publishedAt: new Date(),
      });
    }
  });

  beforeEach(() => {
    dms.length = 0;
    aiCalls.length = 0;
    recommendIds = (c) => c.slice(0, 3);
  });

  afterAll(async () => {
    await db.execute(dsql.raw(`delete from users where telegram_id in (${IDS})`));
    await app.close();
    await close();
  });

  // ---------- search ----------
  it("builds prefix queries for Uzbek words", () => {
    expect(prefixQuery("O'yin noutbuk!")).toBe("(oyin:* | (o <-> yin:*) | ўйин:*) & (noutbuk:* | ноутбук:*)");
    // Both scripts and both languages; model codes stay as they are.
    expect(prefixQuery("ноутбук")).toBe("(ноутбук:* | noutbuk:*)");
    expect(prefixQuery("айфон a54")).toBe("(айфон:* | iphone:* | ayfon:*) & a54:*");
    expect(prefixQuery("наушники")).toContain("quloqchin:*");
    expect(prefixQuery("&|!")).toBeNull();
  });

  it("full-text search: model names, Russian morphology, Uzbek suffixes, typos", async () => {
    expect(keys(await catalog("q=macbook"))).toEqual(["mba_m1"]);
    expect(keys(await catalog(`q=${encodeURIComponent("игровые ноутбуки")}`))).toEqual(["lenovo_legion"]);
    expect(keys(await catalog("q=noutbuk"))).toContain("lenovo_legion");
    // Uzbek written in Cyrillic finds a Latin-Uzbek title, and the other way round.
    expect(keys(await catalog(`q=${encodeURIComponent("ўйин ноутбук")}`))).toContain("lenovo_legion");
    expect(keys(await catalog("q=iphnoe%2013"))).toEqual(["iphone13"]);
    expect(keys(await catalog("q=playstation"))).toEqual(["ps5"]);
    // Local spellings / transliterations.
    expect(keys(await catalog(`q=${encodeURIComponent("айфон 13")}`))).toEqual(["iphone13"]);
    expect(keys(await catalog("q=makbuk"))).toEqual(["mba_m1"]);
    expect(keys(await catalog(`q=${encodeURIComponent("пс5")}`))).toEqual(["ps5"]);
    expect(keys(await catalog(`q=${encodeURIComponent("эирподс")}`))).toEqual(["airpods_pro2"]);
    // Unrelated words do not match everything.
    expect(keys(await catalog("q=velosiped"))).toEqual([]);
  });

  it("filters: category, price, condition, district, verified only; sorting", async () => {
    expect(keys(await catalog("category=laptop&priceMax=8000000&sort=price_asc"))).toEqual(["hp_office", "mba_m1", "lenovo_legion"]);
    expect(keys(await catalog("category=smartphone&conditions=new,like_new"))).toEqual(["redmi_note13"]);
    expect(keys(await catalog("district=yunusobod&sort=price_desc"))).toEqual(["lenovo_legion", "ps5"]);
    const verified = await catalog("verifiedOnly=true");
    expect(keys(verified).sort()).toEqual(["airpods_pro2", "mba_m1", "redmi_note13"]);
    expect(verified.items.every((i) => i.trust === "high" && i.listing.seller?.shop?.verified)).toBe(true);
    expect((await app.inject({ url: "/catalog?priceMax=-5" })).statusCode).toBe(400);
  });

  it("market label from the price reference or the catalog median; trust from seller history", async () => {
    const page = await catalog("category=laptop&sort=price_asc");
    const hp = page.items.find((i) => i.listing.id === byKey.get("hp_office"))!;
    expect(hp.market).toMatchObject({ source: "catalog", verdict: "market" });
    expect(hp.trust).toBe("low");
    const mba = page.items.find((i) => i.listing.id === byKey.get("mba_m1"))!;
    expect(mba.market).toMatchObject({ source: "reference", verdict: "market" });
    expect(mba.trust).toBe("high");
  });

  it("paginates", async () => {
    const all = await catalog("sort=newest");
    expect(all.items).toHaveLength(7);
    expect(all.nextOffset).toBeNull();
  });

  it("catalog card endpoint: market label, trust, view counter", async () => {
    const id = byKey.get("iphone13")!;
    const res = await app.inject({ url: `/catalog/${id}`, headers: tma(BUYER) });
    expect(res.json()).toMatchObject({ listing: { id }, market: { source: "reference", verdict: "market" }, trust: "low", favorite: false });
    const [row] = await db.select({ v: listings.views }).from(listings).where(eq(listings.id, id));
    expect(row!.v).toBeGreaterThan(0);
    expect((await app.inject({ url: "/catalog/00000000-0000-0000-0000-000000000000" })).statusCode).toBe(404);
  });

  // ---------- favorites ----------
  it("favorites: add, list, count, remove", async () => {
    const id = byKey.get("iphone13")!;
    await app.inject({ method: "POST", url: `/favorites/${id}`, headers: tma(BUYER) });
    await app.inject({ method: "POST", url: `/favorites/${id}`, headers: tma(BUYER) }); // idempotent
    const favs = (await app.inject({ url: "/favorites", headers: tma(BUYER) })).json();
    expect(favs).toHaveLength(1);
    expect(favs[0].favorite).toBe(true);
    const [row] = await db.select({ n: listings.favoritesCount }).from(listings).where(eq(listings.id, id));
    expect(row!.n).toBe(1);
    expect((await catalog("q=iphone", BUYER)).items[0]!.favorite).toBe(true);
    await app.inject({ method: "DELETE", url: `/favorites/${id}`, headers: tma(BUYER) });
    expect((await app.inject({ url: "/favorites", headers: tma(BUYER) })).json()).toHaveLength(0);
  });

  // ---------- masked chat ----------
  it("buyer writes → seller gets a masked message → seller replies through the bot", async () => {
    const id = byKey.get("ps5")!;
    const res = await app.inject({ method: "POST", url: `/listings/${id}/contact`, headers: tma(BUYER), payload: { text: "Ещё продаёте?" } });
    expect(res.statusCode).toBe(200);
    const conv = res.json().conversationId as string;
    expect(dms).toHaveLength(1);
    expect(dms[0]!.chatId).toBe(NEW_SELLER);
    expect(dms[0]!.text).toContain("Покупатель из Ishonch интересуется");
    expect(dms[0]!.text).toContain("Ещё продаёте?");
    expect(dms[0]!.text).not.toContain(String(BUYER));
    expect(dms[0]!.buttons[0]![0]).toEqual({ text: "Ответить", callbackData: `reply:${conv}` });

    // Seller replies via the bot (internal auth).
    const reply = await app.inject({
      method: "POST",
      url: `/internal/conversations/${conv}/messages`,
      headers: internal(NEW_SELLER),
      payload: { text: "Да, приходите в 18:00" },
    });
    expect(reply.json()).toEqual({ ok: true });
    expect(dms[1]!.chatId).toBe(BUYER);
    expect(dms[1]!.text).toContain("Продавец ответил");
    expect(JSON.stringify(dms[1]!.buttons)).toContain(`startapp=listing_${id}`);

    // Strangers cannot post into the conversation; the Mini App cannot use the internal route.
    expect((await app.inject({ method: "POST", url: `/internal/conversations/${conv}/messages`, headers: internal(BUYER2), payload: { text: "x" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/internal/conversations/${conv}/messages`, headers: tma(BUYER), payload: { text: "x" } })).statusCode).toBe(403);
    // A second message reuses the conversation.
    const again = await app.inject({ method: "POST", url: `/listings/${id}/contact`, headers: tma(BUYER), payload: { text: "А торг?" } });
    expect(again.json().conversationId).toBe(conv);
    expect(dms.at(-1)!.text).toContain("Покупатель по объявлению");
  });

  it("sellers cannot message their own listing", async () => {
    const res = await app.inject({ method: "POST", url: `/listings/${byKey.get("ps5")}/contact`, headers: tma(NEW_SELLER), payload: { text: "hi" } });
    expect(res.statusCode).toBe(409);
  });

  // ---------- saved searches ----------
  it("saved search alerts on matching publication, max 3 per day, never for own listings", async () => {
    const saved = await app.inject({ method: "POST", url: "/searches", headers: tma(BUYER2), payload: { q: "iphone", priceMax: 9_000_000 } });
    expect(saved.json()).toMatchObject({ title: expect.stringContaining("iphone") });
    await app.inject({ method: "POST", url: "/searches", headers: tma(NEW_SELLER), payload: { q: "iphone" } });

    await app.inject({ method: "POST", url: "/internal/phone", headers: internal(NEW_SELLER), payload: { phone: "+998901112233" } });
    async function publishIphone(price: number) {
      const draft = (await app.inject({ method: "POST", url: "/listings/drafts", headers: tma(NEW_SELLER), payload: { text: "iPhone 12" } })).json();
      await app.inject({ method: "POST", url: `/listings/${draft.id}/generate`, headers: tma(NEW_SELLER), payload: { answers: {} } });
      await app.inject({ method: "PATCH", url: `/listings/${draft.id}`, headers: tma(NEW_SELLER), payload: { price } });
      await db.insert((await import("../src/db/schema.js")).listingPhotos).values({ listingId: draft.id, storageKey: "x.jpg" });
      const res = await app.inject({ method: "POST", url: `/listings/${draft.id}/publish`, headers: tma(NEW_SELLER), payload: {} });
      expect(res.statusCode).toBe(200);
      return draft.id as string;
    }
    const created: string[] = [];
    for (let i = 0; i < 4; i++) created.push(await publishIphone(4_000_000 + i * 10_000));
    const alerts = dms.filter((d) => d.text.includes("подписке") || d.text.includes("obuna"));
    expect(alerts).toHaveLength(3); // 4 matches, capped at 3 per day
    expect(alerts.every((a) => a.chatId === BUYER2)).toBe(true); // the seller's own search is skipped

    created.push(await publishIphone(20_000_000)); // above priceMax → no alert anyway
    const searches = (await app.inject({ url: "/searches", headers: tma(BUYER2) })).json();
    await app.inject({ method: "DELETE", url: `/searches/${searches[0].id}`, headers: tma(BUYER2) });
    expect((await app.inject({ url: "/searches", headers: tma(BUYER2) })).json()).toHaveLength(0);
    await db.update(listings).set({ status: "archived" }).where(inArray(listings.id, created));
  });

  // ---------- AI assistant ----------
  for (const c of ASSISTANT.cases) {
    it(`assistant: ${c.name}`, async () => {
      queryMock = c.mock_query;
      const res = await app.inject({ method: "POST", url: "/assistant", headers: tma(BUYER, c.lang), payload: { messages: c.messages, lang: c.lang } });
      expect(res.statusCode).toBe(200);
      const body = res.json() as AssistantResponse;
      const kind = { search: "results", ask: "ask", off_topic: "off_topic" }[c.expect.action as string];
      expect(body.kind).toBe(kind);
      if (kind === "results") {
        expect(aiCalls).toEqual(["query", "recommend"]);
        const got = body.options.map((o) => [...byKey].find(([, id]) => id === o.item.listing.id)?.[0]);
        expect(got.some((k) => (c.expect.must_include_any as string[]).includes(k!))).toBe(true);
        for (const bad of c.expect.must_exclude as string[]) expect(got).not.toContain(bad);
        // The invented id from the model is dropped.
        expect(body.options.every((o) => o.item.listing.id !== "00000000-0000-0000-0000-000000000000")).toBe(true);
        expect(body.options.length).toBeGreaterThanOrEqual(1);
        expect(body.options.length).toBeLessThanOrEqual(5);
        for (const o of body.options) expect(o.item.listing.price!).toBeLessThanOrEqual(c.expect.price_max as number);
        expect(body.filters).toMatchObject({ category: c.expect.category, priceMax: c.expect.price_max });
      } else {
        expect(aiCalls).toEqual(["query"]); // no expensive call
        expect(body.options).toEqual([]);
      }
      if (kind === "ask") expect(body.questions.length).toBeLessThanOrEqual(2);
    });
  }

  it("assistant: after 2 questions it must search; no results → offers a subscription", async () => {
    // The model still wants to ask, but 2 questions were already asked → the server searches.
    queryMock = { ...ASSISTANT.cases[2]!.mock_query, filters: { ...(ASSISTANT.cases[2]!.mock_query.filters as object), category: "tablet", price_max_uzs: 1_000_000 } };
    const res = await app.inject({
      method: "POST",
      url: "/assistant",
      headers: tma(BUYER),
      payload: {
        messages: [
          { role: "user", content: "Подарок сыну" },
          { role: "assistant", content: "Сколько лет? Какой бюджет?" },
          { role: "user", content: "10 лет, планшет до 1 млн" },
        ],
      },
    });
    const body = res.json() as AssistantResponse;
    expect(body.kind).toBe("no_results");
    expect(aiCalls).toEqual(["query"]); // no strong-model call when there is nothing to rank
    expect(body.filters).toMatchObject({ category: "tablet", priceMax: 1_000_000 });
    const saved = await app.inject({ method: "POST", url: "/searches", headers: tma(BUYER), payload: body.filters! });
    expect(saved.statusCode).toBe(200);
  });

  it("assistant: candidates are never invented even if the model returns none of them", async () => {
    queryMock = ASSISTANT.cases[0]!.mock_query;
    recommendIds = () => [];
    const body = (await app.inject({ method: "POST", url: "/assistant", headers: tma(BUYER), payload: { messages: ASSISTANT.cases[0]!.messages } })).json() as AssistantResponse;
    expect(body.kind).toBe("results");
    expect(body.options.length).toBeGreaterThan(0);
    expect(body.options.every((o) => [...byKey.values()].includes(o.item.listing.id))).toBe(true);
  });

  it("compare 2–3 listings: table from data + AI verdicts for real ids only", async () => {
    const ids = [byKey.get("mba_m1")!, byKey.get("lenovo_legion")!];
    const res = await app.inject({ method: "POST", url: "/assistant/compare", headers: tma(BUYER), payload: { ids } });
    const body = res.json() as CompareResponse;
    expect(body.items).toHaveLength(2);
    expect(body.rows[0]).toEqual({ label: "Цена", values: ["7 600 000 UZS", "7 900 000 UZS"] });
    expect(body.rows.find((r) => r.label === "Продавец")!.values[0]).toContain("✔️");
    expect(Object.keys(body.bestFor).sort()).toEqual([...ids].sort());
    expect((await app.inject({ method: "POST", url: "/assistant/compare", headers: tma(BUYER), payload: { ids: [ids[0]] } })).statusCode).toBe(400);
  });

  it("assistant daily limit", async () => {
    await db.execute(dsql`insert into settings (key, value) values ('assistant_per_day', '1'::jsonb) on conflict (key) do update set value = '1'::jsonb`);
    const app2 = await buildApp({
      config: loadConfig({ NODE_ENV: "test", DATABASE_URL: url, BOT_TOKEN, INTERNAL_API_TOKEN: "internal-secret" } as NodeJS.ProcessEnv),
      db,
      ai,
      storage: new FsStorage("/tmp/ishonch-catalog-test"),
      publisher: gateway,
    });
    const res = await app2.inject({ method: "POST", url: "/assistant", headers: tma(BUYER), payload: { messages: ASSISTANT.cases[0]!.messages } });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe("limit_reached");
    await db.execute(dsql`delete from settings where key = 'assistant_per_day'`);
    await app2.close();
  });
});
