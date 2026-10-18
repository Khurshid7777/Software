import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, avg, count, desc, eq, gt, inArray, isNull, lte, or, sql, ne } from "drizzle-orm";
import { z } from "zod";
import {
  BUMP_INTERVAL_DAYS,
  CONDITIONS,
  ConditionChecklistSchema,
  DELIVERY_MODES,
  EXPIRY_REMINDER_DAYS,
  FEE_PAYERS,
  LISTING_TTL_DAYS,
  MVP_DELIVERY_MODES,
  PRICE_DROP_BADGE_DAYS,
  VERIFIED_BADGE_DAYS,
  PRICE_DROP_MIN_PCT,
  AUTO_DROP_EVERY_DAYS,
  AUTO_DROP_MIN_FLOOR_PCT,
  nextAutoDropPrice,
  sellerBadges,
  type NotifyType,
  PRIVATE_SELLER_ACTIVE_LIMIT,
  TASHKENT_DISTRICTS,
  formatUzs,
  isValidImei,
  listingDescription,
  listingTitle,
  normalizeImei,
  suggestPrice,
  t,
  type Condition,
  type ConditionChecklist,
  type Grade,
  type DeliveryMode,
  type District,
  type Inspection,
  type FeePayer,
  type Lang,
  type ListingAnalysis,
  type ListingDto,
  type ListingSeller,
  type ListingStatus,
  type ModerationRecord,
  type PriceSuggestion,
} from "@ishonch/shared";
import { startOfTashkentDay, type Repo } from "../../db/repo.js";
import {
  channels,
  complaints,
  disputes,
  conversations,
  evidence,
  favorites,
  follows,
  listingPhotos,
  listings,
  orders,
  reviews,
  shops,
  users,
  type Listing,
  type User,
} from "../../db/schema.js";
import { AiLimitExceededError, AiOutputError, type AiService } from "../../ai/aiService.js";
import sharp from "sharp";
import { processImage } from "../../storage/images.js";
import type { Storage } from "../../storage/storage.js";
import { SttUnavailableError, type SpeechToText } from "../../stt/speechToText.js";
import { buildCaption, type ChannelPublisher, type Notifier } from "../../telegram/publisher.js";
import type { StaffNotifier } from "../../telegram/staff.js";
import { hasContactInfo, type ModerationService } from "../moderation/service.js";
import { analyzeListing, generateListingText } from "./ai.js";
import type { EvidenceService } from "../evidence/service.js";

export const MAX_PHOTOS = 10;
/** A price cut deeper than this (percent) sends a live listing back through moderation. */
export const BAIT_DROP_PCT = 35;
/** Sizes of photo copies served with `?w=` (cards, thumbnails, the listing gallery). */
export const PHOTO_WIDTHS = [240, 480, 960];
/** Default for the `listing_ai_per_day` setting: AI drafts + text generations per seller per day. */
export const LISTING_AI_PER_DAY = 30;
const DAY = 24 * 3600_000;

export type ListingError =
  | "need_photo_or_voice"
  | "too_many_photos"
  | "bad_photo_order"
  | "voice_unavailable"
  | "ai_unavailable"
  | "not_found"
  | "forbidden"
  | "bad_state"
  | "phone_required"
  | "need_photo"
  | "fill_required"
  | "limit_reached"
  | "bump_too_soon"
  | "bad_image"
  | "contact_info"
  | "duplicate"
  | "ai_quota"
  | "bad_floor"
  | "bad_request";

/** «🔕 Не присылать такое» under an optional message (stage 20); the bot switches the type off. */
export function unsubscribeRow(lang: Lang, type: NotifyType) {
  return [{ text: t(lang, "notify.unsub"), callbackData: `unsub:${type}` }];
}

export class ListingRejected extends Error {
  constructor(
    public code: ListingError,
    public status: number,
    public params: Record<string, string | number> = {},
  ) {
    super(code);
  }
}

interface AiDraft {
  analysis?: ListingAnalysis;
  transcript?: string;
  answers?: Record<string, string>;
}

export const ListingPatchSchema = z
  .object({
    titleRu: z.string().trim().max(120),
    titleUz: z.string().trim().max(120),
    descriptionRu: z.string().trim().max(4000),
    descriptionUz: z.string().trim().max(4000),
    price: z.number().int().positive().max(10_000_000_000).nullable(),
    condition: z.enum(CONDITIONS).nullable(),
    district: z.enum(TASHKENT_DISTRICTS).nullable(),
    allowedDeliveryModes: z.array(z.enum(DELIVERY_MODES)).min(1),
    feePayer: z.enum(FEE_PAYERS),
    imei: z
      .string()
      .transform(normalizeImei)
      .refine(isValidImei, "invalid IMEI")
      .nullable(),
    checklist: ConditionChecklistSchema,
    acceptsTrade: z.boolean(),
    /** Автоснижение: the floor (null turns it off). */
    autoDropFloor: z.number().int().positive().max(10_000_000_000).nullable(),
  })
  .partial();
export type ListingPatch = z.infer<typeof ListingPatchSchema>;

/** "Battery 87%" answered to the AI's question pre-fills the checklist unless the seller set it. */
function withBatteryAnswer(checklist: ConditionChecklist, answers: Record<string, string>): ConditionChecklist {
  if (checklist.batteryPct != null) return checklist;
  const raw = Object.entries(answers).find(([k]) => /battery|batar|аккум/i.test(k))?.[1];
  const pct = Number(raw?.match(/\d{2,3}/)?.[0]);
  return pct >= 50 && pct <= 100 ? { ...checklist, batteryPct: pct } : checklist;
}

export interface UploadedFile {
  data: Buffer;
  mimeType: string;
}

export interface ListingServiceDeps {
  repo: Repo;
  ai: Pick<AiService, "structured">;
  storage: Storage;
  stt: SpeechToText;
  publisher: ChannelPublisher | null;
  /** Direct messages to sellers (moderation results, expiry reminders). */
  notifier?: Notifier | null;
  staff?: StaffNotifier;
  /** Duplicate search + AI pre-moderation; null = publish without moderation. */
  moderation?: ModerationService | null;
  photoSecret: string;
  /** Evidence files: the seller's video check shows on the listing. */
  evidence?: EvidenceService;
  usdRate: number;
  /** Feature flag: `cod_platform` stays off until there is a legal entity and a courier contract. */
  codPlatformEnabled: boolean;
  /** A listing left sale (sold, archived, hidden, expired): open "new" delivery requests are closed. */
  onUnavailable?: (listingId: string, reason: string) => Promise<unknown>;
  /** Background jobs (channel posts, saved-search alerts). Without it they run inside the request. */
  enqueue?: (kind: string, payload: Record<string, unknown>, runAt?: Date | null) => Promise<void>;
  /** End of the quiet hours when `now` is in them (QUIET_HOURS); absent — optional messages go out at once. */
  quietUntil?: (now: Date) => Date | null;
  /** Hook for saved-search alerts (module A). Failures never block publication. */
  onPublished?: (listingId: string) => Promise<unknown>;
}

export class ListingService {
  constructor(private d: ListingServiceDeps) {}

  get evidence() {
    return this.d.evidence;
  }

  private get db() {
    return this.d.repo.db;
  }

  // ---------- photos ----------
  photoUrl(photoId: number, key: string) {
    return `/photos/${photoId}?s=${this.sign(`${photoId}:${key}`)}`;
  }

  private sign(v: string) {
    return createHmac("sha256", this.d.photoSecret).update(v).digest("base64url").slice(0, 22);
  }

  /**
   * A photo by its signed URL. `width` (one of PHOTO_WIDTHS) returns a smaller copy for cards and thumbnails:
   * made once with sharp and kept next to the original, so lists don't download 2000 px originals.
   */
  async readPhoto(photoId: number, sig: string, width?: number): Promise<Buffer | null> {
    const [p] = await this.db.select().from(listingPhotos).where(eq(listingPhotos.id, photoId));
    if (!p) return null;
    const expected = Buffer.from(this.sign(`${p.id}:${p.storageKey}`));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    if (!width || !PHOTO_WIDTHS.includes(width)) return this.d.storage.get(p.storageKey);
    const variantKey = `${p.storageKey}@w${width}`;
    const cached = await this.d.storage.get(variantKey).catch(() => null);
    if (cached) return cached;
    const original = await this.d.storage.get(p.storageKey);
    if (!original) return null;
    const small = await sharp(original).resize({ width, withoutEnlargement: true }).jpeg({ quality: 78, mozjpeg: true }).toBuffer();
    await this.d.storage.put(variantKey, small, "image/jpeg").catch(() => undefined);
    return small;
  }

