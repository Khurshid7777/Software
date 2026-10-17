import { and, count, countDistinct, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  DEFAULT_COMPLAINTS_TO_HIDE,
  MAX_COMPLAINTS_PER_DAY,
  MODERATION_REASONS,
  scrubPii,
  type ComplaintReason,
  type ModerationReason,
  type ModerationRecord,
} from "@ishonch/shared";
import { startOfTashkentDay, type Repo } from "../../db/repo.js";
import { complaints, listings, users, type User } from "../../db/schema.js";
import type { ListingService } from "../listings/service.js";

export class TrustRejected extends Error {
  constructor(
    public code: "not_found" | "own_listing" | "complaint_limit" | "bad_state" | "forbidden",
    public status: number,
  ) {
    super(code);
  }
}

export interface TrustDeps {
  repo: Repo;
  listings: ListingService;
  /** Cancels the user's open delivery orders (wired to OrderService). */
  onBanned?: (userId: string) => Promise<unknown>;
}

/** Complaints, moderator decisions and bans. */
const COMPLAINT_MIN_AGE_DAYS = 3;

export class TrustService {
  constructor(private d: TrustDeps) {}

  private get db() {
    return this.d.repo.db;
  }

  // ---------- complaints ----------
  /**
   * One complaint per user and listing. When distinct users with open complaints reach the
   * `complaints_to_hide` setting (3), the listing is hidden until a moderator decides.
   */
  async complain(user: User, listingId: string, reason: ComplaintReason, text?: string) {
    const [l] = await this.db.select().from(listings).where(eq(listings.id, listingId));
    if (!l || !["active", "reserved"].includes(l.status)) throw new TrustRejected("not_found", 404);
    if (l.sellerUserId === user.id) throw new TrustRejected("own_listing", 409);

    const [{ today }] = (await this.db
      .select({ today: count() })
      .from(complaints)
      .where(and(eq(complaints.userId, user.id), gte(complaints.createdAt, startOfTashkentDay())))) as [{ today: number }];
    if (today >= MAX_COMPLAINTS_PER_DAY) throw new TrustRejected("complaint_limit", 429);

    const inserted = await this.db
      .insert(complaints)
      .values({ listingId, userId: user.id, reason, text: text ? scrubPii(text).slice(0, 500) : null })
      .onConflictDoNothing()
      .returning();
    if (!inserted.length) return { ok: true, duplicate: true, hidden: false };
    await this.d.repo.event(user.id, "complaint_created", { listingId, reason });
    return { ok: true, duplicate: false, hidden: await this.holdIfComplained(listingId) };
  }

  /**
   * Hides an active listing once enough distinct users have open complaints about it. Also called when a
   * reserved listing comes back on sale (complaints collected meanwhile must not be lost).
   */
  async holdIfComplained(listingId: string): Promise<boolean> {
    const [l] = await this.db.select().from(listings).where(eq(listings.id, listingId));
    if (!l || l.status !== "active") return false;
    // Only established accounts (a phone and at least COMPLAINT_MIN_AGE_DAYS on Ishonch) can hide a listing:
    // three fresh throwaway accounts must not take down a competitor. All complaints still reach moderators.
    const [{ n }] = (await this.db
      .select({ n: countDistinct(complaints.userId) })
      .from(complaints)
      .innerJoin(users, eq(users.id, complaints.userId))
      .where(
        and(
          eq(complaints.listingId, listingId),
          isNull(complaints.resolvedAt),
          sql`${users.phone} is not null`,
          lte(users.createdAt, new Date(Date.now() - COMPLAINT_MIN_AGE_DAYS * 864e5)),
        ),
      )) as [{ n: number }];
    const threshold = await this.d.repo.getSetting("complaints_to_hide", DEFAULT_COMPLAINTS_TO_HIDE);
    if (n < threshold) return false;

    const open = await this.db
      .select({ reason: complaints.reason })
      .from(complaints)
      .where(and(eq(complaints.listingId, listingId), isNull(complaints.resolvedAt)));
    const byReason = Object.entries(
      open.reduce<Record<string, number>>((acc, c) => ((acc[c.reason] = (acc[c.reason] ?? 0) + 1), acc), {}),
    )
      .map(([r, k]) => `${r} ×${k}`)
      .join(", ");
    const hidden = await this.d.listings.holdForModeration(
      l,
      {
        decision: "needs_review",
        source: "complaints",
        reasons: [{ code: "complaints", note: `Жалобы от ${n} пользователей: ${byReason}` }],
        at: new Date().toISOString(),
      },
      { from: ["active"] },
    );
    if (hidden) await this.d.repo.event(null, "listing_hidden_by_complaints", { listingId, users: n });
    return hidden;
  }

  async listComplaints(onlyOpen = true) {
    return this.db
      .select({
        id: complaints.id,
        listingId: complaints.listingId,
        reason: complaints.reason,
        text: complaints.text,
        createdAt: complaints.createdAt,
        resolvedAt: complaints.resolvedAt,
        resolution: complaints.resolution,
        listingTitle: listings.titleRu,
        listingStatus: listings.status,
        sellerUserId: listings.sellerUserId,
      })
      .from(complaints)
      .innerJoin(listings, eq(listings.id, complaints.listingId))
      .where(onlyOpen ? isNull(complaints.resolvedAt) : undefined)
      .orderBy(desc(complaints.createdAt))
      .limit(200);
  }

