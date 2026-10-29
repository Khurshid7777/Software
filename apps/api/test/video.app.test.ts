import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { sql as dsql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { CatalogItem, ListingDto, VideoCheckAi } from "@ishonch/shared";
import { buildApp } from "../src/app.js";
import { buildInitData } from "../src/auth/telegram.js";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { listings } from "../src/db/schema.js";
import { FsStorage } from "../src/storage/storage.js";
import type { ChannelPublisher, Notifier } from "../src/telegram/publisher.js";
import { extractFrames } from "../src/modules/evidence/videoCheck.js";
import { mockAiByPrompt } from "./helpers.js";

const url = process.env.TEST_DATABASE_URL ?? "postgres://ishonch:ishonch@localhost:5432/ishonch";
const reachable = await postgres(url, { max: 1, connect_timeout: 2 })`select 1`
  .then(() => true)
  .catch(() => false);
const ffmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const BOT_TOKEN = "123456:TEST";
const SELLER = 990_300_001;
const BUYER = 990_300_002;

function multipart(value: Buffer, type: string) {
  const boundary = "----ishonch-video";
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="clip.mp4"\r\nContent-Type: ${type}\r\n\r\n`),
    value,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, contentType: `multipart/form-data; boundary=${boundary}` };
}

/** A real 2-second blue clip (ffmpeg's test source), so frames can actually be extracted. */
function realClip(dir: string) {
  const out = join(dir, "clip.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=160x120:d=2", "-pix_fmt", "yuv420p", "-r", "10", out], { stdio: "ignore" });
  return out;
}

describe.skipIf(!reachable)("video passport: AI check of the frames, required for phones before publication", () => {
  let app: FastifyInstance;
  let close: () => Promise<unknown>;
  let db: ReturnType<typeof createDb>["db"];
  let dir: string;
  // What the AI "sees": changed per test.
  let seen: Partial<VideoCheckAi> = {};
  const aiCalls: string[] = [];
  const ai = mockAiByPrompt({
    listing_moderate: { decision: "approved", reasons: [], seller_message_ru: "", seller_message_uz: "" },
    video_check: () => {
      aiCalls.push("video_check");
      return {
        device_visible: true,
        powered_on: true,
        identifier_screen: true,
        battery_screen: true,
        account_screen: true,
        imei_tail: "",
        body_shown: true,
        screen_damage: "none",
        concerns: [],
        note_ru: "Телефон включается, IMEI и аккумулятор видны.",
        note_uz: "Telefon yonadi, IMEI va batareya ko'rinadi.",
        ...seen,
      };
    },
  });
  const gateway: ChannelPublisher & Notifier = {
    post: async () => ({ messageId: 1 }),
    miniAppLink: async (p) => `https://t.me/ishonch_bot/app?startapp=${p}`,
    send: async () => undefined,
  };
  const tma = (id: number) => ({ authorization: `tma ${buildInitData({ id, language_code: "ru" }, BOT_TOKEN)}` });
  const internal = (id: number) => ({ authorization: "Internal internal-secret", "x-telegram-user": JSON.stringify({ id, language_code: "ru" }) });
  const userId = async (tg: number) => (await app.inject({ url: "/me", headers: tma(tg) })).json().id as string;

  async function draft(category: "smartphone" | "monitor" = "smartphone", extra: Partial<typeof listings.$inferInsert> = {}) {
    const [row] = await db
      .insert(listings)
      .values({
        sellerUserId: await userId(SELLER),
        category,
        titleRu: "Testbrand V1",
        titleUz: "Testbrand V1",
        descriptionRu: "Рабочий",
        descriptionUz: "Ishlaydi",
        attributes: { modelKey: "testbrand v1", specs: [] },
        condition: "good",
        price: 3_000_000,
        district: "chilonzor",
        allowedDeliveryModes: ["cod_seller"],
        feePayer: "buyer",
        status: "draft",
        ...extra,
      })
      .returning();
    const photo = Buffer.from(
      "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z",
      "base64",
    );
    const boundary = "----photo";
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photos"; filename="p.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      photo,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const up = await app.inject({ method: "POST", url: `/listings/${row!.id}/photos`, headers: { ...tma(SELLER), "content-type": `multipart/form-data; boundary=${boundary}` }, payload });
    expect(up.statusCode, up.body).toBe(200);
    return row!;
  }
  const upload = (id: string, clip: Buffer, type = "video/mp4") => {
    const body = multipart(clip, type);
    return app.inject({ method: "POST", url: `/listings/${id}/video`, headers: { ...tma(SELLER), "content-type": body.contentType }, payload: body.payload });
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "ishonch-video-"));
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: url,
      BOT_TOKEN,
      INTERNAL_API_TOKEN: "internal-secret",
      VIDEO_REQUIRED: "true",
    } as NodeJS.ProcessEnv);
    const created = createDb(url);
    db = created.db;
    close = () => created.sql.end();
    app = await buildApp({ config, db, ai, storage: new FsStorage(dir), publisher: gateway });
    for (const u of [SELLER, BUYER]) {
      await app.inject({ method: "POST", url: "/me/accept-terms", headers: tma(u), payload: {} });
      await app.inject({ method: "POST", url: "/internal/phone", headers: internal(u), payload: { phone: `+99890${String(u).slice(-7)}` } });
    }
    // Earlier runs left this seller's listings live: a private seller may have only 10, so start from none.
    await db.execute(dsql`update listings set status = 'archived' where status in ('active', 'pending', 'reserved') and seller_user_id = ${await userId(SELLER)}`);
  });
  afterAll(async () => {
    await app?.close();
    await close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  it("config: VIDEO_REQUIRED is on in production only unless set", () => {
    expect(loadConfig({ NODE_ENV: "production", BOT_TOKEN: "x", INTERNAL_API_TOKEN: "a".repeat(40) } as NodeJS.ProcessEnv).VIDEO_REQUIRED).toBe(true);
    expect(loadConfig({ NODE_ENV: "development" } as NodeJS.ProcessEnv).VIDEO_REQUIRED).toBe(false);
    expect(loadConfig({ NODE_ENV: "development", VIDEO_REQUIRED: "true" } as NodeJS.ProcessEnv).VIDEO_REQUIRED).toBe(true);
  });

  it("a phone cannot be published without the video passport; a monitor can", async () => {
    const phone = await draft("smartphone");
    const noVideo = await app.inject({ method: "POST", url: `/listings/${phone.id}/publish`, headers: tma(SELLER), payload: {} });
    expect(noVideo.statusCode).toBe(400);
    expect(noVideo.json()).toMatchObject({ error: "need_video" });
    expect(noVideo.json().message).toContain("видео-паспорт");

    const monitor = await draft("monitor");
    const ok = await app.inject({ method: "POST", url: `/listings/${monitor.id}/publish`, headers: tma(SELLER), payload: {} });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().listing.status).toBe("active");

    // A clip the AI cannot read (not really a video) still counts as the passport: the check is "unknown".
    const up = await upload(phone.id, Buffer.alloc(50_000, 7));
    expect(up.statusCode, up.body).toBe(200);
    expect(up.json().videoCheck).toMatchObject({ verdict: "unknown", seen: [] });
    const published = await app.inject({ method: "POST", url: `/listings/${phone.id}/publish`, headers: tma(SELLER), payload: {} });
    expect(published.statusCode, published.body).toBe(200);
    const item = (await app.inject({ url: `/catalog/${phone.id}`, headers: tma(BUYER) })).json() as CatalogItem;
    expect(item.passport!.checks.find((c) => c.code === "video")).toMatchObject({ status: "ok", source: "seller" });

    // The catalog filter «С видео-паспортом» keeps the phone and drops the monitor published without one.
    const withVideo = (await app.inject({ url: "/catalog?withVideo=true&sort=newest", headers: tma(BUYER) })).json() as { items: CatalogItem[] };
    const ids = withVideo.items.map((i) => i.listing.id);
    expect(ids).toContain(phone.id);
    expect(ids).not.toContain(monitor.id);
    expect(withVideo.items.every((i) => !!i.listing.video)).toBe(true);
    const all = (await app.inject({ url: "/catalog?sort=newest", headers: tma(BUYER) })).json() as { items: CatalogItem[] };
    expect(all.items.map((i) => i.listing.id)).toContain(monitor.id);
  });

  it.skipIf(!ffmpeg)("frames are taken from a real clip; the AI verdict lands in the response, the DTO and the passport", async () => {
    const clip = realClip(dir);
    const frames = await extractFrames(await import("node:fs").then((fs) => fs.readFileSync(clip)), "mp4");
    expect(frames.seconds).toBeGreaterThan(1.5);
    expect(frames.jpegs.length).toBeGreaterThanOrEqual(3);
    expect(frames.jpegs[0]!.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8])); // JPEG magic

    const l = await draft("smartphone");
    seen = {};
    aiCalls.length = 0;
    const pass = await upload(l.id, await import("node:fs").then((fs) => fs.readFileSync(clip)));
    expect(pass.statusCode, pass.body).toBe(200);
    expect(aiCalls).toEqual(["video_check"]);
    expect(pass.json().videoCheck).toMatchObject({ verdict: "pass", seen: ["device_on", "identifier", "battery", "account", "body"] });
    expect(pass.json().videoCheck.noteRu).toContain("IMEI");
    // The AI saw 5 images and the listing's category.
    const call = ai.calls.find((c) => c.promptId === "video_check")!;
    const content = call.content as Array<{ type: string; text?: string }>;
    expect(content.filter((c) => c.type === "image").length).toBe(frames.jpegs.length);
    expect(JSON.parse(content.find((c) => c.type === "text")!.text!)).toMatchObject({ category: "smartphone" });

    const mine = (await app.inject({ url: `/listings/${l.id}`, headers: tma(SELLER) })).json() as ListingDto;
    expect(mine.videoCheck?.verdict).toBe("pass");
    await app.inject({ method: "POST", url: `/listings/${l.id}/publish`, headers: tma(SELLER), payload: {} });
    const item = (await app.inject({ url: `/catalog/${l.id}`, headers: tma(BUYER) })).json() as CatalogItem;
    expect(item.passport!.checks.find((c) => c.code === "video")).toMatchObject({ status: "ok", source: "ishonch" });

    // Missing steps → warn; no working device → fail. A new upload replaces the verdict.
    seen = { account_screen: false, battery_screen: false };
    const warn = await upload(l.id, await import("node:fs").then((fs) => fs.readFileSync(clip)));
    expect(warn.json().videoCheck).toMatchObject({ verdict: "warn", seen: ["device_on", "identifier", "body"] });
    seen = { device_visible: false, powered_on: false };
    const fail = await upload(l.id, await import("node:fs").then((fs) => fs.readFileSync(clip)));
    expect(fail.json().videoCheck.verdict).toBe("fail");
    const after = (await app.inject({ url: `/catalog/${l.id}`, headers: tma(BUYER) })).json() as CatalogItem;
    expect(after.passport!.checks.find((c) => c.code === "video")).toMatchObject({ status: "fail", source: "ishonch" });
  });

  it("the media route answers byte ranges (iPhone Safari needs 206 to play a video)", async () => {
    const l = await draft("smartphone");
    const clip = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
    const up = await upload(l.id, clip);
    const url = up.json().video as string;
    const full = await app.inject({ url });
    expect([full.statusCode, full.headers["accept-ranges"], full.rawPayload.length]).toEqual([200, "bytes", 1000]);
    const part = await app.inject({ url, headers: { range: "bytes=10-19" } });
    expect([part.statusCode, part.headers["content-range"], part.rawPayload.equals(clip.subarray(10, 20))]).toEqual([206, "bytes 10-19/1000", true]);
    const open = await app.inject({ url, headers: { range: "bytes=990-" } });
    expect([open.statusCode, open.headers["content-range"], open.rawPayload.length]).toEqual([206, "bytes 990-999/1000", 10]);
    const tail = await app.inject({ url, headers: { range: "bytes=-5" } });
    expect([tail.statusCode, tail.headers["content-range"]]).toEqual([206, "bytes 995-999/1000"]);
    const beyond = await app.inject({ url, headers: { range: "bytes=5000-" } });
    expect([beyond.statusCode, beyond.headers["content-range"]]).toEqual([416, "bytes */1000"]);
  });

  it.skipIf(!ffmpeg)("the IMEI read on the video is compared with the one the seller entered", async () => {
    const clip = await import("node:fs").then((fs) => fs.readFileSync(realClip(dir)));
    const l = await draft("smartphone", { imei: "356938035643809" });
    seen = { identifier_screen: true, imei_tail: "3809" };
    const ok = (await upload(l.id, clip)).json().videoCheck;
    expect(ok.verdict).toBe("pass");
    const mine = (await app.inject({ url: `/listings/${l.id}`, headers: tma(SELLER) })).json() as ListingDto;
    expect(mine.videoCheck).toMatchObject({ imeiMatch: true, verdict: "pass" });

    // Another device on the video: the digits differ → a warning for the buyer, the video stays.
    seen = { identifier_screen: true, imei_tail: "1111" };
    await upload(l.id, clip);
    const bad = (await app.inject({ url: `/listings/${l.id}`, headers: tma(SELLER) })).json() as ListingDto;
    expect(bad.videoCheck).toMatchObject({ imeiMatch: false, verdict: "warn" });
    expect(bad.videoCheck!.noteRu).toContain("IMEI на видео не совпадает");

    // Nothing readable: no claim either way.
    seen = { identifier_screen: true, imei_tail: "" };
    await upload(l.id, clip);
    const none = (await app.inject({ url: `/listings/${l.id}`, headers: tma(SELLER) })).json() as ListingDto;
    expect(none.videoCheck!.imeiMatch).toBeNull();
    // Publishing with the mismatch goes to a moderator instead of straight to the catalog.
    seen = { identifier_screen: true, imei_tail: "1111" };
    await upload(l.id, clip);
    const held = await app.inject({ method: "POST", url: `/listings/${l.id}/publish`, headers: tma(SELLER), payload: {} });
    expect(held.statusCode, held.body).toBe(200);
    expect(held.json()).toMatchObject({ moderation: "needs_review" });
    expect(held.json().listing.status).toBe("pending");
    seen = {};
  });

  it("an AI outage keeps the video and marks the check unknown", async () => {
    if (!ffmpeg) return;
    const l = await draft("smartphone");
    const broken = { ...ai, structured: async () => { throw new Error("provider down"); } };
    const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: url, BOT_TOKEN, INTERNAL_API_TOKEN: "internal-secret" } as NodeJS.ProcessEnv);
    const app2 = await buildApp({ config, db, ai: broken, storage: new FsStorage(dir), publisher: gateway });
    try {
      const body = multipart(await import("node:fs").then((fs) => fs.readFileSync(realClip(dir))), "video/mp4");
      const res = await app2.inject({ method: "POST", url: `/listings/${l.id}/video`, headers: { ...tma(SELLER), "content-type": body.contentType }, payload: body.payload });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ videoCheck: { verdict: "unknown" } });
      expect(res.json().video).toMatch(/^\/media\//);
    } finally {
      await app2.close();
    }
  });

  it("compare accepts up to 4 listings", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const l = await draft("monitor");
      await app.inject({ method: "POST", url: `/listings/${l.id}/publish`, headers: tma(SELLER), payload: {} });
      ids.push(l.id);
    }
    const batch = (await app.inject({ url: `/catalog/batch?ids=${ids.slice(0, 4).join(",")}&passport=1`, headers: tma(BUYER) })).json() as CatalogItem[];
    expect(batch).toHaveLength(4);
    expect(batch.every((i) => i.passport && i.passport.total > 0)).toBe(true);
    const plain = (await app.inject({ url: `/catalog/batch?ids=${ids[0]}`, headers: tma(BUYER) })).json() as CatalogItem[];
    expect(plain[0]!.passport).toBeUndefined();
    expect((await app.inject({ method: "POST", url: "/assistant/compare", headers: tma(BUYER), payload: { ids } })).statusCode).toBe(400);
  });
});
