import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { eq, sql as dsql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { isValidImei, type CatalogItem, type DeliveryQuote, type ListingDto, type OfferDto, type OrderDto } from "@ishonch/shared";
import { buildApp } from "../src/app.js";
import { buildInitData } from "../src/auth/telegram.js";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { conversationMessages, conversations, listings, offers } from "../src/db/schema.js";
import type { CourierProvider } from "../src/modules/orders/courier.js";
import { FsStorage } from "../src/storage/storage.js";
import type { ChannelPublisher, Notifier, NotifyButton } from "../src/telegram/publisher.js";
import { mockAiByPrompt } from "./helpers.js";

const url = process.env.TEST_DATABASE_URL ?? "postgres://ishonch:ishonch@localhost:5432/ishonch";
const reachable = await postgres(url, { max: 1, connect_timeout: 2 })`select 1`
  .then(() => true)
  .catch(() => false);

const BOT_TOKEN = "123456:TEST";
const SELLER = 940_000_001;
const BUYER = 940_000_002;
const BUYER2 = 940_000_003;
const SELLER2 = 940_000_004;
const OPERATOR = 940_000_005;
const ALL = [SELLER, BUYER, BUYER2, SELLER2, OPERATOR];
const IMEI = "490154203237518";
const IMEI2 = "356938035643809";

describe.skipIf(!reachable)("offers, price drops, IMEI, reply time (integration)", () => {
  let app: FastifyInstance;
  let close: () => Promise<unknown>;
  let db: ReturnType<typeof createDb>["db"];
  let storageDir: string;
  const dms: Array<{ chatId: number; text: string; buttons: NotifyButton[][] }> = [];

  const ai = mockAiByPrompt({
    listing_moderate: { decision: "approved", reasons: [], seller_message_ru: "", seller_message_uz: "" },
  });
  const gateway: ChannelPublisher & Notifier = {
    post: async () => ({ messageId: 1 }),
    miniAppLink: async (p) => `https://t.me/ishonch_bot/app?startapp=${p}`,
    send: async (chatId, text, buttons = []) => void dms.push({ chatId, text, buttons }),
  };
  const courier: CourierProvider = { name: "manual", createShipment: async () => ({ externalId: null }), cancelShipment: async () => undefined };

  const tma = (id: number) => ({ authorization: `tma ${buildInitData({ id, language_code: "ru" }, BOT_TOKEN)}` });
  const internal = (id: number) => ({ authorization: "Internal internal-secret", "x-telegram-user": JSON.stringify({ id, language_code: "ru" }) });
  const userId = async (tg: number) => (await app.inject({ url: "/me", headers: tma(tg) })).json().id as string;
  const dmsTo = (tg: number) => dms.filter((d) => d.chatId === tg);
  const callbacks = (d: { buttons: NotifyButton[][] }) => d.buttons.flat().map((b) => ("callbackData" in b ? b.callbackData : b.url));

  async function liveListing(seller: number, extra: Partial<typeof listings.$inferInsert> = {}) {
    const [row] = await db
      .insert(listings)
      .values({
        sellerUserId: await userId(seller),
        category: "smartphone",
        titleRu: "iPhone 13 128 ГБ",
        titleUz: "iPhone 13 128 GB",
        descriptionRu: "Отличное состояние",
        descriptionUz: "A'lo holatda",
        attributes: { modelKey: "apple iphone 13 128gb", specs: [] },
        condition: "good",
        price: 6_000_000,
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
  const offer = (who: number, listingId: string, amount: number) =>
    app.inject({ method: "POST", url: `/listings/${listingId}/offers`, headers: tma(who), payload: { amount } });
  const decide = (who: number, offerId: string, decision: string) =>
    app.inject({ method: "POST", url: `/offers/${offerId}/${decision}`, headers: internal(who) });
  const patch = (who: number, id: string, body: Record<string, unknown>) =>
    app.inject({ method: "PATCH", url: `/listings/${id}`, headers: tma(who), payload: body });
  const card = async (who: number, id: string) => (await app.inject({ url: `/catalog/${id}`, headers: tma(who) })).json() as CatalogItem;

  beforeAll(async () => {
    storageDir = mkdtempSync(join(tmpdir(), "ishonch-market-"));
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: url,
      BOT_TOKEN,
      INTERNAL_API_TOKEN: "internal-secret",
      OPERATOR_TELEGRAM_IDS: String(OPERATOR),
    } as NodeJS.ProcessEnv);
    const created = createDb(url);
    db = created.db;
    close = () => created.sql.end();
    app = await buildApp({ config, db, ai, storage: new FsStorage(storageDir), publisher: gateway, courier });
    await db.execute(dsql`update listings set status = 'archived' where status in ('active', 'pending', 'reserved')`);
    await app.services.orders.replaceTariffs([{ name: "default", fromDistrict: null, toDistrict: null, price: 30_000, codFeePct: 1, active: true }]);
  });

  beforeEach(async () => {
    dms.length = 0;
    await db.execute(dsql.raw(`delete from users where telegram_id in (${ALL.join(",")})`));
    for (const tg of [SELLER, BUYER, BUYER2, SELLER2]) {
      await app.inject({ method: "POST", url: "/internal/phone", headers: internal(tg), payload: { phone: `+99890${String(tg).slice(-7)}` } });
    }
  });

  afterAll(async () => {
    await db.execute(dsql.raw(`delete from users where telegram_id in (${ALL.join(",")})`));
    await app.close();
    await close();
    rmSync(storageDir, { recursive: true, force: true });
  });

  // ---------------- offers ----------------

  it("offer → seller accepts in the bot → the buyer's quote and order use the agreed price", async () => {
    const l = await liveListing(SELLER);
    const res = await offer(BUYER, l.id, 5_500_000);
    expect(res.statusCode).toBe(200);
    const o = res.json() as OfferDto;
    expect(o).toMatchObject({ status: "pending", amount: 5_500_000, listPrice: 6_000_000 });

    const toSeller = dmsTo(SELLER).at(-1)!;
    expect(toSeller.text).toContain("5 500 000");
    expect(callbacks(toSeller)).toEqual(expect.arrayContaining([`offer:accept:${o.id}`, `offer:decline:${o.id}`]));

    // Only the seller may answer.
    expect((await decide(BUYER2, o.id, "accept")).statusCode).toBe(403);
    const accepted = await decide(SELLER, o.id, "accept");
    expect(accepted.json()).toMatchObject({ status: "accepted" });
    expect((await decide(SELLER, o.id, "decline")).statusCode).toBe(409); // second tap changes nothing
    expect(dmsTo(BUYER).at(-1)!.text).toContain("согласен");

    const mine = (await app.inject({ url: `/listings/${l.id}/offers/mine`, headers: tma(BUYER) })).json() as { offer: OfferDto };
    expect(mine.offer.status).toBe("accepted");

    const q = (await app.inject({ url: `/orders/quote?listingId=${l.id}&district=yunusobod&mode=cod_seller`, headers: tma(BUYER) })).json() as DeliveryQuote;
    expect(q.itemPrice).toBe(5_500_000);
    // Another buyer still sees the asking price.
    const q2 = (await app.inject({ url: `/orders/quote?listingId=${l.id}&district=yunusobod&mode=cod_seller`, headers: tma(BUYER2) })).json() as DeliveryQuote;
    expect(q2.itemPrice).toBe(6_000_000);

    const created = await app.inject({
      method: "POST",
      url: "/orders",
      headers: tma(BUYER),
      payload: { listingId: l.id, mode: "cod_seller", district: "yunusobod", address: "Amir Temur 1" },
    });
    expect(created.statusCode).toBe(200);
    expect((created.json() as OrderDto).quote.itemPrice).toBe(5_500_000);
  });

  it("offer rules: below the asking price, not below half, one pending per listing, not on own listing", async () => {
    const l = await liveListing(SELLER);
    expect((await offer(BUYER, l.id, 6_000_000)).json().error).toBe("offer_not_lower");
    expect((await offer(BUYER, l.id, 2_900_000)).json().error).toBe("offer_too_low");
    expect((await offer(SELLER, l.id, 5_000_000)).json().error).toBe("own_listing");
    expect((await offer(BUYER, l.id, 5_000_000)).statusCode).toBe(200);
    const again = await offer(BUYER, l.id, 5_200_000);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("offer_pending");

    // Declined → the buyer may try again; the seller can't accept on a listing that left sale.
    const [pending] = await db.select().from(offers).where(eq(offers.listingId, l.id));
    expect((await decide(SELLER, pending!.id, "decline")).json().status).toBe("declined");
    expect(dmsTo(BUYER).at(-1)!.text).toContain("не согласился");
    const second = (await offer(BUYER, l.id, 5_400_000)).json() as OfferDto;
    await db.update(listings).set({ status: "sold" }).where(eq(listings.id, l.id));
    expect((await decide(SELLER, second.id, "accept")).statusCode).toBe(409);
  });

  it("expired offers: a pending one stops blocking, an accepted one no longer changes the quote", async () => {
    const l = await liveListing(SELLER);
    const o = (await offer(BUYER, l.id, 5_000_000)).json() as OfferDto;
    await db.update(offers).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(offers.id, o.id));
    expect((await decide(SELLER, o.id, "accept")).statusCode).toBe(409);
    const fresh = (await offer(BUYER, l.id, 5_100_000)).json() as OfferDto;
    await decide(SELLER, fresh.id, "accept");
    await db.update(offers).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(offers.id, fresh.id));
    const q = (await app.inject({ url: `/orders/quote?listingId=${l.id}&district=yunusobod&mode=delivery_only`, headers: tma(BUYER) })).json() as DeliveryQuote;
    expect(q.itemPrice).toBe(6_000_000);
    expect(await app.services.orders.expireOffers()).toBeGreaterThanOrEqual(1);
    const mine = (await app.inject({ url: `/listings/${l.id}/offers/mine`, headers: tma(BUYER) })).json() as { offer: OfferDto };
    expect(mine.offer.status).toBe("expired");
  });

  // ---------------- price drops ----------------

  it("price drop: favorites get one alert, the old price is shown crossed out; a raise clears it", async () => {
    const l = await liveListing(SELLER);
    for (const tg of [BUYER, BUYER2]) await app.inject({ method: "POST", url: `/favorites/${l.id}`, headers: tma(tg) });
    const fav = await card(BUYER, l.id);
    expect(fav.favorite).toBe(true);

    // A tiny cut (< 3 %) does not alert anyone.
    await patch(SELLER, l.id, { price: 5_950_000 });
    expect(dmsTo(BUYER)).toHaveLength(0);

    await patch(SELLER, l.id, { price: 5_500_000 });
    for (const tg of [BUYER, BUYER2]) {
      const alert = dmsTo(tg).at(-1)!;
      expect(alert.text).toContain("6 000 000");
      expect(alert.text).toContain("5 500 000");
      expect(callbacks(alert)[0]).toContain(`listing_${l.id}`);
    }
    expect(dmsTo(SELLER)).toHaveLength(0);
    // The badge keeps the highest price of the period (several small cuts read as one).
    expect((await card(BUYER, l.id)).listing.previousPrice).toBe(6_000_000);

    // A second cut the same day: no second alert to the same people.
    await patch(SELLER, l.id, { price: 5_000_000 });
    expect(dmsTo(BUYER)).toHaveLength(1);

    await patch(SELLER, l.id, { price: 6_000_000 });
    expect((await card(BUYER, l.id)).listing.previousPrice).toBeNull();
  });

  // ---------------- IMEI ----------------

  it("IMEI format: 15 digits with a Luhn check digit", () => {
    expect(isValidImei(IMEI)).toBe(true);
    expect(isValidImei(IMEI2)).toBe(true);
    expect(isValidImei("490154203237519")).toBe(false);
    expect(isValidImei("111111111111111")).toBe(false);
    expect(isValidImei("12345")).toBe(false);
  });

  it("IMEI on a listing: validation, visibility, and another seller's same IMEI goes to moderators", async () => {
    const l = await liveListing(SELLER);
    expect((await patch(SELLER, l.id, { imei: "490154203237519" })).statusCode).toBe(400);
    const ok = await patch(SELLER, l.id, { imei: "49-0154 2032 37518" });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as ListingDto).imei).toBe(IMEI);

    const pub = (await card(BUYER, l.id)).listing;
    expect(pub.imei).toBeUndefined();
    expect(pub.imeiTail).toBe("7518");

    // Same IMEI from another seller: held for review with the reason, the first listing stays live.
    const other = await liveListing(SELLER2);
    const res = await patch(SELLER2, other.id, { imei: IMEI });
    expect(res.statusCode).toBe(200);
    const [held] = await db.select().from(listings).where(eq(listings.id, other.id));
    expect(held!.status).toBe("pending");
    expect(held!.moderationReason).toBe("duplicate_imei");
    expect((held!.moderation as { duplicates?: string[] }).duplicates).toContain(l.id);
    const [first] = await db.select().from(listings).where(eq(listings.id, l.id));
    expect(first!.status).toBe("active");

    // A reserved listing's IMEI can't be swapped.
    await db.update(listings).set({ status: "reserved" }).where(eq(listings.id, l.id));
    expect((await patch(SELLER, l.id, { imei: IMEI2 })).statusCode).toBe(409);

    // The operator sees the full IMEI to compare at pickup.
    await db.update(listings).set({ status: "active" }).where(eq(listings.id, l.id));
    await app.inject({
      method: "POST",
      url: "/orders",
      headers: tma(BUYER),
      payload: { listingId: l.id, mode: "delivery_only", district: "yunusobod", address: "Amir Temur 1" },
    });
    const list = (await app.inject({ url: "/operator/orders", headers: internal(OPERATOR) })).json() as Array<OrderDto & { imei: string | null }>;
    expect(list.find((o) => o.listing.id === l.id)?.imei).toBe(IMEI);
  });

  // ---------------- reply time ----------------

  it("seller reply time: median of first replies, shown only with 3+ answered chats", async () => {
    const l = await liveListing(SELLER);
    const seller = await userId(SELLER);
    const buyers = [await userId(BUYER), await userId(BUYER2), await userId(SELLER2)];
    const chat = async (buyer: string, replyAfterMin: number | null) => {
      const t0 = new Date(Date.now() - 3 * 3600_000);
      const [c] = await db.insert(conversations).values({ listingId: l.id, buyerUserId: buyer, sellerUserId: seller }).returning();
      await db.insert(conversationMessages).values({ conversationId: c!.id, senderUserId: buyer, text: "Ещё продаёте?", createdAt: t0 });
      if (replyAfterMin != null) {
        await db
          .insert(conversationMessages)
          .values({ conversationId: c!.id, senderUserId: seller, text: "Да", createdAt: new Date(t0.getTime() + replyAfterMin * 60_000) });
      }
    };
    await chat(buyers[0]!, 5);
    await chat(buyers[1]!, 20);
    expect((await card(BUYER, l.id)).listing.seller!.responseMinutes).toBeNull();
    await chat(buyers[2]!, 90);
    expect((await card(BUYER, l.id)).listing.seller!.responseMinutes).toBe(20);
    await db.delete(conversations).where(eq(conversations.sellerUserId, seller));
  });
});
