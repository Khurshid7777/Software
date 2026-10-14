import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { sql as dsql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ListingDto } from "@ishonch/shared";
import { buildApp } from "../src/app.js";
import { buildInitData } from "../src/auth/telegram.js";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { FsStorage } from "../src/storage/storage.js";
import type { SpeechToText } from "../src/stt/speechToText.js";
import type { ChannelPost, ChannelPublisher, Notifier } from "../src/telegram/publisher.js";
import { listingFixtures, mockAiByPrompt, testPhoto } from "./helpers.js";

const url = process.env.TEST_DATABASE_URL ?? "postgres://ishonch:ishonch@localhost:5432/ishonch";
const reachable = await postgres(url, { max: 1, connect_timeout: 2 })`select 1`
  .then(() => true)
  .catch(() => false);

const BOT_TOKEN = "123456:TEST";
const SELLER = 910_000_001;
const BUYER = 910_000_002;
const ADMIN = 910_000_003;

function multipart(parts: Array<{ name: string; value: string | Buffer; filename?: string; type?: string }>) {
  const boundary = "----ishonch-test";
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const head = p.filename
      ? `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\nContent-Type: ${p.type}\r\n\r\n`
      : `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"\r\n\r\n`;
    chunks.push(Buffer.from(head), Buffer.isBuffer(p.value) ? p.value : Buffer.from(p.value), Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

describe.skipIf(!reachable)("seller cabinet (integration)", () => {
  let app: FastifyInstance;
  let close: () => Promise<unknown>;
  let db: ReturnType<typeof createDb>["db"];
  let storageDir: string;
  const posts: Array<{ channelId: number; post: ChannelPost }> = [];
  const fx = listingFixtures.find((f) => f.name === "samsung_a54_photo_only_ru")!;
  const ai = mockAiByPrompt({ listing_analyze: fx.mock_analysis, listing_generate: fx.mock_text });
  const stt: SpeechToText = { name: "fake", transcribe: async () => "Samsung A54 sotaman, 256 gigabayt" };
  const publisher: ChannelPublisher & Notifier = {
    send: async () => undefined,
    post: async (channelId, post) => {
      posts.push({ channelId, post });
      return { messageId: posts.length };
    },
    miniAppLink: async (p) => `https://t.me/ishonch_bot/app?startapp=${p}`,
  };

  const tma = (id: number, lang = "ru") => ({ authorization: `tma ${buildInitData({ id, language_code: lang }, BOT_TOKEN)}` });
  const internal = (id: number) => ({ authorization: "Internal internal-secret", "x-telegram-user": JSON.stringify({ id }) });
  const ids = `${SELLER}, ${BUYER}, ${ADMIN}`;

  async function createDraft(who = SELLER, photos = 2) {
    const parts = [];
    for (let i = 0; i < photos; i++) parts.push({ name: "photos", value: await testPhoto(i + 1), filename: `p${i}.jpg`, type: "image/jpeg" });
    parts.push({ name: "audio", value: Buffer.from("OggS fake"), filename: "v.ogg", type: "audio/ogg" });
    const body = multipart(parts);
    return app.inject({ method: "POST", url: "/listings/drafts", headers: { ...tma(who), "content-type": body.contentType }, payload: body.payload });
  }

  async function readyToPublish(who = SELLER): Promise<ListingDto> {
    const draft = (await createDraft(who)).json() as ListingDto;
    await app.inject({ method: "POST", url: `/listings/${draft.id}/generate`, headers: tma(who), payload: { answers: { storage: "256 ГБ" } } });
    return draft;
  }

  beforeAll(async () => {
    storageDir = mkdtempSync(join(tmpdir(), "ishonch-storage-"));
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
    app = await buildApp({ config, db, ai, storage: new FsStorage(storageDir), stt, publisher });
    // Isolate from live listings left by other test files or dev seeds: duplicate-photo checks see every live listing.
    await db.execute(dsql`update listings set status = 'archived' where status in ('active', 'pending', 'reserved')`);
  });

  beforeEach(async () => {
    posts.length = 0;
    await db.execute(dsql.raw(`delete from users where telegram_id in (${ids})`));
  });

  afterAll(async () => {
    await db.execute(dsql.raw(`delete from users where telegram_id in (${ids})`));
    await app.close();
    await close();
    rmSync(storageDir, { recursive: true, force: true });
  });

  it("photos + voice → AI draft with questions, price suggestion and signed photo URLs", async () => {
    const res = await createDraft();
    expect(res.statusCode).toBe(200);
    const d = res.json() as ListingDto;
    expect(d.status).toBe("draft");
    expect(d.category).toBe("smartphone");
    expect(d.photos).toHaveLength(2);
    expect(d.questions.map((q) => q.key)).toEqual(["storage", "kit"]);
    expect(d.priceSuggestion?.source).toBe("ai");

    const analyze = ai.calls.find((c) => c.promptId === "listing_analyze")!;
    const blocks = analyze.content as Array<{ type: string; text?: string }>;
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(2);
    expect(blocks.at(-1)!.text).toContain("Samsung A54 sotaman");

    const photo = await app.inject({ url: d.photos[0]!.url });
    expect(photo.statusCode).toBe(200);
    expect(photo.headers["content-type"]).toBe("image/jpeg");
    const forged = await app.inject({ url: d.photos[0]!.url.replace(/s=.*/, "s=forged") });
    expect(forged.statusCode).toBe(404);
  });

  it("answers → bilingual text → edit → publish requires phone → channel post → stats", async () => {
    const draft = (await createDraft()).json() as ListingDto;
    const gen = (
      await app.inject({ method: "POST", url: `/listings/${draft.id}/generate`, headers: tma(SELLER), payload: { answers: { storage: "256 ГБ" } } })
    ).json() as ListingDto;
    expect(gen.titleRu).toBe(fx.mock_text.title_ru);
    expect(gen.titleUz).toBe(fx.mock_text.title_uz);
    // "256 ГБ" answer refines the model key → reference price for the 256 GB model replaces the AI estimate.
    expect(gen.priceSuggestion).toMatchObject({ source: "reference", market: 3_100_000 });
    expect(gen.price).toBe(3_100_000);

    const edited = await app.inject({
      method: "PATCH",
      url: `/listings/${draft.id}`,
      headers: tma(SELLER),
      payload: { price: 3_000_000, district: "yunusobod", allowedDeliveryModes: ["delivery_only", "cod_platform"], feePayer: "split" },
    });
    expect(edited.json()).toMatchObject({ price: 3_000_000, district: "yunusobod", allowedDeliveryModes: ["delivery_only"], feePayer: "split" });

    const noPhone = await app.inject({ method: "POST", url: `/listings/${draft.id}/publish`, headers: tma(SELLER), payload: {} });
    expect(noPhone.statusCode).toBe(409);
    expect(noPhone.json().error).toBe("phone_required");

    // Phone and channel can only be set by the bot (internal auth), not by the Mini App.
    expect((await app.inject({ method: "POST", url: "/internal/phone", headers: tma(SELLER), payload: { phone: "+998901234567" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/internal/phone", headers: internal(SELLER), payload: { phone: "998901234567" } })).json()).toEqual({ ok: true });
    const channel = (
      await app.inject({ method: "POST", url: "/internal/channels", headers: internal(SELLER), payload: { telegramChannelId: -100777, title: "Seller channel" } })
    ).json();

    const started = Date.now();
    const pub = await app.inject({ method: "POST", url: `/listings/${draft.id}/publish`, headers: tma(SELLER), payload: { channelIds: [channel.id] } });
    expect(pub.statusCode).toBe(200);
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(pub.json()).toMatchObject({ postedChannels: 1, failedChannels: 0, listing: { status: "active" } });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.channelId).toBe(-100777);
    expect(posts[0]!.post.photo).toBeInstanceOf(Buffer);
    expect(posts[0]!.post.caption).toContain("3 000 000 UZS");
    expect(posts[0]!.post.button).toEqual({ text: "Купить с доставкой", url: `https://t.me/ishonch_bot/app?startapp=listing_${draft.id}` });

    // Buyer opens the card: view counted, private fields hidden.
    const card = (await app.inject({ url: `/listings/${draft.id}`, headers: tma(BUYER) })).json() as ListingDto;
    expect(card.seller).toMatchObject({ platformSales: 0, shop: null });
    expect(card.questions).toEqual([]);
    expect(card.priceSuggestion).toBeNull();
    await app.inject({ url: `/listings/${draft.id}` }); // anonymous
    const mine = (await app.inject({ url: "/listings/mine?status=active", headers: tma(SELLER) })).json() as ListingDto[];
    expect(mine).toHaveLength(1);
    expect(mine[0]!.stats.views).toBe(2);

    const me = (await app.inject({ url: "/me", headers: tma(SELLER) })).json();
    expect(me).toMatchObject({ role: "seller", hasPhone: true });
  });

  it("drafts are private; publish needs a photo and filled text", async () => {
    const draft = (await createDraft()).json() as ListingDto;
    expect((await app.inject({ url: `/listings/${draft.id}`, headers: tma(BUYER) })).statusCode).toBe(404);
    expect((await app.inject({ method: "PATCH", url: `/listings/${draft.id}`, headers: tma(BUYER), payload: { price: 1 } })).statusCode).toBe(403);

    await app.inject({ method: "POST", url: "/internal/phone", headers: internal(SELLER), payload: { phone: "+998901234567" } });
    const notFilled = await app.inject({ method: "POST", url: `/listings/${draft.id}/publish`, headers: tma(SELLER), payload: {} });
    expect(notFilled.json().error).toBe("fill_required");

    const textOnly = await app.inject({ method: "POST", url: "/listings/drafts", headers: tma(SELLER), payload: { text: "Samsung A54" } });
    const t = textOnly.json() as ListingDto;
    await app.inject({ method: "POST", url: `/listings/${t.id}/generate`, headers: tma(SELLER), payload: { answers: {} } });
    const noPhoto = await app.inject({ method: "POST", url: `/listings/${t.id}/publish`, headers: tma(SELLER), payload: {} });
    expect(noPhoto.json().error).toBe("need_photo");
  });

  it("bump once per 3 days, mark sold, archive and restore", async () => {
    await app.inject({ method: "POST", url: "/internal/phone", headers: internal(SELLER), payload: { phone: "+998901234567" } });
    const d = await readyToPublish();
    await app.inject({ method: "POST", url: `/listings/${d.id}/publish`, headers: tma(SELLER), payload: {} });

    const early = await app.inject({ method: "POST", url: `/listings/${d.id}/bump`, headers: tma(SELLER) });
    expect(early.statusCode).toBe(429);
    expect(early.json().error).toBe("bump_too_soon");

    await db.execute(dsql`update listings set bumped_at = now() - interval '4 days' where id = ${d.id}`);
    const ok = await app.inject({ method: "POST", url: `/listings/${d.id}/bump`, headers: tma(SELLER) });
    expect(ok.statusCode).toBe(200);
    expect(new Date(ok.json().bumpedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);

    const archived = await app.inject({ method: "POST", url: `/listings/${d.id}/archive`, headers: tma(SELLER) });
    expect(archived.json().status).toBe("archived");
    const restored = await app.inject({ method: "POST", url: `/listings/${d.id}/publish`, headers: tma(SELLER), payload: {} });
    expect(restored.json().listing.status).toBe("active");

    const sold = await app.inject({ method: "POST", url: `/listings/${d.id}/sold`, headers: tma(SELLER), payload: { via: "platform" } });
    expect(sold.json()).toMatchObject({ status: "sold", soldVia: "platform" });
    const card = (await app.inject({ url: `/listings/${d.id}`, headers: tma(BUYER) })).json() as ListingDto;
    expect(card.seller?.platformSales).toBe(1);
  });

  it("private sellers are limited to 10 active listings; only verified shops are not", async () => {
    await app.inject({ method: "POST", url: "/internal/phone", headers: internal(SELLER), payload: { phone: "+998901234567" } });
    const me = (await app.inject({ url: "/me", headers: tma(SELLER) })).json();
    // Fast-forward: 10 active listings already exist.
    await db.execute(
      dsql.raw(
        `insert into listings (seller_user_id, status, title_ru, title_uz, description_ru, description_uz, price)
         select '${me.id}', 'active', 't', 't', 'd', 'd', 1 from generate_series(1, 10)`,
      ),
    );
    const d = await readyToPublish();
    const limited = await app.inject({ method: "POST", url: `/listings/${d.id}/publish`, headers: tma(SELLER), payload: {} });
    expect(limited.statusCode).toBe(409);
    expect(limited.json()).toMatchObject({ error: "limit_reached" });
    expect(limited.json().message).toContain("10");

    // A self-declared shop is still limited: anyone can fill in a shop name.
    const shop = await app.inject({ method: "PUT", url: "/shops/mine", headers: tma(SELLER), payload: { name: "Malika Mobile", marketLocation: "Malika, 3-qator" } });
    expect(shop.json()).toMatchObject({ name: "Malika Mobile", verified: false });
    const stillLimited = await app.inject({ method: "POST", url: `/listings/${d.id}/publish`, headers: tma(SELLER), payload: {} });
    expect(stillLimited.json().error).toBe("limit_reached");

    // Admin grants the "verified shop" badge: the limit is lifted and buyers see the badge.
    expect((await app.inject({ method: "POST", url: `/admin/shops/${shop.json().id}/verify`, headers: tma(SELLER), payload: {} })).statusCode).toBe(403);
    const v = await app.inject({ method: "POST", url: `/admin/shops/${shop.json().id}/verify`, headers: tma(ADMIN), payload: { verified: true } });
    expect(v.json().verified).toBe(true);
    const ok = await app.inject({ method: "POST", url: `/listings/${d.id}/publish`, headers: tma(SELLER), payload: {} });
    expect(ok.statusCode).toBe(200);
    const card = (await app.inject({ url: `/listings/${d.id}`, headers: tma(BUYER) })).json() as ListingDto;
    expect(card.seller?.shop).toMatchObject({ name: "Malika Mobile", verified: true });
  });

  it("deleting a draft removes its photos from storage", async () => {
    const d = (await createDraft()).json() as ListingDto;
    const del = await app.inject({ method: "DELETE", url: `/listings/${d.id}`, headers: tma(SELLER) });
    expect(del.json()).toEqual({ ok: true });
    expect((await app.inject({ url: d.photos[0]!.url })).statusCode).toBe(404);
  });

  it("voice-only draft fails clearly when STT is unavailable", async () => {
    const noStt = await buildApp({
      config: loadConfig({ NODE_ENV: "test", DATABASE_URL: url, BOT_TOKEN, INTERNAL_API_TOKEN: "internal-secret" } as NodeJS.ProcessEnv),
      db,
      ai,
      storage: new FsStorage(storageDir),
      publisher,
    });
    const body = multipart([{ name: "audio", value: Buffer.from("OggS"), filename: "v.ogg", type: "audio/ogg" }]);
    const res = await noStt.inject({ method: "POST", url: "/listings/drafts", headers: { ...tma(SELLER), "content-type": body.contentType }, payload: body.payload });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("voice_unavailable");
    await noStt.close();
  });
});
