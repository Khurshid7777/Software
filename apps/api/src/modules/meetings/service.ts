import { and, count, desc, eq, gte, inArray, lte, isNull, or, sql } from "drizzle-orm";
import {
  MEETINGS_PER_DAY,
  MEETING_REMIND_HOURS,
  MEETING_SPOTS,
  formatUzs,
  listingTitle,
  meetingTimeError,
  t,
  type Lang,
  type MeetingDto,
  type MeetingSpot,
  type MeetingStatus,
} from "@ishonch/shared";
import { startOfTashkentDay, type Repo } from "../../db/repo.js";
import { listings, meetings, users, type Listing, type User } from "../../db/schema.js";
import type { ChannelPublisher, Notifier, NotifyButton } from "../../telegram/publisher.js";

export type MeetingError =
  | "not_found"
  | "own_listing"
  | "not_available"
  | "bad_place"
  | "too_soon"
  | "too_far"
  | "night"
  | "meeting_exists"
  | "too_many_meetings"
  | "bad_state";

export class MeetingRejected extends Error {
  constructor(
    public code: MeetingError,
    public status: number,
  ) {
    super(code);
  }
}

const OPEN: MeetingStatus[] = ["pending", "accepted"];
type Meeting = typeof meetings.$inferSelect;

/** «18 октября, 15:00» in Tashkent time. */
export function meetingTime(at: Date, lang: Lang) {
  return at.toLocaleString(lang === "ru" ? "ru-RU" : "uz-UZ", {
    timeZone: "Asia/Tashkent",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Meetings in person (docs/plan.md, stage 18): Ishonch only helps buyer and seller agree on a safe place and
 * time and reminds both; the money changes hands at the meeting.
 */
export class MeetingService {
  constructor(
    private d: {
      repo: Repo;
      notifier: (Notifier & Pick<ChannelPublisher, "miniAppLink">) | null;
      /** The buyer reports "bought": the listing leaves the catalogue. */
      markSold: (listingId: string) => Promise<boolean>;
    },
  ) {}

  private get db() {
    return this.d.repo.db;
  }

  private place(m: Pick<Meeting, "spot" | "place">, lang: Lang) {
    return m.spot ? t(lang, `meet.spot.${m.spot as MeetingSpot}`) : (m.place ?? "");
  }

  private async dm(u: User, text: string, buttons: NotifyButton[][] = []) {
    if (!this.d.notifier || u.bannedAt) return;
    await this.d.notifier.send(u.telegramId, text, buttons).catch((err) => console.error("meeting notification failed", err));
  }

  private async openButton(lang: Lang) {
    const url = this.d.notifier ? await this.d.notifier.miniAppLink("screen_orders").catch(() => null) : null;
    return url ? [[{ text: t(lang, "meet.open"), url }]] : [];
  }

  async request(buyer: User, listingId: string, input: { spot?: MeetingSpot | null; place?: string | null; at: Date; note?: string | null }, now = new Date()) {
    const [l] = await this.db.select().from(listings).where(eq(listings.id, listingId));
    if (!l) throw new MeetingRejected("not_found", 404);
    if (l.sellerUserId === buyer.id) throw new MeetingRejected("own_listing", 409);
    if (l.status !== "active") throw new MeetingRejected("not_available", 409);
    const spot = input.spot && MEETING_SPOTS.includes(input.spot) ? input.spot : null;
    const place = spot ? null : input.place?.trim().slice(0, 200) || null;
    if (!spot && (!place || place.length < 5)) throw new MeetingRejected("bad_place", 400);
    const timeErr = meetingTimeError(input.at, now);
    if (timeErr) throw new MeetingRejected(timeErr, 400);
    const [open] = await this.db
      .select({ id: meetings.id })
      .from(meetings)
      .where(and(eq(meetings.listingId, l.id), eq(meetings.buyerUserId, buyer.id), inArray(meetings.status, OPEN)));
    if (open) throw new MeetingRejected("meeting_exists", 409);
    const [{ n }] = (await this.db
      .select({ n: count() })
      .from(meetings)
      .where(and(eq(meetings.buyerUserId, buyer.id), gte(meetings.createdAt, startOfTashkentDay(now))))) as [{ n: number }];
    if (Number(n) >= MEETINGS_PER_DAY) throw new MeetingRejected("too_many_meetings", 429);

    const [m] = await this.db
      .insert(meetings)
      .values({ listingId: l.id, buyerUserId: buyer.id, sellerUserId: l.sellerUserId, spot, place, at: input.at, note: input.note?.trim().slice(0, 300) || null })
      .onConflictDoNothing()
      .returning();
    if (!m) throw new MeetingRejected("meeting_exists", 409);
    await this.d.repo.event(buyer.id, "meeting_requested", { listingId: l.id, meetingId: m!.id, spot: spot ?? "custom" });
    const [seller] = await this.db.select().from(users).where(eq(users.id, l.sellerUserId));
    if (seller) {
      const lang = seller.language as Lang;
      await this.dm(
        seller,
        t(lang, "meet.request_for_seller", {
          title: listingTitle(l, lang),
          place: this.place(m!, lang),
          time: meetingTime(m!.at, lang),
        }) + (m!.note ? `\n${t(lang, "meet.note", { note: m!.note })}` : ""),
        [
          [
            { text: t(lang, "meet.accept"), callbackData: `meet:accept:${m!.id}` },
            { text: t(lang, "meet.decline"), callbackData: `meet:decline:${m!.id}` },
          ],
        ],
      );
    }
    return this.dto(m!, l, "buyer", buyer.language as Lang);
  }

  private async load(id: string) {
    const [row] = await this.db.select({ m: meetings, l: listings }).from(meetings).innerJoin(listings, eq(listings.id, meetings.listingId)).where(eq(meetings.id, id));
    if (!row) throw new MeetingRejected("not_found", 404);
    return row;
  }

  /** Compare-and-set on the status: two taps (bot button and Mini App) change it once. */
  private async move(id: string, from: MeetingStatus[], to: MeetingStatus, now: Date) {
    const [m] = await this.db
      .update(meetings)
      .set({ status: to, decidedAt: now })
      .where(and(eq(meetings.id, id), inArray(meetings.status, from)))
      .returning();
    if (!m) throw new MeetingRejected("bad_state", 409);
    return m;
  }

  async answer(seller: User, id: string, accept: boolean, now = new Date()) {
    const { m: old, l } = await this.load(id);
    if (old.sellerUserId !== seller.id) throw new MeetingRejected("not_found", 404);
    if (accept && l.status !== "active") throw new MeetingRejected("not_available", 409);
    const m = await this.move(id, ["pending"], accept ? "accepted" : "declined", now);
    const [buyer] = await this.db.select().from(users).where(eq(users.id, m.buyerUserId));
    if (buyer) {
      const lang = buyer.language as Lang;
      const params = { title: listingTitle(l, lang), place: this.place(m, lang), time: meetingTime(m.at, lang) };
      await this.dm(buyer, t(lang, accept ? "meet.accepted_for_buyer" : "meet.declined_for_buyer", params), await this.openButton(lang));
    }
    return this.dto(m, l, "seller", seller.language as Lang);
  }

  async cancel(user: User, id: string, now = new Date()) {
    const { m: old, l } = await this.load(id);
    const role = old.buyerUserId === user.id ? "buyer" : old.sellerUserId === user.id ? "seller" : null;
    if (!role) throw new MeetingRejected("not_found", 404);
    const m = await this.move(id, OPEN, "cancelled", now);
    const [other] = await this.db.select().from(users).where(eq(users.id, role === "buyer" ? m.sellerUserId : m.buyerUserId));
    if (other) {
      const lang = other.language as Lang;
      await this.dm(other, t(lang, "meet.cancelled", { title: listingTitle(l, lang), time: meetingTime(m.at, lang) }));
    }
    return this.dto(m, l, role, user.language as Lang);
  }

  /**
   * After the meeting the buyer says how it went. "Bought" never takes the listing off sale by itself (a
   * buyer alone must not be able to close someone else's listing): the seller confirms with one button.
   */
  async report(buyer: User, id: string, bought: boolean, now = new Date()) {
    const { m: old, l } = await this.load(id);
    if (old.buyerUserId !== buyer.id) throw new MeetingRejected("not_found", 404);
    if (old.at > now) throw new MeetingRejected("bad_state", 409);
    const m = await this.move(id, ["accepted"], bought ? "bought" : "not_bought", now);
    await this.d.repo.event(buyer.id, "meeting_reported", { meetingId: m.id, listingId: l.id, bought });
    if (bought && l.status === "active") {
      const [seller] = await this.db.select().from(users).where(eq(users.id, m.sellerUserId));
      if (seller) {
        const lang = seller.language as Lang;
        await this.dm(seller, t(lang, "meet.sold_for_seller", { title: listingTitle(l, lang) }), [
          [{ text: t(lang, "meet.confirm_sold"), callbackData: `meet:sold:${m.id}` }],
        ]);
      }
    }
    return this.dto(m, l, "buyer", buyer.language as Lang);
  }

  /** The seller confirms the buyer's "bought": the listing leaves the catalogue. */
  async confirmSold(seller: User, id: string) {
    const { m, l } = await this.load(id);
    if (m.sellerUserId !== seller.id) throw new MeetingRejected("not_found", 404);
    if (m.status !== "bought") throw new MeetingRejected("bad_state", 409);
    if (!(await this.d.markSold(l.id))) throw new MeetingRejected("not_available", 409);
    const [fresh] = await this.db.select().from(listings).where(eq(listings.id, l.id));
    return this.dto(m, fresh!, "seller", seller.language as Lang);
  }

  /** The listing left the catalogue (sold, archived, banned): its open meetings are off, both sides are told. */
  async cancelForListing(listingId: string, now = new Date()) {
    const rows = await this.db
      .update(meetings)
      .set({ status: "cancelled", decidedAt: now })
      .where(and(eq(meetings.listingId, listingId), inArray(meetings.status, OPEN)))
      .returning();
    if (!rows.length) return 0;
    const [l] = await this.db.select().from(listings).where(eq(listings.id, listingId));
    const people = await this.db.select().from(users).where(inArray(users.id, [...new Set(rows.flatMap((m) => [m.buyerUserId, m.sellerUserId]))]));
    for (const m of rows) {
      for (const u of people.filter((p) => p.id === m.buyerUserId || p.id === m.sellerUserId)) {
        const lang = u.language as Lang;
        await this.dm(u, t(lang, "meet.listing_gone", { title: l ? listingTitle(l, lang) : "", time: meetingTime(m.at, lang) }));
      }
    }
    return rows.length;
  }

  /**
   * Hourly: a reminder to both sides of an accepted meeting within MEETING_REMIND_HOURS (claimed first, so
   * two instances never send it twice), and open meetings of listings that are no longer on sale are off.
   */
  async runMaintenance(now = new Date()) {
    const gone = await this.db
      .selectDistinct({ id: meetings.listingId })
      .from(meetings)
      .innerJoin(listings, eq(listings.id, meetings.listingId))
      .where(and(inArray(meetings.status, OPEN), sql`${listings.status} <> 'active'`));
    for (const g of gone) await this.cancelForListing(g.id, now);
    // A request nobody answered before its time is over.
    await this.db
      .update(meetings)
      .set({ status: "cancelled", decidedAt: now })
      .where(and(eq(meetings.status, "pending"), lte(meetings.at, now)));

    const due = await this.db
      .update(meetings)
      .set({ remindedAt: now })
      .where(
        and(
          eq(meetings.status, "accepted"),
          isNull(meetings.remindedAt),
          gte(meetings.at, now),
          lte(meetings.at, new Date(now.getTime() + MEETING_REMIND_HOURS * 3600_000)),
        ),
      )
      .returning();
    for (const m of due) {
      const [l] = await this.db.select().from(listings).where(eq(listings.id, m.listingId));
      const people = await this.db.select().from(users).where(inArray(users.id, [m.buyerUserId, m.sellerUserId]));
      for (const u of people) {
        const lang = u.language as Lang;
        const key = u.id === m.buyerUserId ? "meet.reminder_buyer" : "meet.reminder_seller";
        await this.dm(
          u,
          t(lang, key, { title: l ? listingTitle(l, lang) : "", place: this.place(m, lang), time: meetingTime(m.at, lang), price: l?.price ? formatUzs(l.price) : "" }),
          await this.openButton(lang),
        );
      }
    }
    return due.length;
  }

  /** Upcoming and recent meetings of a user (both roles), newest first. */
  async mine(user: User, now = new Date()) {
    const rows = await this.db
      .select({ m: meetings, l: listings })
      .from(meetings)
      .innerJoin(listings, eq(listings.id, meetings.listingId))
      .where(
        and(
          or(eq(meetings.buyerUserId, user.id), eq(meetings.sellerUserId, user.id)),
          or(inArray(meetings.status, OPEN), gte(meetings.at, new Date(now.getTime() - 30 * 864e5))),
        ),
      )
      .orderBy(desc(meetings.at))
      .limit(50);
    return rows.map(({ m, l }) => this.dto(m, l, m.buyerUserId === user.id ? "buyer" : "seller", user.language as Lang, now));
  }

  dto(m: Meeting, l: Listing, role: "buyer" | "seller", lang: Lang, now = new Date()): MeetingDto {
    const actions: MeetingDto["actions"] = [];
    if (role === "seller" && m.status === "pending") actions.push("accept", "decline");
    if (OPEN.includes(m.status as MeetingStatus)) actions.push("cancel");
    if (role === "buyer" && m.status === "accepted" && m.at <= now) actions.push("report");
    if (role === "seller" && m.status === "bought" && l.status === "active") actions.push("confirm_sold");
    return {
      id: m.id,
      listingId: l.id,
      title: listingTitle(l, lang),
      price: l.price,
      category: l.category,
      role,
      spot: (m.spot as MeetingSpot | null) ?? null,
      place: m.place,
      at: m.at.toISOString(),
      note: m.note,
      status: m.status as MeetingStatus,
      actions,
    };
  }
}