  /** The original and its resized copies. */
  private async deletePhotoFiles(storageKey: string) {
    await Promise.all([storageKey, ...PHOTO_WIDTHS.map((w) => `${storageKey}@w${w}`)].map((k) => this.d.storage.delete(k).catch(() => undefined)));
  }

  private async storePhotos(listingId: string, files: UploadedFile[], startPosition: number, stored: Array<{ id: number; storageKey: string }> = []) {
    const aiImages: Buffer[] = [];
    for (const [i, f] of files.entries()) {
      let img;
      try {
        img = await processImage(f.data);
      } catch {
        throw new ListingRejected("bad_image", 400);
      }
      const key = `listings/${listingId}/${Date.now()}-${randomBytes(6).toString("hex")}.jpg`;
      await this.d.storage.put(key, img.full, "image/jpeg");
      const [row] = await this.db
        .insert(listingPhotos)
        .values({
          listingId,
          storageKey: key,
          phash: img.phash,
          width: img.width,
          height: img.height,
          position: startPosition + i,
        })
        .returning({ id: listingPhotos.id, storageKey: listingPhotos.storageKey });
      stored.push(row!);
      aiImages.push(img.ai);
    }
    return aiImages;
  }

  // ---------- creation ----------
  async createDraft(user: User, input: { photos: UploadedFile[]; audio?: UploadedFile; text?: string }) {
    const text = input.text?.trim() || undefined;
    if (input.photos.length === 0 && !input.audio && !text) throw new ListingRejected("need_photo_or_voice", 400);
    if (input.photos.length > MAX_PHOTOS) throw new ListingRejected("too_many_photos", 400);
    const reservation = await this.reserveAi(user);

    let transcript: string | undefined;
    if (input.audio) {
      try {
        transcript = await this.d.stt.transcribe(input.audio.data, { mimeType: input.audio.mimeType });
      } catch (err) {
        if (!(err instanceof SttUnavailableError)) throw err;
        if (input.photos.length === 0 && !text) throw new ListingRejected("voice_unavailable", 503);
      }
    }

    const [row] = await this.db
      .insert(listings)
      .values({ sellerUserId: user.id, status: "draft", sourceText: text ?? null })
      .returning();
    const listing = row!;

    try {
      const aiImages = await this.storePhotos(listing.id, input.photos, 0);
      const { analysis, priceSuggestion } = await this.withAi(() =>
        analyzeListing(
          { images: aiImages, transcript, text },
          {
            ai: this.d.ai,
            usdRate: this.d.usdRate,
            findReferencePrice: (k) => this.d.repo.findReferencePrice(k),
          },
        ),
      );
      const aiDraft: AiDraft = { analysis, transcript, answers: {} };
      await this.db
        .update(listings)
        .set({
          category: analysis.category,
          attributes: { brand: analysis.brand, model: analysis.model, modelKey: analysis.model_key, specs: analysis.specs },
          condition: analysis.condition === "unknown" ? null : analysis.condition,
          price: priceSuggestion?.market ?? null,
          priceSuggestion,
          aiDraft,
          updatedAt: new Date(),
        })
        .where(eq(listings.id, listing.id));
    } catch (err) {
      await this.deleteListing(listing.id);
      if (err instanceof ListingRejected && err.code === "ai_unavailable") await this.d.repo.refundDaily(reservation);
      throw err;
    }
    await this.d.repo.event(user.id, "listing_draft_created", { photos: input.photos.length, voice: !!input.audio });
    return this.dto(listing.id, user.id);
  }

  async generate(user: User, id: string, answers: Record<string, string>) {
    const l = await this.own(user, id);
    // Live listings are edited field by field (and re-moderated), never regenerated wholesale.
    if (!["draft", "rejected"].includes(l.status)) throw new ListingRejected("bad_state", 409);
    const draft = l.aiDraft as AiDraft;
    if (!draft.analysis) throw new ListingRejected("bad_state", 409);

    const merged = { ...(draft.answers ?? {}), ...answers };
    const reservation = await this.reserveAi(user);
    const sellerWords = [draft.transcript, l.sourceText].filter(Boolean).join("\n");
    const { text } = await this.withAi(() =>
      generateListingText({ analysis: draft.analysis!, answers: merged, sellerWords }, { ai: this.d.ai }),
    ).catch(async (err) => {
      if (err instanceof ListingRejected && err.code === "ai_unavailable") await this.d.repo.refundDaily(reservation);
      throw err;
    });

    // Answers can change the model key (e.g. storage) → refresh the price suggestion.
    let priceSuggestion = l.priceSuggestion as PriceSuggestion | null;
    const oldMarket = priceSuggestion?.market ?? null;
    const storage = merged.storage?.match(/\d+\s*(gb|гб|tb|тб)/i)?.[0];
    const modelKey = draft.analysis.model_key;
    if (storage && modelKey && !/\d+\s*(gb|tb)/.test(modelKey)) {
      const ref = await this.d.repo.findReferencePrice(`${modelKey} ${storage}`);
      if (ref) priceSuggestion = suggestPrice(ref, "reference");
    }

    await this.db
      .update(listings)
      .set({
        titleRu: text.title_ru,
        titleUz: text.title_uz,
        descriptionRu: text.description_ru,
        descriptionUz: text.description_uz,
        aiDraft: { ...draft, answers: merged },
        priceSuggestion,
        checklist: withBatteryAnswer(l.checklist as ConditionChecklist, merged),
        // Keep a price the seller typed; otherwise follow the (possibly refreshed) suggestion.
        price: l.price == null || l.price === oldMarket ? (priceSuggestion?.market ?? l.price) : l.price,
        updatedAt: new Date(),
      })
      .where(eq(listings.id, id));
    return this.dto(id, user.id);
  }

  async update(user: User, id: string, patch: ListingPatch) {
    const l = await this.own(user, id);
    if (!["draft", "active", "pending", "rejected", "reserved"].includes(l.status)) throw new ListingRejected("bad_state", 409);
    const modes = patch.allowedDeliveryModes?.filter((m) => this.d.codPlatformEnabled || MVP_DELIVERY_MODES.includes(m));
    if (modes && modes.length === 0) throw new ListingRejected("fill_required", 400);
    const textChanged = (["titleRu", "titleUz", "descriptionRu", "descriptionUz"] as const).some(
      (k) => patch[k] !== undefined && patch[k] !== l[k],
    );
    const imeiChanged = patch.imei !== undefined && patch.imei !== l.imei;
    // A reserved item is being delivered: what the buyer ordered must not change under them.
    if (l.status === "reserved" && (textChanged || imeiChanged || patch.price !== undefined || patch.checklist !== undefined)) throw new ListingRejected("bad_state", 409);
    if (patch.price === null && l.status !== "draft") throw new ListingRejected("fill_required", 400);
    if (textChanged && l.status !== "draft" && hasContactInfo({ ...l, ...patch })) throw new ListingRejected("contact_info", 400);
    const now = new Date();
    // Автоснижение: the floor must sit below the price and not under half of it; the first step in 3 days.
    let autoDrop: Partial<Listing> = {};
    if (patch.autoDropFloor !== undefined) {
      const price = patch.price ?? l.price;
      if (patch.autoDropFloor === null) autoDrop = { autoDropAt: null };
      else if (!price || patch.autoDropFloor >= price || patch.autoDropFloor < (price * AUTO_DROP_MIN_FLOOR_PCT) / 100) {
        throw new ListingRejected("bad_floor", 400, { min: formatUzs(Math.ceil((price ?? 0) * AUTO_DROP_MIN_FLOOR_PCT / 100)) });
      } else autoDrop = { autoDropAt: new Date(now.getTime() + AUTO_DROP_EVERY_DAYS * DAY) };
    }
    const priceChange = l.status === "active" && patch.price != null && l.price != null && patch.price !== l.price ? this.priceChange(l, patch.price, now) : {};
    await this.db
      .update(listings)
      .set({ ...patch, ...(modes ? { allowedDeliveryModes: modes } : {}), ...priceChange, ...autoDrop, updatedAt: now })
      // Compare-and-set on the status read above: an order confirmed meanwhile (reserved) wins.
      .where(and(eq(listings.id, id), eq(listings.status, l.status)))
      .returning({ id: listings.id })
      .then((rows) => {
        if (!rows.length) throw new ListingRejected("bad_state", 409);
      });
    const priceChanged = patch.price != null && l.price != null && patch.price !== l.price;
    // Open delivery requests were quoted at the old price: they close and the buyers are told to re-order.
    if (priceChanged && l.status === "active") await this.d.onUnavailable?.(id, "price_changed");
    // A live listing whose text or IMEI changed, or whose price fell by more than a third (a classic bait:
    // approved at a fair price, then dropped to lure buyers), goes through moderation again.
    const baitDrop = priceChanged && patch.price! < l.price! * (1 - BAIT_DROP_PCT / 100);
    if ((textChanged || imeiChanged || baitDrop) && l.status === "active") await this.remoderate(id);
    // A lower price may now fit saved searches capped below the old one (each search hears about a listing once).
    if ("priceDroppedAt" in priceChange && priceChange.priceDroppedAt && l.status === "active") await this.schedule("saved_search_alerts", { listingId: id });
    if ("priceDroppedAt" in priceChange && priceChange.priceDroppedAt && l.price! - patch.price! >= (l.price! * PRICE_DROP_MIN_PCT) / 100) {
      await this.schedule("price_drop_alerts", { listingId: id, price: patch.price }, this.quiet(now));
    }
    return this.dto(id, user.id);
  }

