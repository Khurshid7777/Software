import type { ListingAnalysis } from "./schemas.js";
import { CHECK_CATEGORIES, type CheckCategory, type Lang } from "./types.js";
import { formatUzs } from "./price/parsePrice.js";
import { t } from "./i18n-core.js";
import type { MarketRange } from "./price/verdict.js";
import type { BundleDiscount, ConditionChecklist, Inspection, SellerBadge } from "./market.js";
import type { Grade } from "./passport.js";

export const CONDITIONS = ["new", "like_new", "good", "fair", "broken"] as const;
export type Condition = (typeof CONDITIONS)[number];

/** reserved = a delivery order was confirmed; pending = waiting for a moderator (AI doubt or complaints). */
export const LISTING_STATUSES = ["draft", "pending", "active", "reserved", "sold", "archived", "rejected"] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

export const DELIVERY_MODES = ["delivery_only", "cod_seller", "cod_platform"] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];
/** cod_platform stays behind a feature flag until a legal entity and courier contract exist. */
export const MVP_DELIVERY_MODES: DeliveryMode[] = ["delivery_only", "cod_seller"];

export const FEE_PAYERS = ["buyer", "seller", "split"] as const;
export type FeePayer = (typeof FEE_PAYERS)[number];

export const TASHKENT_DISTRICTS = [
  "bektemir",
  "chilonzor",
  "mirobod",
  "mirzo_ulugbek",
  "olmazor",
  "sergeli",
  "shayxontohur",
  "uchtepa",
  "yakkasaroy",
  "yangihayot",
  "yashnobod",
  "yunusobod",
] as const;
export type District = (typeof TASHKENT_DISTRICTS)[number];

export const PRIVATE_SELLER_ACTIVE_LIMIT = 10;
export const BUMP_INTERVAL_DAYS = 3;
export const LISTING_TTL_DAYS = 30;



export interface PriceSuggestion {
  quick: number;
  market: number;
  max: number;
  source: "reference" | "catalog" | "ai" | "none";
  approximate: boolean;
}

/** Quick sale = 10% under the median but not below the market minimum. */
export function suggestPrice(range: MarketRange | null, source: PriceSuggestion["source"]): PriceSuggestion | null {
  if (!range) return null;
  const round = (n: number) => Math.round(n / 10_000) * 10_000;
  return {
    quick: round(Math.max(range.min, range.median * 0.9)),
    market: round(range.median),
    max: round(range.max),
    source,
    approximate: source === "ai",
  };
}

export interface ListingPhoto {
  id: number;
  url: string;
  position: number;
}

export interface ListingSeller {
  id: string;
  registeredAt: string;
  platformSales: number;
  rating: { avg: number | null; count: number };
  shop: { id: string; name: string; verified: boolean; marketLocation: string | null; bundleDiscount: BundleDiscount | null } | null;
  /** Followers on Ishonch (stage 17). */
  followers: number;
  /** «В отъезде» (stage 28): back on this date; no orders, meetings or offers until then. */
  awayUntil: string | null;
  /** Median minutes to the first reply in chats (last 60 days, at least 3 chats), else null. */
  responseMinutes: number | null;
  /** Courier inspections of this seller's items: passed / failed. */
  inspections: { passed: number; failed: number };
  /** Guarantee disputes decided against the seller. */
  disputesLost: number;
  /** Earned by facts on Ishonch (see sellerBadges). */
  badges: SellerBadge[];
}

/** Listing as returned by the API. */
export interface ListingDto {
  id: string;
  status: ListingStatus;
  category: CheckCategory;
  titleRu: string;
  titleUz: string;
  descriptionRu: string;
  descriptionUz: string;
  attributes: { brand: string | null; model: string | null; modelKey: string | null; specs: { name: string; value: string }[] };
  condition: Condition | null;
  price: number | null;
  /** Price before a recent reduction (shown crossed out), else null. */
  previousPrice: number | null;
  currency: "UZS";
  /** Phones: the full IMEI for the owner only. */
  imei?: string | null;
  /** Last 4 IMEI digits for buyers to compare with *#06# at handover; null when not given. */
  imeiTail: string | null;
  /** Phones/tablets: structured condition. */
  checklist: ConditionChecklist;
  /** "Рассмотрю обмен": buyers may offer their item plus a top-up. */
  acceptsTrade: boolean;
  /** Condition grade A–D from the condition and the checklist (see computeGrade); null without a condition. */
  grade: Grade | null;
  /** The seller's short video check of the item (signed URL), if any. */
  video: string | null;
  /** Owner only: automatic price drop down to `floor`, next step at `nextAt`. */
  autoDrop?: { floor: number; nextAt: string } | null;
  /** Owner only: the last «Предложить избранным» (price and when). */
  likersOffer?: { price: number; at: string } | null;
  /** Owner only: when the listing was last sent to verified shops (stage 23). */
  shopsOfferAt?: string | null;
  /** «Проверено Ishonch»: a recent passed courier inspection, else null. */
  verified: Inspection | null;
  district: District | null;
  allowedDeliveryModes: DeliveryMode[];
  feePayer: FeePayer;
  photos: ListingPhoto[];
  priceSuggestion: PriceSuggestion | null;
  questions: ListingAnalysis["questions"];
  photoHints: ListingAnalysis["photo_hints"];
  stats: { views: number; favorites: number; requests: number };
  createdAt: string;
  publishedAt: string | null;
  bumpedAt: string | null;
  canBumpAt: string | null;
  expiresAt: string | null;
  soldVia: "platform" | "elsewhere" | null;
  /** Owner only: why the listing is pending / rejected / archived by the system. */
  moderation: { reason: string | null; message: string | null } | null;
  seller?: ListingSeller;
}

export function listingTitle(l: Pick<ListingDto, "titleRu" | "titleUz">, lang: Lang) {
  return (lang === "ru" ? l.titleRu : l.titleUz) || l.titleRu || l.titleUz;
}

export function listingDescription(l: Pick<ListingDto, "descriptionRu" | "descriptionUz">, lang: Lang) {
  return (lang === "ru" ? l.descriptionRu : l.descriptionUz) || l.descriptionRu || l.descriptionUz;
}

/** Ready-to-paste text for OLX / Instagram (no links, so other platforms do not reject it). */
export function listingPlainText(l: ListingDto, lang: Lang): string {
  const lines = [listingTitle(l, lang), ""];
  if (l.price) lines.push(`💰 ${formatUzs(l.price)}`);
  if (l.condition) lines.push(`${t(lang, "sell.field.condition")}: ${t(lang, `condition.${l.condition}`)}`);
  lines.push("", listingDescription(l, lang));
  lines.push("", `📍 ${lang === "ru" ? "Ташкент" : "Toshkent"}${l.district ? `, ${t(lang, `district.${l.district}`)}` : ""}`);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

