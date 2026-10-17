import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { CHAT_REPORT_REASONS, listingTitle, t, type ChatReportReason, type Lang } from "@ishonch/shared";
import type { Repo } from "../../db/repo.js";
import { chatReports, conversationMessages, conversations, listings, meetings, userBlocks, users, type User } from "../../db/schema.js";
import type { StaffNotifier } from "../../telegram/staff.js";

export class SafetyRejected extends Error {
  constructor(
    public code: "not_found" | "bad_request",
    public status: number,
  ) {
    super(code);
  }
}

/** How many of the last messages moderators see with a report. */
const REPORT_MESSAGES = 12;

/**
 * Safe conversations (docs/plan.md, stage 19): block the other side of a masked chat, report a chat to the
 * moderators. Identities stay masked: a block is shown to its owner by the listing where they met.
 */
export class SafetyService {
  constructor(private d: { repo: Repo; staff: StaffNotifier; adminLink?: () => Promise<string | null> }) {}

  private get db() {
    return this.d.repo.db;
  }

  /** True when either side blocked the other. */
  async blockedBetween(a: string, b: string) {
    const [row] = await this.db
      .select({ x: userBlocks.blockerUserId })
      .from(userBlocks)
      .where(
        or(
          and(eq(userBlocks.blockerUserId, a), eq(userBlocks.blockedUserId, b)),
          and(eq(userBlocks.blockerUserId, b), eq(userBlocks.blockedUserId, a)),
        ),
      )
      .limit(1);
    return !!row;
  }

  private async conversationOf(user: User, conversationId: string) {
    const [c] = await this.db.select().from(conversations).where(eq(conversations.id, conversationId));
    if (!c || (c.buyerUserId !== user.id && c.sellerUserId !== user.id)) throw new SafetyRejected("not_found", 404);
    return { c, other: c.buyerUserId === user.id ? c.sellerUserId : c.buyerUserId };
  }

  /** Blocks the other side of a conversation; their open meetings with this user are called off. */
  async block(user: User, conversationId: string) {
    const { c, other } = await this.conversationOf(user, conversationId);
    await this.db.insert(userBlocks).values({ blockerUserId: user.id, blockedUserId: other, listingId: c.listingId }).onConflictDoNothing();
    await this.db
      .update(meetings)
      .set({ status: "cancelled", decidedAt: new Date() })
      .where(
        and(
          inArray(meetings.status, ["pending", "accepted"]),
          or(
            and(eq(meetings.buyerUserId, user.id), eq(meetings.sellerUserId, other)),
            and(eq(meetings.buyerUserId, other), eq(meetings.sellerUserId, user.id)),
          ),
        ),
      );
    await this.d.repo.event(user.id, "user_blocked", { conversationId });
    return { ok: true };
  }

  async unblock(user: User, blockedUserId: string) {
    await this.db.delete(userBlocks).where(and(eq(userBlocks.blockerUserId, user.id), eq(userBlocks.blockedUserId, blockedUserId)));
    return { ok: true };
  }

  /** The user's blocks, each shown by the listing where they met («Покупатель по «iPhone 13»»). */
  async blocks(user: User) {
    const rows = await this.db
      .select({ b: userBlocks, l: listings })
      .from(userBlocks)
      .leftJoin(listings, eq(listings.id, userBlocks.listingId))
      .where(eq(userBlocks.blockerUserId, user.id))
      .orderBy(desc(userBlocks.createdAt));
    const lang = user.language as Lang;
    return rows.map(({ b, l }) => ({
      userId: b.blockedUserId,
      title: l ? listingTitle(l, lang) : null,
      role: l ? (l.sellerUserId === user.id ? "buyer" : "seller") : null,
      createdAt: b.createdAt.toISOString(),
    }));
  }

  /** A report about the other side of a conversation; moderators get the last messages. */
  async report(user: User, conversationId: string, reason: ChatReportReason) {
    if (!CHAT_REPORT_REASONS.includes(reason)) throw new SafetyRejected("bad_request", 400);
    const { c, other } = await this.conversationOf(user, conversationId);
    const [row] = await this.db
      .insert(chatReports)
      .values({ conversationId, reporterUserId: user.id, reportedUserId: other, reason })
      .onConflictDoNothing()
      .returning();
    if (!row) return { ok: true, duplicate: true };
    await this.d.repo.event(user.id, "chat_reported", { conversationId, reason });
    const [l] = await this.db.select().from(listings).where(eq(listings.id, c.listingId));
    const role = other === c.sellerUserId ? "продавца" : "покупателя";
    const link = await this.d.adminLink?.().catch(() => null);
    await this.d.staff.moderators(
      `🚩 Жалоба на переписку: ${role} по «${l ? listingTitle(l, "ru") : "—"}»\nПричина: ${t("ru", `chat_report.reason.${reason}`)}\nОткройте админку → «Переписка».`,
      link ? [[{ text: "Открыть админку", url: link }]] : [],
    );
    return { ok: true, duplicate: false };
  }

  /** Moderators: open chat reports with the last messages (who wrote what: buyer / seller). */
  async openReports() {
    const rows = await this.db
      .select({ r: chatReports, c: conversations, l: listings, reported: users })
      .from(chatReports)
      .innerJoin(conversations, eq(conversations.id, chatReports.conversationId))
      .innerJoin(listings, eq(listings.id, conversations.listingId))
      .innerJoin(users, eq(users.id, chatReports.reportedUserId))
      .where(isNull(chatReports.resolvedAt))
      .orderBy(asc(chatReports.createdAt))
      .limit(50);
    const out = [];
    for (const { r, c, l, reported } of rows) {
      const msgs = await this.db
        .select()
        .from(conversationMessages)
        .where(eq(conversationMessages.conversationId, c.id))
        .orderBy(desc(conversationMessages.createdAt))
        .limit(REPORT_MESSAGES);
      const [{ reports }] = (await this.db.execute(
        sql`select count(*)::int as reports from ${chatReports} where reported_user_id = ${r.reportedUserId}`,
      )) as unknown as [{ reports: number }];
      out.push({
        id: r.id,
        reason: r.reason,
        createdAt: r.createdAt.toISOString(),
        listing: { id: l.id, title: l.titleRu || l.titleUz },
        reported: { id: reported.id, telegramId: reported.telegramId, role: r.reportedUserId === c.sellerUserId ? "seller" : "buyer", banned: !!reported.bannedAt, reports },
        messages: msgs.reverse().map((m) => ({
          from: m.senderUserId === c.sellerUserId ? "seller" : "buyer",
          text: m.text,
          at: m.createdAt.toISOString(),
        })),
      });
    }
    return out;
  }

  async resolveReport(admin: User, id: number, resolution: "dismissed" | "warned" | "banned") {
    const [r] = await this.db
      .update(chatReports)
      .set({ resolvedAt: new Date(), resolution })
      .where(and(eq(chatReports.id, id), isNull(chatReports.resolvedAt)))
      .returning();
    if (!r) throw new SafetyRejected("not_found", 404);
    await this.d.repo.audit(admin, "chat_report_resolve", String(id), { resolution });
    return { ok: true };
  }
}