  /**
   * Bookkeeping for the crossed-out old price: a reduction remembers the highest price of the current badge
   * period (several small cuts read as one), a raise back to or above it clears the badge.
   */
  private priceChange(l: Listing, price: number, now: Date) {
    const badgeLive = l.previousPrice != null && l.priceDroppedAt != null && now.getTime() - l.priceDroppedAt.getTime() < PRICE_DROP_BADGE_DAYS * DAY;
    const reference = badgeLive ? Math.max(l.previousPrice!, l.price!) : l.price!;
    if (price < l.price!) return { previousPrice: reference, priceDroppedAt: now };
    if (price >= reference) return { previousPrice: null, priceDroppedAt: null };
    return {}; // raised, but still below the old price: the badge stays
  }

  /**
   * «Украли телефон»: live listings with a newly reported IMEI go through moderation again (and to a moderator,
   * since the report makes the review hold them). The reporter's own listings are not touched.
   */
  async recheckImei(imei: string, reporterId: string) {
    const rows = await this.db
      .select({ id: listings.id })
      .from(listings)
      .where(and(eq(listings.imei, imei), eq(listings.status, "active"), ne(listings.sellerUserId, reporterId)));
    for (const r of rows) await this.remoderate(r.id);
    return rows.length;
  }

  private async remoderate(id: string) {
    if (!this.d.moderation) return;
    const [fresh] = await this.db.select().from(listings).where(eq(listings.id, id));
    if (!fresh || fresh.status !== "active") return;
    const record = await this.d.moderation.review(fresh);
    if (record.decision !== "approved") await this.holdForModeration(fresh, record, { from: ["active"] });
    else await this.db.update(listings).set({ moderation: record }).where(eq(listings.id, id));
  }

  async addPhotos(user: User, id: string, files: UploadedFile[]) {
    const l = await this.own(user, id);
    if (!["draft", "active", "pending", "rejected"].includes(l.status)) throw new ListingRejected("bad_state", 409);
    const photoStats = async () =>
      ((await this.db
        .select({ n: count(), last: sql<number>`coalesce(max(${listingPhotos.position}), -1)::int` })
        .from(listingPhotos)
        .where(eq(listingPhotos.listingId, id))) as [{ n: number; last: number }])[0];
    const { n, last } = await photoStats();
    if (n + files.length > MAX_PHOTOS) throw new ListingRejected("too_many_photos", 400);
    // After the last position, not the count: a deleted photo leaves a gap, and equal positions would make the
    // channel post and the card disagree on the cover.
    const stored: Array<{ id: number; storageKey: string }> = [];
    await this.storePhotos(id, files, last + 1, stored);
    // Two uploads at once may both pass the check above: the later one gives its photos back.
    if ((await photoStats()).n > MAX_PHOTOS) {
      await this.db.delete(listingPhotos).where(inArray(listingPhotos.id, stored.map((p) => p.id)));
      await Promise.all(stored.map((p) => this.deletePhotoFiles(p.storageKey)));
      throw new ListingRejected("too_many_photos", 400);
    }
    // New photos on a live listing are checked like new text (duplicates, item swap).
    if (l.status === "active") await this.remoderate(id);
    return this.dto(id, user.id);
  }

  /** New photo order (the first one is the cover): `ids` must be exactly the listing's photos. */
  async reorderPhotos(user: User, id: string, ids: number[]) {
    const l = await this.own(user, id);
    if (!["draft", "active", "pending", "rejected", "archived"].includes(l.status)) throw new ListingRejected("bad_state", 409);
    const current = await this.db.select({ id: listingPhotos.id }).from(listingPhotos).where(eq(listingPhotos.listingId, id));
    const known = new Set(current.map((p) => p.id));
    if (ids.length !== known.size || new Set(ids).size !== ids.length || ids.some((x) => !known.has(x))) {
      throw new ListingRejected("bad_photo_order", 400);
    }
    await this.db.transaction(async (tx) => {
      for (const [position, photoId] of ids.entries()) {
        await tx.update(listingPhotos).set({ position }).where(and(eq(listingPhotos.id, photoId), eq(listingPhotos.listingId, id)));
      }
    });
    return this.dto(id, user.id);
  }

  async deletePhoto(user: User, id: string, photoId: number) {
    const l = await this.own(user, id);
    if (!["draft", "active", "pending", "rejected", "archived"].includes(l.status)) throw new ListingRejected("bad_state", 409);
    if (l.status === "active") {
      const [{ n }] = (await this.db.select({ n: count() }).from(listingPhotos).where(eq(listingPhotos.listingId, id))) as [
        { n: number },
      ];
      if (n <= 1) throw new ListingRejected("need_photo", 400);
    }
    const [p] = await this.db
      .delete(listingPhotos)
      .where(and(eq(listingPhotos.id, photoId), eq(listingPhotos.listingId, id)))
      .returning();
    if (p) await this.deletePhotoFiles(p.storageKey);
    return this.dto(id, user.id);
  }

  // ---------- publication ----------
  /**
   * Draft / archived / rejected → moderation → active (or pending for a moderator, or rejected).
   * Order: required fields → contact info in text → own duplicates → limit → duplicates of others + AI review.
   */
  async publish(user: User, id: string, channelIds: number[] = []) {
    const l = await this.own(user, id);
    if (!["draft", "archived", "rejected"].includes(l.status)) throw new ListingRejected("bad_state", 409);
    if (!user.phone) throw new ListingRejected("phone_required", 409);
    if (!l.titleRu || !l.titleUz || !l.descriptionRu || !l.descriptionUz || !l.price) {
      throw new ListingRejected("fill_required", 400);
    }
    const [{ photos }] = (await this.db
      .select({ photos: count() })
      .from(listingPhotos)
      .where(eq(listingPhotos.listingId, id))) as [{ photos: number }];
    if (photos === 0) throw new ListingRejected("need_photo", 400);
    if (hasContactInfo(l)) throw new ListingRejected("contact_info", 400);

    const shop = await this.shopOf(user.id);
    const duplicates = this.d.moderation ? await this.d.moderation.findDuplicates(l) : null;
    // The same photos in another live listing of this seller: bump that one instead (shops may sell identical stock).
    if (duplicates?.own.length && !shop?.verified) throw new ListingRejected("duplicate", 409, { id: duplicates.own[0]! });
    await this.assertUnderLimit(user);

    const record: ModerationRecord = this.d.moderation
      ? await this.d.moderation.review(l, duplicates!)
      : { decision: "approved", source: "rules", reasons: [], at: new Date().toISOString() };
    // Archive → republish must not undo a moderator's rejection or a complaint hide: those go back to a person.
    const prev = l.moderation as ModerationRecord | null;
    const [{ open }] = (await this.db
      .select({ open: count() })
      .from(complaints)
      .where(and(eq(complaints.listingId, id), isNull(complaints.resolvedAt)))) as [{ open: number }];
    const rejectedByAdmin = prev?.source === "admin" && prev.decision === "rejected";
    if (record.decision === "approved" && (open > 0 || rejectedByAdmin)) {
      record.decision = "needs_review";
      record.reasons.push({
        code: open > 0 ? "complaints" : "other",
        note: open > 0 ? `Повторная публикация при ${open} открытых жалобах` : "Повторная публикация после отклонения модератором",
      });
    }
    await this.db.update(listings).set({ shopId: shop?.id ?? null }).where(eq(listings.id, id));
    if (user.role === "buyer") await this.db.update(users).set({ role: "seller" }).where(eq(users.id, user.id));

    if (record.decision !== "approved") {
      const held = await this.holdForModeration(
        { ...l, shopId: shop?.id ?? null },
        { ...record, pendingChannelIds: channelIds },
        { notifySeller: false, from: [l.status] },
      );
      if (!held) throw new ListingRejected("bad_state", 409); // a parallel publish got there first
      await this.d.repo.event(user.id, "listing_moderation", { listingId: id, decision: record.decision, source: record.source });
      return { listing: await this.dto(id, user.id), postedChannels: 0, failedChannels: 0, moderation: record.decision };
    }
    const posted = await this.activate(id, channelIds, record, [l.status]);
    await this.d.repo.event(user.id, "listing_published", { listingId: id, channels: posted.length });
    return {
      listing: await this.dto(id, user.id),
      postedChannels: posted.length,
      failedChannels: channelIds.length - posted.length,
      moderation: record.decision,
    };
  }

