import { z } from "zod";
import { CHECK_CATEGORIES, type CheckCategory, type Lang } from "./types.js";
import { formatUzs } from "./price/parsePrice.js";
import { t } from "./i18n.js";
import type { MarketRange } from "./price/verdict.js";

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

/** Step 1: what the AI can see in the photos / hear in the voice note. */
export const ListingAnalysisSchema = z.object({
  category: z.enum(CHECK_CATEGORIES),
  brand: z.string().nullable(),
  model: z.string().nullable(),
  model_key: z.string().nullable().describe("lowercase 'brand model storage', e.g. 'apple iphone 13 128gb'"),
  specs: z
    .array(z.object({ name: z.string(), value: z.string() }))
    .describe("only characteristics that are visible or stated; never guessed"),
  condition: z.enum([...CONDITIONS, "unknown"]),
  visible_defects: z.array(z.string()).describe("scratches, cracks, dents actually visible in photos"),
  questions: z
    .array(
      z.object({
        key: z.string().describe("snake_case id, e.g. storage, battery_health, kit, warranty"),
        question_ru: z.string(),
        question_uz: z.string(),
        options: z.array(z.string()).describe("2-5 short answer options, may be empty for free text"),
      }),
    )
    .describe("1-3 questions about important missing facts; empty if nothing important is missing"),
  photo_hints: z
    .array(z.object({ ru: z.string(), uz: z.string() }))
    .describe("advice to improve photos, e.g. 'add a photo of the screen turned on'"),
  ai_market_estimate_uzs: z.object({ min: z.number(), max: z.number() }).nullable(),
});
export type ListingAnalysis = z.infer<typeof ListingAnalysisSchema>;

/** Step 2: the selling text in both languages. */
export const ListingTextSchema = z.object({
  title_ru: z.string(),
  title_uz: z.string(),
  description_ru: z.string(),
  description_uz: z.string(),
});
export type ListingText = z.infer<typeof ListingTextSchema>;

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
  shop: { id: string; name: string; verified: boolean; marketLocation: string | null } | null;
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
  currency: "UZS";
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
