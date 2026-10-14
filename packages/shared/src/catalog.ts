import { z } from "zod";
import { CHECK_CATEGORIES } from "./types.js";
import { CONDITIONS, TASHKENT_DISTRICTS, type ListingDto } from "./listing.js";
import type { PriceVerdict } from "./types.js";

export const CATALOG_SORTS = ["relevance", "newest", "price_asc", "price_desc"] as const;
export type CatalogSort = (typeof CATALOG_SORTS)[number];

/** Filters shared by the catalog, the AI assistant and saved searches. */
export const CatalogFiltersSchema = z.object({
  q: z.string().trim().max(200).optional(),
  category: z.enum(CHECK_CATEGORIES).optional(),
  priceMin: z.coerce.number().int().nonnegative().optional(),
  priceMax: z.coerce.number().int().positive().optional(),
  conditions: z.array(z.enum(CONDITIONS)).optional(),
  district: z.enum(TASHKENT_DISTRICTS).optional(),
  verifiedOnly: z.coerce.boolean().optional(),
});
export type CatalogFilters = z.infer<typeof CatalogFiltersSchema>;

export type TrustLevel = "high" | "medium" | "low";

/** Deterministic seller trust (never decided by the AI). Poor reviews (≥3, average < 3) always mean "low". */
export function sellerTrust(s: {
  verifiedShop: boolean;
  platformSales: number;
  accountAgeDays: number;
  rating?: { avg: number | null; count: number };
}): TrustLevel {
  if (s.rating && s.rating.count >= 3 && s.rating.avg !== null && s.rating.avg < 3) return "low";
  if (s.verifiedShop || s.platformSales >= 3) return "high";
  if (s.platformSales >= 1 || s.accountAgeDays >= 30) return "medium";
  return "low";
}

/** Catalog card: listing + market label + trust. */
export interface CatalogItem {
  listing: ListingDto;
  market: PriceVerdict | null;
  trust: TrustLevel;
  favorite: boolean;
}

export interface CatalogPage {
  items: CatalogItem[];
  nextOffset: number | null;
}

export const CONDITION_RANK: Record<(typeof CONDITIONS)[number], number> = {
  new: 4,
  like_new: 3,
  good: 2,
  fair: 1,
  broken: 0,
};

// ---------- AI buyer assistant ----------

export const AssistantMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(2000),
});
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;

/** Step 1 (economical model): understand the request, ask or search. */
export const AssistantQuerySchema = z.object({
  action: z.enum(["ask", "search", "off_topic"]),
  reply: z.string().describe("short text for the user in their language: the question(s), or what you are searching for"),
  questions: z.array(z.string()).describe("0-2 clarifying questions when action=ask"),
  filters: z.object({
    category: z.enum(CHECK_CATEGORIES).nullable(),
    keywords: z.string().nullable().describe("search words for brand/model/type, e.g. 'macbook' or 'наушники'"),
    price_max_uzs: z.number().nullable(),
    price_min_uzs: z.number().nullable(),
    min_condition: z.enum(CONDITIONS).nullable(),
    district: z.enum(TASHKENT_DISTRICTS).nullable(),
    verified_only: z.boolean(),
  }),
  needs: z.string().describe("one sentence summary of what the buyer needs and why (used to rank options)"),
});
export type AssistantQuery = z.infer<typeof AssistantQuerySchema>;

/** Step 2 (strong model): choose among real candidates only. */
export const AssistantRecommendSchema = z.object({
  summary: z.string(),
  options: z.array(
    z.object({
      listing_id: z.string(),
      pros: z.array(z.string()),
      cons: z.array(z.string()),
      fit: z.string().describe("one sentence: why this option fits (or partly fits) the buyer's needs"),
    }),
  ),
});
export type AssistantRecommend = z.infer<typeof AssistantRecommendSchema>;

export const AssistantCompareSchema = z.object({
  summary: z.string(),
  verdicts: z.array(z.object({ listing_id: z.string(), best_for: z.string() })),
});
export type AssistantCompare = z.infer<typeof AssistantCompareSchema>;

export interface AssistantOption {
  item: CatalogItem;
  pros: string[];
  cons: string[];
  fit: string;
}

export interface AssistantResponse {
  kind: "ask" | "results" | "no_results" | "off_topic";
  reply: string;
  questions: string[];
  options: AssistantOption[];
  /** Filters used for the search — the client can save them as a subscription. */
  filters: CatalogFilters | null;
  remainingToday: number;
}

export interface CompareResponse {
  rows: Array<{ label: string; values: string[] }>;
  items: CatalogItem[];
  summary: string;
  bestFor: Record<string, string>;
}