  /** Makes a listing live: 30 days from now, channel posts, saved-search alerts. Used by publish and admin approval. */
  async activate(id: string, channelIds: number[], record: ModerationRecord, from: string[]) {
    const [l] = await this.db.select().from(listings).where(eq(listings.id, id));
    if (!l) throw new ListingRejected("not_found", 404);
    const now = new Date();
    // A live listing hidden for a while (complaints, re-moderation) keeps its place and expiry when approved.
    const keepClock = l.status === "pending" && !!l.publishedAt && !!l.expiresAt && l.expiresAt > now;
    // Compare-and-set on the status: a double tap or two moderators clicking at once activate only once.
    const updated = await this.db
      .update(listings)
      .set({
        status: "active",
        moderation: record,
        moderationReason: null,
        publishedAt: l.publishedAt ?? now,
        ...(keepClock ? {} : { bumpedAt: now, expiresAt: new Date(now.getTime() + LISTING_TTL_DAYS * DAY), expiryRemindedAt: null }),
        updatedAt: now,
      })
      .where(and(eq(listings.id, id), inArray(listings.status, from)))
      .returning({ id: listings.id });
    if (!updated.length) throw new ListingRejected("bad_state", 409);
    // Channel posts and subscriber alerts are slow (Telegram, many subscribers): they leave the request.
    const own = channelIds.length
      ? await this.db.select({ id: channels.id }).from(channels).where(and(eq(channels.userId, l.sellerUserId), inArray(channels.id, channelIds)))
      : [];
    if (own.length) await this.schedule("channel_posts", { listingId: id, channelIds: own.map((c) => c.id), since: now.toISOString() });
    await this.schedule("saved_search_alerts", { listingId: id });
    // A relisted or restored item is not news: followers hear only about a first publication.
    if (!l.publishedAt) await this.schedule("follower_alerts", { listingId: id }, this.quiet(now));
    return own;
  }

  private quiet(now: Date) {
    return this.d.quietUntil?.(now) ?? null;
  }

  /** `runAt`: deliver later (quiet hours). Without a queue the job runs now. */
  private async schedule(kind: string, payload: Record<string, unknown>, runAt?: Date | null) {
    if (this.d.enqueue) return this.d.enqueue(kind, payload, runAt);
    await this.runJob(kind, payload).catch((err) => console.error(`${kind} failed`, err));
  }

  /** Job handlers (also used directly when there is no queue). */
  async runJob(kind: string, payload: Record<string, unknown>) {
    if (kind === "saved_search_alerts") return this.d.onPublished?.(String(payload.listingId));
    if (kind === "price_drop_alerts") return this.priceDropAlerts(String(payload.listingId), Number(payload.price));
    if (kind === "follower_alerts") return this.followerAlerts(String(payload.listingId));
    if (kind === "channel_posts") {
      const id = String(payload.listingId);
      const [l] = await this.db.select().from(listings).where(eq(listings.id, id));
      if (!l || l.status !== "active") return; // withdrawn meanwhile: nothing to advertise
      const [seller] = await this.db.select().from(users).where(eq(users.id, l.sellerUserId));
      if (!seller) return;
      // On a retry, skip channels that already got this publication's post (no duplicates in the channel).
      const since = String(payload.since ?? "");
      const done = new Set(
        ((l.channelPosts as Array<{ channelId: number; at: string }>) ?? []).filter((p) => p.at >= since).map((p) => p.channelId),
      );
      const todo = (payload.channelIds as number[]).filter((c) => !done.has(c));
      const { failed } = await this.postToChannels(seller, id, todo);
      if (failed > 0) throw new Error(`${failed} channel post(s) failed`); // the queue retries the rest
    }
  }

  /** needs_review → pending (moderators are asked), rejected → rejected (the seller is told why). */
  async holdForModeration(l: Listing, record: ModerationRecord, opts: { notifySeller?: boolean; from: string[] }) {
    const status = record.decision === "rejected" ? "rejected" : "pending";
    const reason = record.reasons[0]?.code ?? "other";
    // Only from the expected status: a listing reserved or sold meanwhile is left alone.
    const updated = await this.db
      .update(listings)
      .set({ status, moderation: record, moderationReason: reason, updatedAt: new Date() })
      .where(and(eq(listings.id, l.id), inArray(listings.status, opts.from)))
      .returning({ id: listings.id });
    if (!updated.length) return false;
    await this.d.onUnavailable?.(l.id, "listing_unavailable");
    if (status === "pending") {
      const notes = record.reasons.map((r) => `• ${r.code}: ${r.note}`).join("\n");
      const url = this.d.publisher ? await this.d.publisher.miniAppLink(`listing_${l.id}`).catch(() => null) : null;
      await this.d.staff?.moderators(
        t("ru", "staff.moderation_pending", { title: l.titleRu || l.titleUz, price: l.price ? formatUzs(l.price) : "—", notes }),
        [
          [
            { text: "✅ Одобрить", callbackData: `mod:approve:${l.id}` },
            { text: "⛔️ Отклонить", callbackData: `mod:reject:${l.id}` },
          ],
          ...(url ? [[{ text: "Открыть", url }]] : []),
        ],
      );
    }
    if (opts.notifySeller !== false) await this.notifySeller(l, status === "pending" ? "moderation.hidden" : "moderation.rejected", record);
    return true;
  }

  /**
   * "Новый товар у продавца, на которого вы подписаны" (Depop / Vinted follow): at most one message per
   * follower and seller a Tashkent day — the day is claimed in follows.last_notified_at before sending.
   */
  async followerAlerts(listingId: string, now = new Date()) {
    if (!this.d.notifier) return 0;
    const [l] = await this.db.select().from(listings).where(eq(listings.id, listingId));
    if (!l || l.status !== "active") return 0;
    const claimed = await this.db
      .update(follows)
      .set({ lastNotifiedAt: now })
      .where(
        and(
          eq(follows.sellerUserId, l.sellerUserId),
          sql`(${follows.lastNotifiedAt} is null or ${follows.lastNotifiedAt} < ${startOfTashkentDay(now).toISOString()})`,
          sql`${follows.followerUserId} in (select id from ${users} where banned_at is null and not ('follow' = any(notify_off)))`,
        ),
      )
      .returning({ userId: follows.followerUserId });
    if (!claimed.length) return 0;
    const fans = await this.db.select().from(users).where(inArray(users.id, claimed.map((c) => c.userId)));
    const [shop] = await this.db.select({ name: shops.name }).from(shops).where(eq(shops.ownerUserId, l.sellerUserId));
    const url = this.d.publisher ? await this.d.publisher.miniAppLink(`listing_${l.id}`).catch(() => null) : null;
    let sent = 0;
    for (const u of fans) {
      const lang = u.language as Lang;
      const ok = await this.d.notifier
        .send(
          u.telegramId,
          t(lang, "follow.new_listing", {
            seller: shop?.name ?? t(lang, "seller.private"),
            title: listingTitle(l, lang),
            price: l.price ? formatUzs(l.price) : "",
          }),
          [...(url ? [[{ text: t(lang, "bot.open_listing"), url }]] : []), unsubscribeRow(lang, "follow")],
        )
        .then(() => true)
        .catch(() => false);
      if (ok) sent++;
    }
    return sent;
  }

