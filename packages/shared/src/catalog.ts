import type { CatalogFilters } from "./schemas.js";
import { CHECK_CATEGORIES } from "./types.js";
import { CONDITIONS, TASHKENT_DISTRICTS, type ListingDto } from "./listing.js";
import type { PriceVerdict } from "./types.js";

export const CATALOG_SORTS = ["relevance", "newest", "price_asc", "price_desc"] as const;
export type CatalogSort = (typeof CATALOG_SORTS)[number];


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

