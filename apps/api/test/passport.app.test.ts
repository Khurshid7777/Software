import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { eq, sql as dsql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { computeGrade, CONDITIONS, type CatalogItem, type CatalogPage, type ConditionChecklist, type ListingInsights, type OrderDto } from "@ishonch/shared";
import { buildApp } from "../src/app.js";
import { buildInitData } from "../src/auth/telegram.js";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { listings, orders, priceReference, stolenReports } from "../src/db/schema.js";
import type { CourierProvider } from "../src/modules/orders/courier.js";
import { FsStorage } from "../src/storage/storage.js";
import type { ChannelPublisher, Notifier, NotifyButton } from "../src/telegram/publisher.js";
import sharp from "sharp";
import { mockAiByPrompt } from "./helpers.js";

function multipart(parts: Array<{ name: string; value: Buffer; filename: string; type: string }>) {
  const boundary = "----ishonch-evidence";
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\nContent-Type: ${p.type}\r\n\r\n`),
      p.value,
      Buffer.from("\r\n"),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}
const jpeg = (seed: number) =>
  sharp({ create: { width: 64, height: 64, channels: 3, background: { r: seed * 40, g: 120, b: 200 } } }).jpeg().toBuffer();

const url = process.env.TEST_DATABASE_URL ?? "postgres://ishonch:ishonch@localhost:5432/ishonch";
const reachable = await postgres(url, { max: 1, connect_timeout: 2 })`select 1`
  .then(() => true)
  .catch(() => false);

const BOT_TOKEN = "123456:TEST";
const SELLER = 990_200_001;
const BUYER = 990_200_002;
const OPERATOR = 990_200_003;
const ADMIN = 990_200_004;
const SELLER2 = 990_200_005;
const ALL = [SELLER, BUYER, OPERATOR, ADMIN, SELLER2];
const MODERATORS = -100_990_200;
// A model of our own, so the price reference of other tests and seeds does not matter.
const MODEL = "testbrand phone p9 256gb";

describe.skipIf(!reachable)("item passport: grade, checks, IMEI history, grade filter (integration)", () => {
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

  async function liveListing(extra: Partial<typeof listings.$inferInsert> = {}, seller = SELLER) {
    const [row] = await db
      .insert(listings)
      .values({
        sellerUserId: await userId(seller),
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

  /** Request → seller confirms → courier → delivered; returns the order id. */
  async function deliveredOrder(listingId: string) {
    const o = (await post(BUYER, "/orders", { listingId, mode: "cod_seller", district: "yunusobod", address: "Amir Temur 1" })).json() as OrderDto;
    await app.inject({ method: "POST", url: `/orders/${o.id}/confirm`, headers: internal(SELLER) });
    for (const status of ["courier_assigned", "picked_up", "delivered"]) {
      await app.inject({ method: "POST", url: `/operator/orders/${o.id}/status`, headers: internal(OPERATOR), payload: { status } });
    }
    return o.id;
  }

  beforeAll(async () => {
    storageDir = mkdtempSync(join(tmpdir(), "ishonch-passport-"));
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: url,
      BOT_TOKEN,
      INTERNAL_API_TOKEN: "internal-secret",
      OPERATOR_TELEGRAM_IDS: String(OPERATOR),
      ADMIN_TELEGRAM_IDS: String(ADMIN),
      MODERATION_CHAT_ID: String(MODERATORS),
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
    for (const tg of [SELLER, BUYER, SELLER2]) {
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

  it("the stored grade (generated column) always equals computeGrade()", async () => {
    const lists: ConditionChecklist[] = [
      {},
      { batteryPct: 90 },
      { batteryPct: 84 },
      { batteryPct: 79 },
      { repairs: ["none"] },
      { repairs: ["screen", "battery"] },
      { biometrics: "broken" },
      { deadPixels: "few" },
      { deadPixels: "many" },
      { mining: "yes" },
      { batteryPct: 82, repairs: ["back"], deadPixels: "few" },
    ];
    for (const condition of CONDITIONS) {
      for (const checklist of lists) {
        const l = await liveListing({ condition, checklist });
        const [row] = await db.select({ grade: listings.grade }).from(listings).where(eq(listings.id, l.id));
        expect([condition, checklist, row!.grade]).toEqual([condition, checklist, computeGrade(condition, checklist).grade]);
      }
    }
    const none = await liveListing({ condition: null });
    expect((await db.select({ grade: listings.grade }).from(listings).where(eq(listings.id, none.id)))[0]!.grade).toBeNull();
  });

  it("passport: grade with reasons, checks naming who confirmed them, history by IMEI without who sold it", async () => {
    const imei = "356938035643809";
    // The same phone sold earlier by someone else; the courier's inspection then passed.
    const earlier = await liveListing({ imei, status: "sold", soldAt: new Date(Date.now() - 60 * 864e5), publishedAt: new Date(Date.now() - 70 * 864e5), price: 5_200_000 }, SELLER2);
    const buyer = await userId(BUYER);
    await db.insert(orders).values({
      listingId: earlier.id,
      buyerUserId: buyer,
      sellerUserId: earlier.sellerUserId,
      mode: "cod_seller",
      status: "delivered",
      district: "chilonzor",
      address: "x",
      quote: {},
      feePayer: "buyer",
      inspection: { checks: { screen: true }, passed: true, note: null, at: new Date().toISOString() },
    });
    const l = await liveListing({
      imei,
      condition: "like_new",
      checklist: { accountUnlocked: true, batteryPct: 82, repairs: ["none"], kit: ["box", "charger"] },
    });

    const item = await get<CatalogItem>(BUYER, `/catalog/${l.id}`);
    const p = item.passport!;
    expect(item.listing.grade).toBe("B");
    expect(p).toMatchObject({ grade: "B", reasons: ["battery_worn"] });
    const check = (code: string) => p.checks.find((c) => c.code === code);
    expect(check("inspection")).toMatchObject({ status: "unknown", source: "courier" });
    expect(check("imei")).toMatchObject({ status: "ok", source: "ishonch" });
    expect(check("account")).toMatchObject({ status: "ok", source: "seller" });
    expect(check("battery")).toMatchObject({ status: "ok", params: { pct: 82 } });
    expect(check("repairs")).toMatchObject({ status: "ok" });
    expect(check("photos")).toMatchObject({ status: "warn", params: { n: 0 } });
    expect(check("documents")).toMatchObject({ status: "ok" });
    expect(p.total).toBe(p.checks.length);
    expect(p.passed).toBe(p.checks.filter((c) => c.status === "ok").length);
    expect(p.history).toEqual({
      listings: 1,
      sold: 1,
      prices: [{ at: earlier.publishedAt!.toISOString(), price: 5_200_000 }],
      inspections: { passed: 1, failed: 0 },
    });
    expect(JSON.stringify(p.history)).not.toContain(earlier.sellerUserId);

    // A live listing of the same IMEI by another seller makes the IMEI check fail.
    await liveListing({ imei }, SELLER2);
    expect((await get<CatalogItem>(BUYER, `/catalog/${l.id}`)).passport!.checks.find((c) => c.code === "imei")!.status).toBe("fail");
  });

  it("checks follow the category: a monitor has no IMEI or account; no checklist → 'not stated', not failed", async () => {
    const monitor = await liveListing({ category: "monitor", condition: "good", checklist: { deadPixels: "few" }, attributes: { modelKey: null, specs: [] } });
    const p = (await get<CatalogItem>(BUYER, `/catalog/${monitor.id}`)).passport!;
    expect(p.grade).toBe("B");
    expect(p.checks.map((c) => c.code)).toEqual(["inspection", "video", "repairs", "photos", "price", "documents"]);
    expect(p.checks.find((c) => c.code === "repairs")!.status).toBe("unknown");
    expect(p.checks.find((c) => c.code === "price")!.status).toBe("unknown");
    expect(p.history).toBeNull();
  });

  it("catalog filter «Класс A–B» and the seller's tip to confirm the account is unlinked", async () => {
    const good = await liveListing({ titleRu: "Passport filter A", condition: "like_new", checklist: { batteryPct: 95 } });
    const worn = await liveListing({ titleRu: "Passport filter C", condition: "like_new", checklist: { batteryPct: 70 } });
    const page = await get<CatalogPage>(BUYER, "/catalog?goodGrade=true&q=Passport%20filter");
    const ids = page.items.map((i) => i.listing.id);
    expect(ids).toContain(good.id);
    expect(ids).not.toContain(worn.id);
    expect(page.items.every((i) => i.listing.grade === "A" || i.listing.grade === "B")).toBe(true);

    const tips = (await get<ListingInsights>(SELLER, `/listings/${good.id}/insights`)).tips.map((t) => t.code);
    expect(tips).toContain("no_account_check");
    await db.update(listings).set({ checklist: { batteryPct: 95, accountUnlocked: true } }).where(eq(listings.id, good.id));
    expect((await get<ListingInsights>(SELLER, `/listings/${good.id}/insights`)).tips.map((t) => t.code)).not.toContain("no_account_check");
  });

  // ---------------- evidence (stage 15) ----------------

  it("evidence: dispute photos (buyer, open dispute, up to 3), courier photos in the passport, signed media URLs", async () => {
    const l = await liveListing({ titleRu: "Evidence phone" });
    const id = await deliveredOrder(l.id);
    const upload = (who: number | null, path: string, files: Buffer[], type = "image/jpeg") => {
      const body = multipart(files.map((value, i) => ({ name: "photos", value, filename: `p${i}.jpg`, type })));
      return app.inject({
        method: "POST",
        url: path,
        headers: { ...(who === OPERATOR ? internal(OPERATOR) : who ? tma(who) : {}), "content-type": body.contentType },
        payload: body.payload,
      });
    };
    // No dispute yet → nothing to attach to.
    expect((await upload(BUYER, `/orders/${id}/dispute/photos`, [await jpeg(1)])).statusCode).toBe(404);
    await post(BUYER, `/orders/${id}/dispute`, { reason: "hidden_defect", text: "Через день перестал заряжаться" });
    expect((await upload(SELLER, `/orders/${id}/dispute/photos`, [await jpeg(1)])).statusCode).toBe(404);
    expect((await upload(BUYER, `/orders/${id}/dispute/photos`, [Buffer.from("not an image")])).json().error).toBe("bad_image");
    const added = await upload(BUYER, `/orders/${id}/dispute/photos`, [await jpeg(1), await jpeg(2)]);
    expect(added.statusCode).toBe(200);
    expect(added.json().photos).toHaveLength(2);
    expect((await upload(BUYER, `/orders/${id}/dispute/photos`, [await jpeg(3), await jpeg(4)])).json().error).toBe("too_many_photos");
    const view = await get<OrderDto>(BUYER, `/orders/${id}`);
    expect(view.dispute!.photos).toHaveLength(2);

    // Signed URL: works without auth, a tampered signature does not.
    const url = view.dispute!.photos[0]!;
    const media = await app.inject({ url });
    expect(media.statusCode).toBe(200);
    expect(media.headers["content-type"]).toBe("image/jpeg");
    // Always change the first character: a signature that already starts with "x" would stay valid.
    const tampered = url.replace(/s=(.)/, (_, c: string) => `s=${c === "x" ? "y" : "x"}`);
    expect((await app.inject({ url: tampered })).statusCode).toBe(404);

    // The courier's photos: operators only; a passed inspection puts them into the passport.
    expect((await upload(BUYER, `/operator/orders/${id}/inspection/photos`, [await jpeg(5)])).statusCode).toBe(403);
    expect((await upload(OPERATOR, `/operator/orders/${id}/inspection/photos`, [await jpeg(5), await jpeg(6)])).json().photos).toHaveLength(2);
    await db
      .update(orders)
      .set({ inspection: { checks: { matches_description: true }, passed: true, note: null, at: new Date().toISOString() } })
      .where(eq(orders.id, id));
    await db.update(listings).set({ status: "active", verifiedAt: new Date(), verification: { checks: {}, passed: true, note: null, at: new Date().toISOString() } }).where(eq(listings.id, l.id));
    const p = (await get<CatalogItem>(BUYER, `/catalog/${l.id}`)).passport!;
    expect(p.inspectionPhotos).toHaveLength(2);
    expect(p.checks.find((c) => c.code === "inspection")).toMatchObject({ status: "ok", params: { photos: 2 } });
    const admin = (await get<Array<{ orderId: string; photos: string[]; inspectionPhotos: string[] }>>(ADMIN, "/admin/disputes")).find((d) => d.orderId === id)!;
    expect([admin.photos.length, admin.inspectionPhotos.length]).toEqual([2, 2]);
  });

  it("IMEI check for any phone: invalid, clean, seen, several sellers at once, reported, daily limit", async () => {
    // Valid IMEIs of our own: 14 digits + the Luhn check digit.
    const imeiOf = (base: string) => {
      let sum = 0;
      for (let i = 0; i < 14; i++) {
        let d = Number(base[i]);
        if (i % 2 === 1) {
          d *= 2;
          if (d > 9) d -= 9;
        }
        sum += d;
      }
      return base + String((10 - (sum % 10)) % 10);
    };
    const check = async (who: number, imei: string) => app.inject({ method: "POST", url: "/imei/check", headers: tma(who), payload: { imei } });
    const stamp = String(Date.now()).slice(-8);

    expect((await check(BUYER, "12345")).json()).toMatchObject({ verdict: "invalid", tail: null });

    const fresh = imeiOf(`35${stamp}0000`.slice(0, 14));
    const clean = (await check(BUYER, fresh.replace(/(\d{2})(\d{6})(\d{6})(\d)/, "$1 $2 $3 $4"))).json();
    expect(clean).toMatchObject({ verdict: "clean", reported: false, tail: fresh.slice(-4), seen: { listings: 0, active: 0 } });

    // One seller, one live listing and an earlier sold one: counts, still clean.
    const one = imeiOf(`35${stamp}1111`.slice(0, 14));
    await liveListing({ imei: one, status: "sold", soldAt: new Date(), publishedAt: new Date(Date.now() - 5 * 864e5) });
    await liveListing({ imei: one });
    expect((await check(BUYER, one)).json()).toMatchObject({ verdict: "clean", seen: { listings: 2, active: 1, sellersNow: 1, sold: 1 } });

    // The same device at two sellers at once: caution.
    const two = imeiOf(`35${stamp}2222`.slice(0, 14));
    await liveListing({ imei: two }, SELLER);
    await liveListing({ imei: two }, SELLER2);
    expect((await check(BUYER, two)).json()).toMatchObject({ verdict: "caution", seen: { sellersNow: 2 } });

    // An owner's open report: danger. Withdrawn: back to what the data shows. Nobody's name anywhere in the answer.
    const stolen = imeiOf(`35${stamp}3333`.slice(0, 14));
    const [report] = await db.insert(stolenReports).values({ userId: await userId(SELLER2), imei: stolen, kind: "stolen" }).returning();
    const danger = (await check(BUYER, stolen)).json();
    expect(danger).toMatchObject({ verdict: "danger", reported: true });
    expect(JSON.stringify(danger)).not.toMatch(/userId|police|"seller"|telegram/i);
    await db.update(stolenReports).set({ withdrawnAt: new Date() }).where(eq(stolenReports.id, report!.id));
    expect((await check(BUYER, stolen)).json()).toMatchObject({ verdict: "clean", reported: false });

    // The daily limit protects the base from being harvested; an invalid number costs nothing.
    let last = 200;
    for (let i = 0; i < 25 && last === 200; i++) last = (await check(ADMIN, imeiOf(`36${String(i).padStart(4, "0")}${stamp}`.slice(0, 14)))).statusCode;
    expect(last).toBe(429);
    expect((await check(ADMIN, "abc")).statusCode).toBe(200);
  });

  it("evidence: the seller's video check — owner only, video types, 20 MB, shown on the listing and in the passport", async () => {
    const l = await liveListing({ titleRu: "Video phone" });
    const send = (who: number, value: Buffer, type = "video/mp4") => {
      const body = multipart([{ name: "video", value, filename: "check.mp4", type }]);
      return app.inject({ method: "POST", url: `/listings/${l.id}/video`, headers: { ...tma(who), "content-type": body.contentType }, payload: body.payload });
    };
    const clip = Buffer.alloc(200_000, 7);
    expect((await send(BUYER, clip)).statusCode).toBe(404);
    expect((await send(SELLER, clip, "image/jpeg")).json().error).toBe("bad_video");
    expect((await send(SELLER, Buffer.alloc(21 * 1024 * 1024, 1))).statusCode).toBe(413);
    const ok = await send(SELLER, clip);
    expect(ok.statusCode).toBe(200);
    const item = await get<CatalogItem>(BUYER, `/catalog/${l.id}`);
    expect(item.listing.video).toBe(ok.json().video);
    expect(item.passport!.checks.find((c) => c.code === "video")).toMatchObject({ status: "ok", source: "seller" });
    const media = await app.inject({ url: item.listing.video! });
    expect([media.statusCode, media.headers["content-type"], media.rawPayload.length]).toEqual([200, "video/mp4", 200_000]);

    // A new upload replaces the old clip; delete removes it.
    const second = (await send(SELLER, Buffer.alloc(1000, 9), "video/webm")).json().video;
    expect(second).not.toBe(ok.json().video);
    expect((await app.inject({ url: ok.json().video })).statusCode).toBe(404);
    await app.inject({ method: "DELETE", url: `/listings/${l.id}/video`, headers: tma(SELLER) });
    expect((await get<CatalogItem>(BUYER, `/catalog/${l.id}`)).listing.video).toBeNull();
  });
});