  /** Follow / unfollow a seller (not yourself, not a banned or unknown user). */
  async follow(user: User, sellerId: string, on: boolean) {
    if (sellerId === user.id) throw new ListingRejected("bad_request", 400);
    const [seller] = await this.db.select().from(users).where(eq(users.id, sellerId));
    if (!seller || seller.bannedAt) throw new ListingRejected("not_found", 404);
    if (on) await this.db.insert(follows).values({ followerUserId: user.id, sellerUserId: sellerId }).onConflictDoNothing();
    else await this.db.delete(follows).where(and(eq(follows.followerUserId, user.id), eq(follows.sellerUserId, sellerId)));
    const [{ n }] = (await this.db.select({ n: count() }).from(follows).where(eq(follows.sellerUserId, sellerId))) as [{ n: number }];
    return { following: on, followers: Number(n) };
  }

  async isFollowing(userId: string, sellerId: string) {
    const [row] = await this.db
      .select({ s: follows.sellerUserId })
      .from(follows)
      .where(and(eq(follows.followerUserId, userId), eq(follows.sellerUserId, sellerId)));
    return !!row;
  }

  /** The sellers a user follows (newest first), as public seller cards. */
  async following(user: User) {
    const rows = await this.db
      .select({ u: users })
      .from(follows)
      .innerJoin(users, eq(users.id, follows.sellerUserId))
      .where(and(eq(follows.followerUserId, user.id), isNull(users.bannedAt)))
      .orderBy(desc(follows.createdAt))
      .limit(100);
    const infos = await this.sellerInfos(rows.map((r) => r.u));
    return rows.map((r) => infos.get(r.u.id)!);
  }

  /**
   * "Цена снижена" for everyone who saved the listing (Vinted / Mercari / Avito do the same): one alert per
   * user and listing per day, only while the listing is still active at that price.
   */
  async priceDropAlerts(listingId: string, price: number) {
    if (!this.d.notifier) return;
    const [l] = await this.db.select().from(listings).where(eq(listings.id, listingId));
    if (!l || l.status !== "active" || l.price !== price || !l.previousPrice) return;
    const fans = await this.db
      .select({ id: users.id, telegramId: users.telegramId, language: users.language })
      .from(favorites)
      .innerJoin(users, eq(users.id, favorites.userId))
      .where(
        and(
          eq(favorites.listingId, listingId),
          sql`${users.id} <> ${l.sellerUserId}`,
          sql`${users.bannedAt} is null`,
          sql`not ('price_drop' = any(${users.notifyOff}))`,
          sql`not exists (select 1 from events e where e.user_id = ${users.id} and e.name = 'price_drop_alert'
                and e.props->>'listingId' = ${listingId} and e.created_at > now() - interval '24 hours')`,
        ),
      );
    if (!fans.length) return;
    const url = this.d.publisher ? await this.d.publisher.miniAppLink(`listing_${listingId}`).catch(() => null) : null;
    for (const u of fans) {
      const lang = u.language as Lang;
      const text = t(lang, "favorites.price_drop", { title: listingTitle(l, lang), old: formatUzs(l.previousPrice), price: formatUzs(price) });
      const sent = await this.d.notifier
        .send(u.telegramId, text, [...(url ? [[{ text: t(lang, "favorites.open"), url }]] : []), unsubscribeRow(lang, "price_drop")])
        .then(() => true)
        .catch((err) => (console.error("price drop alert failed", err), false));
      if (sent) await this.d.repo.event(u.id, "price_drop_alert", { listingId });
    }
  }

  /** Seller DM about a moderation outcome; the AI's own advice is appended when present. */
  async notifySeller(l: Listing, key: "moderation.hidden" | "moderation.rejected" | "moderation.approved", record?: ModerationRecord | null) {
    if (!this.d.notifier) return;
    const [seller] = await this.db.select().from(users).where(eq(users.id, l.sellerUserId));
    if (!seller) return;
    const lang = seller.language as Lang;
    const advice = record?.sellerMessage?.[lang];
    const text = t(lang, key, { title: listingTitle(l, lang) }) + (advice ? `\n\n${advice}` : "");
    const url = this.d.publisher ? await this.d.publisher.miniAppLink("screen_my").catch(() => null) : null;
    await this.d.notifier
      .send(seller.telegramId, text, url ? [[{ text: t(lang, "home.my.title"), url }]] : [])
      .catch((err) => console.error("seller notification failed", err));
  }

  private async assertUnderLimit(user: User) {
    if (user.role === "admin") return;
    // Anyone can create a shop profile; only a shop verified by an admin is free of the private-seller limit.
    if (user.role === "shop" && (await this.shopOf(user.id))?.verified) return;
    const [{ n }] = (await this.db
      .select({ n: count() })
      .from(listings)
      .where(and(eq(listings.sellerUserId, user.id), inArray(listings.status, ["active", "pending", "reserved"])))) as [
      { n: number },
    ];
    if (n >= PRIVATE_SELLER_ACTIVE_LIMIT) throw new ListingRejected("limit_reached", 409, { n: PRIVATE_SELLER_ACTIVE_LIMIT });
  }

  private async postToChannels(user: User, id: string, channelIds: number[]) {
    if (!this.d.publisher || channelIds.length === 0) return { posted: [], failed: 0 };
    const own = await this.db
      .select()
      .from(channels)
      .where(and(eq(channels.userId, user.id), inArray(channels.id, channelIds)));
    if (own.length === 0) return { posted: [], failed: 0 };

    const dto = await this.dto(id, user.id);
    const lang = user.language as Lang;
    const [first] = await this.db
      .select()
      .from(listingPhotos)
      .where(eq(listingPhotos.listingId, id))
      .orderBy(asc(listingPhotos.position), asc(listingPhotos.id))
      .limit(1);
    const photo = first ? await this.d.storage.get(first.storageKey) : null;
    const meta = [
      dto.condition ? `${t(lang, "sell.field.condition")}: ${t(lang, `condition.${dto.condition}`)}` : null,
      `📍 ${lang === "ru" ? "Ташкент" : "Toshkent"}${dto.district ? `, ${t(lang, `district.${dto.district}`)}` : ""}`,
    ].filter((x): x is string => !!x);
    const caption = buildCaption({
      title: listingTitle(dto, lang),
      price: dto.price ? formatUzs(dto.price) : null,
      meta,
      description: listingDescription(dto, lang),
      footer: "#Ishonch",
    });
    const url = await this.d.publisher.miniAppLink(`listing_${id}`);

    const posted: Array<{ channelId: number; messageId: number; at: string }> = [];
    await Promise.all(
      own.map(async (ch) => {
        try {
          const { messageId } = await this.d.publisher!.post(ch.telegramChannelId, {
            photo,
            caption,
            button: { text: t(lang, "listing.buy_delivery"), url },
          });
          posted.push({ channelId: ch.id, messageId, at: new Date().toISOString() });
        } catch (err) {
          console.error("channel post failed", ch.telegramChannelId, err);
        }
      }),
    );
    if (posted.length) {
      await this.db
        .update(listings)
        .set({ channelPosts: sql`${listings.channelPosts} || ${JSON.stringify(posted)}::jsonb` })
        .where(eq(listings.id, id));
    }
    return { posted, failed: own.length - posted.length };
  }

  // ---------- management ----------
  /**
   * The buyer reported buying the item at a meeting arranged on Ishonch (stage 18). Not counted in
   * "platform sales" — those are delivered orders only, which Ishonch sees itself.
   */
  async soldAtMeeting(id: string) {
    const done = await this.db
      .update(listings)
      .set({ status: "sold", soldVia: "platform", soldAt: new Date(), updatedAt: new Date() })
      .where(and(eq(listings.id, id), eq(listings.status, "active")))
      .returning({ id: listings.id });
    if (done.length) await this.d.onUnavailable?.(id, "listing_unavailable");
    return done.length > 0;
  }

  async markSold(user: User, id: string, via: "platform" | "elsewhere") {
    const l = await this.own(user, id);
    // A reserved listing is sold through its delivery order (or the order is cancelled first).
    const from = ["active", "pending", "archived"];
    if (!from.includes(l.status)) throw new ListingRejected("bad_state", 409);
    // Compare-and-set: a delivery confirmed at the same moment (bot button) wins, not this tap.
    const done = await this.db
      .update(listings)
      .set({ status: "sold", soldVia: via, soldAt: new Date(), updatedAt: new Date() })
      .where(and(eq(listings.id, id), inArray(listings.status, from)))
      .returning({ id: listings.id });
    if (!done.length) throw new ListingRejected("bad_state", 409);
    await this.d.onUnavailable?.(id, "listing_unavailable");
    await this.d.repo.event(user.id, "listing_sold", { listingId: id, via });
    return this.dto(id, user.id);
  }

