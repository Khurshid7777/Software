import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import type { CheckCategory, VideoCheckResult } from "@ishonch/shared";
import type { AiService } from "../../ai/aiService.js";
import type { Repo } from "../../db/repo.js";
import { evidence } from "../../db/schema.js";
import { processImage } from "../../storage/images.js";
import type { Storage } from "../../storage/storage.js";
import { checkVideo, extractFrames, unknownCheck } from "./videoCheck.js";

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
    const key = `evidence/listings/${listingId}/video-${Date.now()}-${randomBytes(6).toString("hex")}.${ext}`;
    await this.d.storage.put(key, file.data, file.mimeType);
    const check = await this.inspect(file.data, ext, listing);
    const [row] = await this.db
      .insert(evidence)
      .values({ kind: "listing_video", listingId, uploadedBy: userId, storageKey: key, mime: file.mimeType, bytes: file.data.length, meta: check })
      .returning();
    return { url: this.url(row!), check };
  }

  private async inspect(data: Buffer, ext: string, listing: { category: CheckCategory; title: string }): Promise<VideoCheckResult> {
    if (!this.d.ai) return unknownCheck();
    try {
      return await checkVideo(this.d.ai, await extractFrames(data, ext), listing);
    } catch (err) {
      // No key, the monthly budget, a provider outage: the video stays, the passport says "the seller's word".
      this.d.logger?.warn({ err: String(err) }, "video check skipped");
      return unknownCheck();
    }
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