  // ---------- moderation queue ----------
  async queue() {
    const rows = await this.db
      .select({ id: listings.id })
      .from(listings)
      .where(eq(listings.status, "pending"))
      .orderBy(listings.updatedAt)
      .limit(100);
    const ids = rows.map((r) => r.id);
    if (!ids.length) return [];
    const dtos = await this.d.listings.dtos(ids, null, { withSeller: true });
    const records = new Map(
      (await this.db.select({ id: listings.id, moderation: listings.moderation }).from(listings).where(inArray(listings.id, ids))).map(
        (r) => [r.id, r.moderation as ModerationRecord | null],
      ),
    );
    const open = new Map(
      (
        await this.db
          .select({ id: complaints.listingId, n: count() })
          .from(complaints)
          .where(and(inArray(complaints.listingId, ids), isNull(complaints.resolvedAt)))
          .groupBy(complaints.listingId)
      ).map((r) => [r.id, Number(r.n)]),
    );
    return dtos.map((dto) => ({ listing: dto, moderation: records.get(dto.id) ?? null, openComplaints: open.get(dto.id) ?? 0 }));
  }

  /** Moderator decision on a pending listing (Mini App admin API or the bot's buttons in the moderators' chat). */
  async decide(admin: User, listingId: string, decision: "approve" | "reject", reason?: string) {
    const [l] = await this.db.select().from(listings).where(eq(listings.id, listingId));
    if (!l) throw new TrustRejected("not_found", 404);
    if (l.status !== "pending") throw new TrustRejected("bad_state", 409);
    const prev = (l.moderation as ModerationRecord | null) ?? null;
    const code: ModerationReason = (MODERATION_REASONS as readonly string[]).includes(reason ?? "")
      ? (reason as ModerationReason)
      : (prev?.reasons.find((r) => r.code !== "complaints")?.code ?? prev?.reasons[0]?.code ?? "other");
    const record: ModerationRecord = {
      decision: decision === "approve" ? "approved" : "rejected",
      source: "admin",
      reasons: decision === "approve" ? [] : [{ code, note: `Решение модератора` }],
      sellerMessage: decision === "reject" ? prev?.sellerMessage : undefined,
      at: new Date().toISOString(),
    };

    // Compare-and-set on "pending": two moderators clicking at once (or approve vs reject) decide only once.
    if (decision === "approve") {
      try {
        await this.d.listings.activate(listingId, prev?.pendingChannelIds ?? [], record, ["pending"]);
      } catch (err) {
        if ((err as { code?: string }).code === "bad_state") throw new TrustRejected("bad_state", 409);
        throw err;
      }
    } else {
      const updated = await this.db
        .update(listings)
        .set({ status: "rejected", moderation: record, moderationReason: code, updatedAt: new Date() })
        .where(and(eq(listings.id, listingId), eq(listings.status, "pending")))
        .returning({ id: listings.id });
      if (!updated.length) throw new TrustRejected("bad_state", 409);
    }
    await this.db
      .update(complaints)
      .set({ resolvedAt: new Date(), resolution: decision === "approve" ? "dismissed" : "upheld" })
      .where(and(eq(complaints.listingId, listingId), isNull(complaints.resolvedAt)));
    await this.d.listings.notifySeller(l, decision === "approve" ? "moderation.approved" : "moderation.rejected", decision === "reject" ? record : null);
    await this.d.repo.event(admin.id, "moderation_decision", { listingId, decision, reason: code });
    await this.d.repo.audit(admin, `moderation.${decision}`, listingId, { reason: code });
    return { ok: true, status: decision === "approve" ? "active" : "rejected", title: l.titleRu || l.titleUz };
  }

  // ---------- bans ----------
  async ban(admin: User, userId: string, reason: string) {
    const [u] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!u) throw new TrustRejected("not_found", 404);
    if (u.role === "admin" || u.id === admin.id) throw new TrustRejected("forbidden", 403);
    await this.db.update(users).set({ bannedAt: new Date(), banReason: reason.slice(0, 300) }).where(eq(users.id, userId));
    const hidden = await this.db
      .update(listings)
      .set({ status: "archived", moderationReason: "banned", updatedAt: new Date() })
      .where(and(eq(listings.sellerUserId, userId), inArray(listings.status, ["active", "pending", "reserved"])))
      .returning({ id: listings.id });
    await this.d.onBanned?.(userId);
    await this.d.repo.event(admin.id, "user_banned", { userId, listings: hidden.length });
    await this.d.repo.audit(admin, "user.ban", userId, { reason, listings: hidden.length });
    return { ok: true, hiddenListings: hidden.length };
  }

  async unban(admin: User, userId: string) {
    const res = await this.db
      .update(users)
      .set({ bannedAt: null, banReason: null })
      .where(eq(users.id, userId))
      .returning({ id: users.id });
    if (!res.length) throw new TrustRejected("not_found", 404);
    // Listings stay archived: the seller republishes them (and they pass moderation again).
    await this.db
      .update(listings)
      .set({ moderationReason: null })
      .where(and(eq(listings.sellerUserId, userId), eq(listings.moderationReason, "banned")));
    await this.d.repo.event(admin.id, "user_unbanned", { userId });
    await this.d.repo.audit(admin, "user.unban", userId);
    return { ok: true };
  }

  async findUser(query: { telegramId?: number; id?: string }) {
    const where = query.id ? eq(users.id, query.id) : query.telegramId ? eq(users.telegramId, query.telegramId) : sql`false`;
    const [u] = await this.db.select().from(users).where(where);
    if (!u) return null;
    const [{ active }] = (await this.db
      .select({ active: count() })
      .from(listings)
      .where(and(eq(listings.sellerUserId, u.id), eq(listings.status, "active")))) as [{ active: number }];
    return {
      id: u.id,
      telegramId: u.telegramId,
      role: u.role,
      createdAt: u.createdAt,
      bannedAt: u.bannedAt,
      banReason: u.banReason,
      activeListings: active,
      rating: await this.d.listings.sellerRating(u.id),
    };
  }
}
