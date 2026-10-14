import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import sharp from "sharp";
import {
  ListingModerationSchema,
  PHOTO_DUPLICATE_DISTANCE,
  TEXT_DUPLICATE_SIMILARITY,
  scrubPii,
  type MarketRange,
  type ModerationDecision,
  type ModerationRecord,
} from "@ishonch/shared";
import { AiLimitExceededError, AiOutputError, type AiService } from "../../ai/aiService.js";
import type { Repo } from "../../db/repo.js";
import { listingPhotos, listings, type Listing } from "../../db/schema.js";
import type { Storage } from "../../storage/storage.js";

/** Statuses that occupy the catalog (or will soon) — duplicates are searched among them. */
const LIVE = ["active", "pending", "reserved"];
const SEVERITY: Record<ModerationDecision, number> = { approved: 0, needs_review: 1, rejected: 2 };

export interface Duplicates {
  /** The seller's own live listings with the same photos. */
  own: string[];
  /** Other sellers' live listings with the same photos (possibly stolen photos). */
  otherPhotos: string[];
  /** Other sellers' live listings with an almost identical description. */
  otherText: string[];
}

export interface ModerationDeps {
  repo: Repo;
  ai: Pick<AiService, "structured"> | null;
  storage: Storage;
  findMarket: (modelKey: string) => Promise<MarketRange | null>;
  logger?: { warn: (obj: object, msg: string) => void };
}

/** True when the listing text contains phones, cards, links or @handles (deals must go through Ishonch). */
export function hasContactInfo(l: Pick<Listing, "titleRu" | "titleUz" | "descriptionRu" | "descriptionUz">) {
  return [l.titleRu, l.titleUz, l.descriptionRu, l.descriptionUz].some((s) => s && scrubPii(s) !== s);
}

/**
 * Pre-moderation at publication: duplicate search (perceptual hash + text) and an AI review.
 * The AI never gets the last word on its own failure: if it is unavailable, rules decide.
 */
export class ModerationService {
  constructor(private d: ModerationDeps) {}

  private get db() {
    return this.d.repo.db;
  }

  async findDuplicates(l: Listing): Promise<Duplicates> {
    const photoRows = (await this.db.execute(sql`
      select distinct p2.listing_id as id, l2.seller_user_id as seller
      from ${listingPhotos} p1
      join ${listingPhotos} p2 on p2.phash_bands && p1.phash_bands and p2.listing_id <> p1.listing_id
        and bit_count(('x' || p1.phash)::bit(64) # ('x' || p2.phash)::bit(64)) <= ${PHOTO_DUPLICATE_DISTANCE}
      join ${listings} l2 on l2.id = p2.listing_id and l2.status in ('active', 'pending', 'reserved')
      where p1.listing_id = ${l.id} and p1.phash is not null
      limit 20`)) as unknown as Array<{ id: string; seller: string }>;

    const own = photoRows.filter((r) => r.seller === l.sellerUserId).map((r) => r.id);
    const otherPhotos = photoRows.filter((r) => r.seller !== l.sellerUserId).map((r) => r.id);

    let otherText: string[] = [];
    const desc = (l.descriptionRu || l.descriptionUz).trim();
    if (desc.length >= 80) {
      const rows = await this.db
        .select({ id: listings.id })
        .from(listings)
        .where(
          and(
            inArray(listings.status, LIVE),
            ne(listings.id, l.id),
            ne(listings.sellerUserId, l.sellerUserId),
            eq(listings.category, l.category),
            sql`similarity(coalesce(nullif(${listings.descriptionRu}, ''), ${listings.descriptionUz}), ${desc}) >= ${TEXT_DUPLICATE_SIMILARITY}`,
          ),
        )
        .limit(5);
      otherText = rows.map((r) => r.id);
    }
    return { own, otherPhotos, otherText };
  }

  /** Rule-based checks plus the AI review → one decision. */
  async review(l: Listing, dups?: Duplicates): Promise<ModerationRecord> {
    const duplicates = dups ?? (await this.findDuplicates(l));
    const record: ModerationRecord = { decision: "approved", source: "rules", reasons: [], at: new Date().toISOString() };
    if (duplicates.otherPhotos.length) {
      record.decision = "needs_review";
      record.reasons.push({ code: "duplicate_photos", note: "Фото совпадают с объявлением другого продавца" });
    }
    if (duplicates.otherText.length) {
      record.decision = "needs_review";
      record.reasons.push({ code: "duplicate_text", note: "Описание почти совпадает с объявлением другого продавца" });
    }
    const dupIds = [...duplicates.otherPhotos, ...duplicates.otherText];
    if (dupIds.length) record.duplicates = [...new Set(dupIds)];

    if (!this.d.ai) return record;
    try {
      const ai = await this.askAi(l);
      if (SEVERITY[ai.decision] > SEVERITY[record.decision]) record.decision = ai.decision;
      record.reasons.push(...ai.reasons);
      record.source = "ai";
      if (ai.decision !== "approved" && (ai.seller_message_ru || ai.seller_message_uz)) {
        record.sellerMessage = { ru: ai.seller_message_ru, uz: ai.seller_message_uz };
      }
    } catch (err) {
      // Budget exhausted, invalid output or an outage: publication must not stop, rules decide.
      const kind = err instanceof AiLimitExceededError ? "limit" : err instanceof AiOutputError ? "output" : "error";
      this.d.logger?.warn({ kind, err: String(err) }, "AI moderation unavailable, rules only");
    }
    return record;
  }

  private async askAi(l: Listing) {
    const attrs = l.attributes as { modelKey?: string | null };
    const market = attrs.modelKey ? await this.d.findMarket(attrs.modelKey).catch(() => null) : null;
    const [first] = await this.db
      .select()
      .from(listingPhotos)
      .where(eq(listingPhotos.listingId, l.id))
      .orderBy(asc(listingPhotos.position), asc(listingPhotos.id))
      .limit(1);
    const content: Parameters<AiService["structured"]>[0]["content"] = [];
    if (first) {
      const original = await this.d.storage.get(first.storageKey).catch(() => null);
      if (original) {
        // A small copy is enough to tell what the item is; keeps the call cheap.
        const small = await sharp(original).resize(512, 512, { fit: "inside" }).jpeg({ quality: 70 }).toBuffer();
        content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: small.toString("base64") } });
      }
    }
    content.push({
      type: "text",
      text: JSON.stringify({
        category: l.category,
        title_ru: l.titleRu,
        title_uz: l.titleUz,
        description_ru: l.descriptionRu,
        description_uz: l.descriptionUz,
        condition: l.condition,
        price_uzs: l.price,
        market_range_uzs: market,
        has_photo: !!first,
      }),
    });
    const res = await this.d.ai!.structured({
      feature: "listing.moderate",
      promptId: "listing_moderate",
      content,
      schema: ListingModerationSchema,
    });
    return res.data;
  }
}