  async archive(user: User, id: string) {
    const l = await this.own(user, id);
    const from = ["active", "pending", "draft", "rejected"];
    if (!from.includes(l.status)) throw new ListingRejected("bad_state", 409);
    const done = await this.db
      .update(listings)
      .set({ status: "archived", moderationReason: null, updatedAt: new Date() })
      .where(and(eq(listings.id, id), inArray(listings.status, from)))
      .returning({ id: listings.id });
    if (!done.length) throw new ListingRejected("bad_state", 409);
    await this.d.onUnavailable?.(id, "listing_unavailable");
    return this.dto(id, user.id);
  }

  async bump(user: User, id: string) {
    const l = await this.own(user, id);
    if (l.status !== "active") throw new ListingRejected("bad_state", 409);
    const next = l.bumpedAt ? new Date(l.bumpedAt.getTime() + BUMP_INTERVAL_DAYS * DAY) : null;
    if (next && next > new Date()) throw new ListingRejected("bump_too_soon", 429, { date: next.toISOString() });
    await this.db.update(listings).set({ bumpedAt: new Date() }).where(eq(listings.id, id));
    return this.dto(id, user.id);
  }

  /** Extends an active listing (or one archived on expiry) by another 30 days. */
  async renew(user: User, id: string) {
    const l = await this.own(user, id);
    const expired = l.status === "archived" && l.moderationReason === "expired";
    if (l.status !== "active" && !expired) throw new ListingRejected("bad_state", 409);
    if (expired) await this.assertUnderLimit(user);
    const now = new Date();
    await this.db
      .update(listings)
      .set({
        status: "active",
        moderationReason: null,
        expiresAt: new Date(now.getTime() + LISTING_TTL_DAYS * DAY),
        expiryRemindedAt: null,
        ...(expired ? { bumpedAt: now } : {}),
        updatedAt: now,
      })
      // Compare-and-set: a listing reserved or hidden by moderation meanwhile must not come back to life.
      .where(and(eq(listings.id, id), eq(listings.status, l.status), expired ? eq(listings.moderationReason, "expired") : sql`true`))
      .returning({ id: listings.id })
      .then((rows) => {
        if (!rows.length) throw new ListingRejected("bad_state", 409);
      });
    await this.d.repo.event(user.id, "listing_renewed", { listingId: id, expired });
    return this.dto(id, user.id);
  }

  /**
   * Hourly job: reminds sellers 3 days before expiry (button "Renew") and archives expired listings.
   * Returns counts for logs/tests.
   */
  /**
   * Автоснижение (Mercari Smart Pricing): live listings whose step is due drop by AUTO_DROP_PCT down to the
   * seller's floor. A drop is an ordinary price change: favorites are alerted, open requests quoted at the
   * old price close. The seller is told each time; reaching the floor ends it.
   */
  async runAutoDrops(now = new Date()) {
    const due = await this.db
      .select()
      .from(listings)
      .where(and(eq(listings.status, "active"), sql`${listings.autoDropFloor} is not null`, lte(listings.autoDropAt, now)))
      .limit(200);
    let dropped = 0;
    for (const l of due) {
      const price = nextAutoDropPrice(l.price!, l.autoDropFloor!);
      if (!l.price || price >= l.price) {
        await this.db.update(listings).set({ autoDropFloor: null, autoDropAt: null }).where(eq(listings.id, l.id));
        continue;
      }
      const atFloor = price <= l.autoDropFloor!;
      const [changed] = await this.db
        .update(listings)
        .set({
          price,
          ...this.priceChange(l, price, now),
          autoDropFloor: atFloor ? null : l.autoDropFloor,
          autoDropAt: atFloor ? null : new Date(now.getTime() + AUTO_DROP_EVERY_DAYS * DAY),
          updatedAt: now,
        })
        // Compare-and-set: a seller editing the price meanwhile wins.
        .where(and(eq(listings.id, l.id), eq(listings.status, "active"), eq(listings.price, l.price)))
        .returning({ id: listings.id });
      if (!changed) continue;
      dropped++;
      await this.d.onUnavailable?.(l.id, "price_changed");
      if (l.price - price >= (l.price * PRICE_DROP_MIN_PCT) / 100) await this.schedule("price_drop_alerts", { listingId: l.id, price }, this.quiet(now));
      const [seller] = await this.db.select().from(users).where(eq(users.id, l.sellerUserId));
      if (seller && this.d.notifier) {
        const lang = seller.language as Lang;
        const url = this.d.publisher ? await this.d.publisher.miniAppLink("screen_my").catch(() => null) : null;
        await this.d.notifier
          .send(
            seller.telegramId,
            t(lang, atFloor ? "autodrop.reached_floor" : "autodrop.dropped", {
              title: listingTitle(l, lang),
              price: formatUzs(price),
              floor: formatUzs(l.autoDropFloor!),
            }),
            url ? [[{ text: t(lang, "autodrop.manage"), url }]] : [],
          )
          .catch(() => undefined);
      }
    }
    return dropped;
  }

  async runExpiry(now = new Date()) {
    const soon = new Date(now.getTime() + EXPIRY_REMINDER_DAYS * DAY);
    const toRemind = await this.db
      .select()
      .from(listings)
      .where(and(eq(listings.status, "active"), lte(listings.expiresAt, soon), gt(listings.expiresAt, now), isNull(listings.expiryRemindedAt)))
      .limit(500);
    let reminded = 0;
    for (const l of toRemind) {
      // Claim first so a second API instance does not send the same reminder.
      const claimed = await this.db
        .update(listings)
        .set({ expiryRemindedAt: now })
        .where(and(eq(listings.id, l.id), isNull(listings.expiryRemindedAt)))
        .returning({ id: listings.id });
      if (!claimed.length) continue;
      if (await this.dmSeller(l, "expiry.reminder", [{ key: "expiry.renew", callbackData: `renew:${l.id}` }])) reminded++;
    }

    const expired = await this.db
      .update(listings)
      .set({ status: "archived", moderationReason: "expired", updatedAt: now })
      .where(and(eq(listings.status, "active"), lte(listings.expiresAt, now)))
      .returning();
    for (const l of expired) {
      await this.d.onUnavailable?.(l.id, "listing_unavailable");
      await this.dmSeller(l, "expiry.archived", [{ key: "expiry.renew", callbackData: `renew:${l.id}` }]);
    }
    return { reminded, archived: expired.length };
  }

  private async dmSeller(l: Listing, key: "expiry.reminder" | "expiry.archived", buttons: Array<{ key: "expiry.renew"; callbackData: string }>) {
    if (!this.d.notifier) return false;
    const [seller] = await this.db.select().from(users).where(eq(users.id, l.sellerUserId));
    if (!seller || seller.bannedAt) return false;
    const lang = seller.language as Lang;
    const date = l.expiresAt ? l.expiresAt.toLocaleDateString(lang === "ru" ? "ru-RU" : "uz-UZ", { timeZone: "Asia/Tashkent" }) : "";
    try {
      await this.d.notifier.send(
        seller.telegramId,
        t(lang, key, { title: listingTitle(l, lang), date }),
        [buttons.map((b) => ({ text: t(lang, b.key), callbackData: b.callbackData }))],
      );
      return true;
    } catch (err) {
      console.error("expiry notification failed", err);
      return false;
    }
  }

  /** Tabs: "active" also shows reserved listings, "pending" also shows rejected ones. */
  async mine(user: User, status?: ListingStatus) {
    const statuses = status === "active" ? ["active", "reserved"] : status === "pending" ? ["pending", "rejected"] : status ? [status] : null;
    const rows = await this.db
      .select({ id: listings.id })
      .from(listings)
      .where(and(eq(listings.sellerUserId, user.id), statuses ? inArray(listings.status, statuses) : undefined))
      .orderBy(desc(listings.updatedAt))
      .limit(200);
    return this.dtos(
      rows.map((r) => r.id),
      user.id,
    );
  }

