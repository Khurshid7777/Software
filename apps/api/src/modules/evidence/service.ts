import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, count, desc, eq, inArray, lt } from "drizzle-orm";
import { VIDEO_CHECKS_PER_DAY, VIDEO_KEEP_DAYS_AFTER_SALE, type CheckCategory, type VideoCheckResult } from "@ishonch/shared";
import type { AiService } from "../../ai/aiService.js";
import type { Repo } from "../../db/repo.js";
import { evidence, listings } from "../../db/schema.js";
import { processImage } from "../../storage/images.js";
import type { Storage } from "../../storage/storage.js";
import { checkVideo, compressVideo, extractFrames, unknownCheck } from "./videoCheck.js";

/** dispute_photo: the buyer's, inspection_photo: the courier's at pickup, listing_video: the seller's check. */
export type EvidenceKind = "dispute_photo" | "inspection_photo" | "listing_video";
export const VIDEO_TYPES = /^video\/(mp4|webm|quicktime)$/;

export class EvidenceRejected extends Error {
  constructor(
    public code: "bad_image" | "bad_video" | "too_many_photos" | "too_large",
    public status = 400,
  ) {
    super(code);
  }
}

export interface UploadedMedia {
  data: Buffer;
  mimeType: string;
}

/**
 * Evidence files (docs/plan.md, stage 15). Photos are re-encoded (EXIF incl. GPS stripped, size capped) like
 * listing photos; videos are kept as uploaded. Every file is served by a signed URL, so <img>/<video> work
 * without auth headers and ids cannot be guessed.
 */
export interface ListingVideo {
  url: string;
  check: VideoCheckResult | null;
}

export class EvidenceService {
  constructor(
    private d: {
      repo: Repo;
      storage: Storage;
      secret: string;
      /** Reads the frames of a video passport; null = videos are kept without an AI check. */
      ai?: Pick<AiService, "structured"> | null;
      logger?: { warn: (obj: unknown, msg: string) => void };
    },
  ) {}

  private get db() {
    return this.d.repo.db;
  }

  private sign(v: string) {
    return createHmac("sha256", this.d.secret).update(`media:${v}`).digest("base64url").slice(0, 22);
  }

  url(row: { id: number; storageKey: string }) {
    return `/media/${row.id}?s=${this.sign(`${row.id}:${row.storageKey}`)}`;
  }

  async read(id: number, sig: string): Promise<{ data: Buffer; mime: string } | null> {
    if (!Number.isInteger(id)) return null;
    const [row] = await this.db.select().from(evidence).where(eq(evidence.id, id));
    if (!row) return null;
    const expected = Buffer.from(this.sign(`${row.id}:${row.storageKey}`));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    const data = await this.d.storage.get(row.storageKey);
    return data ? { data, mime: row.mime } : null;
  }

  /** Adds photos up to `max` per order and kind; returns all photo URLs of that order and kind. */
  async addPhotos(
    kind: "dispute_photo" | "inspection_photo",
    target: { listingId: string; orderId: string },
    userId: string,
    files: UploadedMedia[],
    max: number,
  ) {
    if (!files.length) throw new EvidenceRejected("bad_image");
    const [{ n }] = (await this.db
      .select({ n: count() })
      .from(evidence)
      .where(and(eq(evidence.orderId, target.orderId), eq(evidence.kind, kind)))) as [{ n: number }];
    if (Number(n) + files.length > max) throw new EvidenceRejected("too_many_photos");
    for (const f of files) {
      let img;
      try {
        img = await processImage(f.data);
      } catch {
        throw new EvidenceRejected("bad_image");
      }
      const key = `evidence/${target.orderId}/${kind}-${Date.now()}-${randomBytes(6).toString("hex")}.jpg`;
      await this.d.storage.put(key, img.full, "image/jpeg");
      await this.db.insert(evidence).values({ kind, ...target, uploadedBy: userId, storageKey: key, mime: "image/jpeg", bytes: img.full.length });
    }
    return this.orderPhotos([target.orderId], kind).then((m) => m.get(target.orderId) ?? []);
  }

  /** Photo URLs per order for a kind (one query for any number of orders). */
  async orderPhotos(orderIds: string[], kind: "dispute_photo" | "inspection_photo") {
    const out = new Map<string, string[]>();
    if (!orderIds.length) return out;
    const rows = await this.db
      .select()
      .from(evidence)
      .where(and(inArray(evidence.orderId, orderIds), eq(evidence.kind, kind)))
      .orderBy(asc(evidence.id));
    for (const r of rows) out.set(r.orderId!, [...(out.get(r.orderId!) ?? []), this.url(r)]);
    return out;
  }