  /** Public card. Counts a view when the viewer is not the seller. */
  async view(id: string, viewer: User | null) {
    const [l] = await this.db.select().from(listings).where(eq(listings.id, id));
    if (!l) throw new ListingRejected("not_found", 404);
    const isOwner = viewer?.id === l.sellerUserId;
    // Staff open any listing (moderation queue, complaints, orders) without counting a view.
    const isStaff = viewer?.role === "admin" || viewer?.role === "operator";
    if (!isOwner && !isStaff && !["active", "reserved", "sold"].includes(l.status)) throw new ListingRejected("not_found", 404);
    if (!isOwner && !isStaff && l.status === "active") {
      await this.db.update(listings).set({ views: sql`${listings.views} + 1` }).where(eq(listings.id, id));
      if (viewer) await this.d.repo.event(viewer.id, "listing_viewed", { listingId: id });
    }
    return this.dto(id, viewer?.id ?? null, { withSeller: true });
  }

  /** Deep link into the Mini App for "share to chat / story"; only for listings buyers can open. */
  async shareLink(id: string): Promise<{ url: string | null }> {
    const [l] = await this.db.select({ status: listings.status }).from(listings).where(eq(listings.id, id));
    if (!l || !["active", "reserved"].includes(l.status)) throw new ListingRejected("not_found", 404);
    const url = this.d.publisher ? await this.d.publisher.miniAppLink(`listing_${id}`).catch(() => null) : null;
    return { url };
  }

  async deleteDraft(user: User, id: string) {
    const l = await this.own(user, id);
    if (l.status !== "draft") throw new ListingRejected("bad_state", 409);
    await this.deleteListing(id);
  }

  // ---------- helpers ----------
  /** Each AI analysis / generation costs money: a per-seller daily quota (setting `listing_ai_per_day`). */
  private async reserveAi(user: User) {
    const limit = await this.d.repo.getSetting("listing_ai_per_day", LISTING_AI_PER_DAY);
    const id = await this.d.repo.reserveDaily(user.id, "quota_listing_ai", limit);
    if (id === null) throw new ListingRejected("ai_quota", 429, { n: limit });
    return id;
  }

  private async withAi<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AiLimitExceededError || err instanceof AiOutputError) throw new ListingRejected("ai_unavailable", 503);
      throw err;
    }
  }

  /** Right to erasure: every file of the user's listings, their evidence uploads and the shop photo. */
  async purgeUserFiles(userId: string) {
    const own = await this.db.select({ id: listings.id }).from(listings).where(eq(listings.sellerUserId, userId));
    const ids = own.map((l) => l.id);
    const photos = ids.length ? await this.db.select().from(listingPhotos).where(inArray(listingPhotos.listingId, ids)) : [];
    await Promise.all(photos.map((p) => this.deletePhotoFiles(p.storageKey)));
    const files = await this.db
      .select({ key: evidence.storageKey })
      .from(evidence)
      .where(ids.length ? or(eq(evidence.uploadedBy, userId), inArray(evidence.listingId, ids)) : eq(evidence.uploadedBy, userId));
    const [shop] = await this.db.select({ key: shops.photoKey }).from(shops).where(eq(shops.ownerUserId, userId));
    await Promise.all(
      [...files.map((f) => f.key), ...(shop?.key ? [shop.key] : [])].map((k) => this.d.storage.delete(k).catch(() => undefined)),
    );
  }

  private async deleteListing(id: string) {
    const photos = await this.db.select().from(listingPhotos).where(eq(listingPhotos.listingId, id));
    await Promise.all(photos.map((p) => this.deletePhotoFiles(p.storageKey)));
    await this.db.delete(listings).where(eq(listings.id, id));
  }

  private async own(user: User, id: string): Promise<Listing> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ListingRejected("not_found", 404);
    const [l] = await this.db.select().from(listings).where(eq(listings.id, id));
    if (!l) throw new ListingRejected("not_found", 404);
    if (l.sellerUserId !== user.id) throw new ListingRejected("forbidden", 403);
    return l;
  }

  private async shopOf(userId: string) {
    const [s] = await this.db.select().from(shops).where(eq(shops.ownerUserId, userId));
    return s ?? null;
  }

  async sellerRating(sellerId: string) {
    const [r] = await this.db
      .select({ avg: avg(reviews.rating), n: count() })
      .from(reviews)
      .where(eq(reviews.sellerUserId, sellerId));
    return { avg: r?.n ? Math.round(Number(r.avg) * 10) / 10 : null, count: r?.n ?? 0 };
  }


  /**
   * Public facts about sellers (shop, platform sales, rating, reply time, courier inspections), batched:
   * a fixed number of queries for any number of sellers. Listing cards and the seller page use it.
   */
  async sellerInfos(sellers: Array<Pick<User, "id" | "createdAt">>): Promise<Map<string, ListingSeller>> {
    const sellerIds = sellers.map((u) => u.id);
    if (!sellerIds.length) return new Map();
    const [shopRows, sales, ratings, responseOf, insp, lost, fans] = await Promise.all([
      this.db.select().from(shops).where(inArray(shops.ownerUserId, sellerIds)),
      // Platform sales = orders actually delivered by an Ishonch courier. The seller's own "sold on Ishonch"
      // mark is not counted: anyone could set it and get the "high trust" badge without a single sale.
      this.db
        .select({ seller: orders.sellerUserId, n: count() })
        .from(orders)
        .where(and(inArray(orders.sellerUserId, sellerIds), eq(orders.status, "delivered")))
        .groupBy(orders.sellerUserId),
      this.db
        .select({ seller: reviews.sellerUserId, avg: avg(reviews.rating), n: count() })
        .from(reviews)
        .where(inArray(reviews.sellerUserId, sellerIds))
        .groupBy(reviews.sellerUserId),
      this.responseMinutes(sellerIds),
      this.db
        .select({
          seller: orders.sellerUserId,
          passed: sql<number>`count(*) filter (where (${orders.inspection}->>'passed')::boolean)::int`,
          failed: sql<number>`count(*) filter (where not (${orders.inspection}->>'passed')::boolean)::int`,
        })
        .from(orders)
        .where(and(inArray(orders.sellerUserId, sellerIds), sql`${orders.inspection} is not null`))
        .groupBy(orders.sellerUserId),
      this.db
        .select({ seller: disputes.sellerUserId, n: count() })
        .from(disputes)
        .where(and(inArray(disputes.sellerUserId, sellerIds), inArray(disputes.resolution, ["refund", "partial"])))
        .groupBy(disputes.sellerUserId),
      this.db
        .select({ seller: follows.sellerUserId, n: count() })
        .from(follows)
        .where(inArray(follows.sellerUserId, sellerIds))
        .groupBy(follows.sellerUserId),
    ]);
    const fansOf = new Map(fans.map((r) => [r.seller, Number(r.n)]));
    const lostOf = new Map(lost.map((r) => [r.seller, Number(r.n)]));
    const shopOf = new Map(shopRows.map((sh) => [sh.ownerUserId, sh]));
    const salesOf = new Map(sales.map((r) => [r.seller, Number(r.n)]));
    const ratingOf = new Map(ratings.map((r) => [r.seller, { avg: Math.round(Number(r.avg) * 10) / 10, count: Number(r.n) }]));
    const inspOf = new Map(insp.map((r) => [r.seller, { passed: r.passed, failed: r.failed }]));
    return new Map(
      sellers.map((u) => {
        const shop = shopOf.get(u.id);
        return [
          u.id,
          {
            id: u.id,
            registeredAt: u.createdAt.toISOString(),
            platformSales: salesOf.get(u.id) ?? 0,
            rating: ratingOf.get(u.id) ?? { avg: null, count: 0 },
            shop: shop
              ? {
                  id: shop.id,
                  name: shop.name,
                  verified: shop.verified,
                  marketLocation: shop.marketLocation,
                  bundleDiscount: shop.bundle2Pct || shop.bundle3Pct ? { two: shop.bundle2Pct, three: shop.bundle3Pct } : null,
                }
              : null,
            followers: fansOf.get(u.id) ?? 0,
            responseMinutes: responseOf.get(u.id) ?? null,
            inspections: inspOf.get(u.id) ?? { passed: 0, failed: 0 },
            disputesLost: lostOf.get(u.id) ?? 0,
            badges: sellerBadges({
              responseMinutes: responseOf.get(u.id) ?? null,
              inspections: inspOf.get(u.id) ?? { passed: 0, failed: 0 },
              platformSales: salesOf.get(u.id) ?? 0,
              disputesLost: lostOf.get(u.id) ?? 0,
            }),
          },
        ];
      }),
    );
  }

  /** The seller's public card (seller page), or null for an unknown or banned user. */
  async sellerProfile(sellerId: string): Promise<ListingSeller | null> {
    const [u] = await this.db.select().from(users).where(eq(users.id, sellerId));
    if (!u || u.bannedAt) return null;
    return (await this.sellerInfos([u])).get(u.id) ?? null;
  }

  /**
   * Typical reply time (Avito shows "отвечает в течение часа"): median minutes from the buyer's first message
   * to the seller's first answer, over chats of the last 60 days; null with fewer than 3 answered chats.
   */
  private responseCache = new Map<string, { minutes: number | null; at: number }>();

  private async responseMinutes(sellerIds: string[]): Promise<Map<string, number>> {
    // Cached per seller for 10 minutes: every listing view and catalog page needs it, the value moves slowly.
    const now = Date.now();
    const out = new Map<string, number>();
    const missing: string[] = [];
    for (const id of sellerIds) {
      const c = this.responseCache.get(id);
      if (c && now - c.at < 10 * 60_000) {
        if (c.minutes != null) out.set(id, c.minutes);
      } else missing.push(id);
    }
    if (!missing.length) return out;
    const fresh = await this.queryResponseMinutes(missing);
    if (this.responseCache.size > 5000) this.responseCache.clear();
    for (const id of missing) {
      const m = fresh.get(id) ?? null;
      this.responseCache.set(id, { minutes: m, at: now });
      if (m != null) out.set(id, m);
    }
    return out;
  }

  /** A seller answered a chat: their typical reply time may have changed. */
  forgetResponseTime(sellerId: string) {
    this.responseCache.delete(sellerId);
  }

  private async queryResponseMinutes(sellerIds: string[]): Promise<Map<string, number>> {
    const rows = (await this.db.execute(sql`
      select c.seller_user_id as seller,
             percentile_cont(0.5) within group (order by extract(epoch from (r.at - b.at)) / 60) as minutes
      from ${conversations} c
      cross join lateral (select min(m.created_at) as at from conversation_messages m
                          where m.conversation_id = c.id and m.sender_user_id = c.buyer_user_id) b
      cross join lateral (select min(m.created_at) as at from conversation_messages m
                          where m.conversation_id = c.id and m.sender_user_id = c.seller_user_id and m.created_at > b.at) r
      where c.seller_user_id in ${sellerIds} and c.created_at > now() - interval '60 days' and r.at is not null
      group by c.seller_user_id
      having count(*) >= 3`)) as unknown as Array<{ seller: string; minutes: number | string }>;
    return new Map(rows.map((r) => [r.seller, Math.max(1, Math.round(Number(r.minutes)))]));
  }

  async dto(id: string, viewerId: string | null, opts: { withSeller?: boolean } = {}): Promise<ListingDto> {
    const [dto] = await this.dtos([id], viewerId, opts);
    if (!dto) throw new ListingRejected("not_found", 404);
    return dto;
  }

  /**
   * Batched DTOs: a fixed number of queries for any number of listings (listings, photos, and with
   * `withSeller` users, shops, platform sales and ratings), in the order of `ids`; missing ids are skipped.
   */
  async dtos(ids: string[], viewerId: string | null, opts: { withSeller?: boolean } = {}): Promise<ListingDto[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.select().from(listings).where(inArray(listings.id, ids));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const photos = await this.db
      .select()
      .from(listingPhotos)
      .where(inArray(listingPhotos.listingId, ids))
      .orderBy(asc(listingPhotos.position), asc(listingPhotos.id));
    const photosOf = new Map<string, typeof photos>();
    for (const p of photos) photosOf.set(p.listingId, [...(photosOf.get(p.listingId) ?? []), p]);
    const videoOf = this.d.evidence ? await this.d.evidence.listingVideos(ids) : new Map<string, string>();

    const sellerIds = [...new Set(rows.map((r) => r.sellerUserId))];
    const needSellers = opts.withSeller || rows.some((r) => r.sellerUserId === viewerId && r.moderationReason);
    const sellers = needSellers && sellerIds.length ? await this.db.select().from(users).where(inArray(users.id, sellerIds)) : [];
    const sellerOf = new Map(sellers.map((u) => [u.id, u]));
    const sellerInfo = opts.withSeller && sellerIds.length ? await this.sellerInfos(sellers) : new Map<string, ListingSeller>();

    const out: ListingDto[] = [];
    for (const id of ids) {
      const l = byId.get(id);
      if (!l) continue;
      const draft = l.aiDraft as AiDraft;
      const isOwner = viewerId === l.sellerUserId;
      const attrs = l.attributes as ListingDto["attributes"];
      const dto: ListingDto = {
        id: l.id,
        status: l.status as ListingStatus,
        category: l.category as ListingDto["category"],
        titleRu: l.titleRu,
        titleUz: l.titleUz,
        descriptionRu: l.descriptionRu,
        descriptionUz: l.descriptionUz,
        attributes: { brand: attrs.brand ?? null, model: attrs.model ?? null, modelKey: attrs.modelKey ?? null, specs: attrs.specs ?? [] },
        condition: (l.condition as Condition | null) ?? null,
        price: l.price,
        previousPrice:
          l.previousPrice != null &&
          l.price != null &&
          l.previousPrice > l.price &&
          l.priceDroppedAt &&
          Date.now() - l.priceDroppedAt.getTime() < PRICE_DROP_BADGE_DAYS * DAY
            ? l.previousPrice
            : null,
        currency: "UZS",
        ...(isOwner ? { imei: l.imei } : {}),
        imeiTail: l.imei ? l.imei.slice(-4) : null,
        checklist: (l.checklist as ConditionChecklist) ?? {},
        acceptsTrade: l.acceptsTrade,
        grade: (l.grade as Grade | null) ?? null,
        video: videoOf.get(l.id) ?? null,
        ...(isOwner
          ? {
              autoDrop: l.autoDropFloor && l.autoDropAt ? { floor: l.autoDropFloor, nextAt: l.autoDropAt.toISOString() } : null,
              likersOffer: l.likersOfferPrice && l.likersOfferAt ? { price: l.likersOfferPrice, at: l.likersOfferAt.toISOString() } : null,
              shopsOfferAt: l.shopsOfferAt?.toISOString() ?? null,
            }
          : {}),
        verified:
          l.verifiedAt && Date.now() - l.verifiedAt.getTime() < VERIFIED_BADGE_DAYS * DAY ? ((l.verification as Inspection | null) ?? null) : null,
        district: (l.district as District | null) ?? null,
        // Modes switched off by the feature flag are never offered to buyers.
        allowedDeliveryModes: (l.allowedDeliveryModes as DeliveryMode[]).filter(
          (m) => this.d.codPlatformEnabled || MVP_DELIVERY_MODES.includes(m),
        ),
        feePayer: l.feePayer as FeePayer,
        photos: (photosOf.get(l.id) ?? []).map((p) => ({ id: p.id, url: this.photoUrl(p.id, p.storageKey), position: p.position })),
        priceSuggestion: isOwner ? ((l.priceSuggestion as PriceSuggestion | null) ?? null) : null,
        questions: isOwner ? (draft.analysis?.questions ?? []) : [],
        photoHints: isOwner ? (draft.analysis?.photo_hints ?? []) : [],
        stats: isOwner ? { views: l.views, favorites: l.favoritesCount, requests: l.requestsCount } : { views: 0, favorites: 0, requests: 0 },
        createdAt: l.createdAt.toISOString(),
        publishedAt: l.publishedAt?.toISOString() ?? null,
        bumpedAt: l.bumpedAt?.toISOString() ?? null,
        canBumpAt: l.bumpedAt ? new Date(l.bumpedAt.getTime() + BUMP_INTERVAL_DAYS * DAY).toISOString() : null,
        expiresAt: l.expiresAt?.toISOString() ?? null,
        soldVia: (l.soldVia as ListingDto["soldVia"]) ?? null,
        moderation: null,
      };
      if (isOwner && l.moderationReason) {
        const record = l.moderation as ModerationRecord | null;
        const lang = (sellerOf.get(l.sellerUserId)?.language as Lang | undefined) ?? "ru";
        dto.moderation = { reason: l.moderationReason, message: record?.sellerMessage?.[lang] ?? null };
      }
      if (opts.withSeller) {
        dto.seller = sellerInfo.get(l.sellerUserId) ?? {
          id: l.sellerUserId,
          registeredAt: l.createdAt.toISOString(),
          platformSales: 0,
          rating: { avg: null, count: 0 },
          shop: null,
          responseMinutes: null,
          inspections: { passed: 0, failed: 0 },
          disputesLost: 0,
          followers: 0,
          badges: [],
        };
      }
      out.push(dto);
    }
    return out;
  }

}