  /**
   * The seller's video passport: one per listing, a new upload replaces the old one. The AI reads a few frames
   * right away (the seller sees at once what is missing); any failure there leaves the check `unknown`.
   */
  async setVideo(listingId: string, userId: string, file: UploadedMedia, listing: { category: CheckCategory; title: string }): Promise<ListingVideo> {
    if (!VIDEO_TYPES.test(file.mimeType) || !file.data.length) throw new EvidenceRejected("bad_video");
    await this.removeVideo(listingId);
    const ext = file.mimeType.split("/")[1] === "quicktime" ? "mov" : file.mimeType.split("/")[1]!;
    let stored = { data: file.data, mime: file.mimeType, ext };
    // Every reading is a paid model call: a seller who re-uploads all day keeps their videos, but past the daily
    // cap they are stored unread (the passport then says "the seller's word").
    const reservation = this.d.ai ? await this.d.repo.reserveDaily(userId, "video_check", VIDEO_CHECKS_PER_DAY) : null;
    // The AI reads the frames of the original (sharpest IMEI), while the clip that is kept is the compact copy.
    const [check, packed] = await Promise.all([
      reservation == null ? Promise.resolve(unknownCheck()) : this.inspect(file.data, ext, listing, reservation),
      compressVideo(file.data, ext),
    ]);
    if (packed) stored = { data: packed, mime: "video/mp4", ext: "mp4" };
    const key = `evidence/listings/${listingId}/video-${Date.now()}-${randomBytes(6).toString("hex")}.${stored.ext}`;
    await this.d.storage.put(key, stored.data, stored.mime);
    const [row] = await this.db
      .insert(evidence)
      .values({ kind: "listing_video", listingId, uploadedBy: userId, storageKey: key, mime: stored.mime, bytes: stored.data.length, meta: check })
      .returning();
    return { url: this.url(row!), check };
  }

  private async inspect(data: Buffer, ext: string, listing: { category: CheckCategory; title: string }, reservation: number): Promise<VideoCheckResult> {
    if (!this.d.ai) return unknownCheck();
    try {
      const frames = await extractFrames(data, ext);
      // Nothing readable (not a real video): no model call was made, so the daily allowance is given back.
      if (!frames.jpegs.length) await this.d.repo.refundDaily(reservation);
      return await checkVideo(this.d.ai, frames, listing);
    } catch (err) {
      // No key, the monthly budget, a provider outage: the video stays, the passport says "the seller's word".
      this.d.logger?.warn({ err: String(err) }, "video check skipped");
      await this.d.repo.refundDaily(reservation);
      return unknownCheck();
    }
  }

  /**
   * Videos of items sold more than VIDEO_KEEP_DAYS_AFTER_SALE days ago are deleted (file and row): the passport of a
   * sold item is not shown any more, and the file is the largest thing we store per listing. Archived and expired
   * listings keep theirs: a seller may relist them.
   */
  async purgeSoldVideos(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - VIDEO_KEEP_DAYS_AFTER_SALE * 86_400_000);
    const rows = await this.db
      .select({ listingId: evidence.listingId })
      .from(evidence)
      .innerJoin(listings, eq(listings.id, evidence.listingId))
      .where(and(eq(evidence.kind, "listing_video"), eq(listings.status, "sold"), lt(listings.soldAt, cutoff)));
    for (const id of new Set(rows.map((r) => r.listingId))) await this.removeVideo(id);
    return new Set(rows.map((r) => r.listingId)).size;
  }

  async removeVideo(listingId: string) {
    const old = await this.db.delete(evidence).where(and(eq(evidence.listingId, listingId), eq(evidence.kind, "listing_video"))).returning();
    await Promise.all(old.map((o) => this.d.storage.delete(o.storageKey).catch(() => undefined)));
  }

  /** Video URL and AI check per listing (the newest clip). */
  async listingVideos(listingIds: string[]) {
    const out = new Map<string, ListingVideo>();
    if (!listingIds.length) return out;
    const rows = await this.db
      .select()
      .from(evidence)
      .where(and(inArray(evidence.listingId, listingIds), eq(evidence.kind, "listing_video")))
      .orderBy(desc(evidence.id));
    for (const r of rows) if (!out.has(r.listingId)) out.set(r.listingId, { url: this.url(r), check: (r.meta as VideoCheckResult | null) ?? null });
    return out;
  }
}
