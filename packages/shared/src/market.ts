import type { CheckCategory } from "./types.js";
import type { Condition, PriceSuggestion } from "./listing.js";
import type { MarketRange } from "./price/verdict.js";

// Marketplace features borrowed from Avito / Vinted / Mercari / Carousell / Swappa (see docs/competitive-analysis.md):
// price offers, price-drop alerts for favorites, IMEI for phones.

// ---------- price offers ("торг") ----------
export const OFFER_STATUSES = ["pending", "accepted", "declined", "expired"] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

/** An offer below this share of the asking price is rejected outright (lowballing spams sellers). */
export const OFFER_MIN_PCT = 50;
/** The seller has this long to answer before the offer expires. */
export const OFFER_PENDING_HOURS = 24;
/** An accepted price holds this long for the buyer's delivery order. */
export const OFFER_ACCEPTED_HOURS = 48;
/** Offers per buyer per day (each one is a DM to a seller). */
export const OFFERS_PER_DAY = 10;

export const OFFER_KINDS = ["price", "trade"] as const;
export type OfferKind = (typeof OFFER_KINDS)[number];

export interface OfferDto {
  id: string;
  listingId: string;
  kind: OfferKind;
  /** Price offer: the proposed price. Trade: the top-up (> 0 the buyer adds money, < 0 the seller does). */
  amount: number;
  /** Trade offers: what the buyer gives in exchange. */
  trade: TradeItem | null;
  listPrice: number;
  status: OfferStatus;
  createdAt: string;
  decidedAt: string | null;
  expiresAt: string;
}

/** Lowest acceptable offer for an asking price, rounded up to 1 000 sum. */
export function minOffer(price: number) {
  return Math.ceil((price * OFFER_MIN_PCT) / 100 / 1000) * 1000;
}

// ---------- price drops ----------
/** Favorites are alerted only about a real reduction, not a 1 000 sum nudge. */
export const PRICE_DROP_MIN_PCT = 3;
/** The old price stays visible (crossed out) for this many days after a reduction. */
export const PRICE_DROP_BADGE_DAYS = 14;

// ---------- IMEI ----------
/** 15 digits with a valid Luhn check digit (the format printed by *#06#). */
export function isValidImei(raw: string): boolean {
  const s = raw.replace(/[\s-]/g, "");
  if (!/^\d{15}$/.test(s) || /^(\d)\1+$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let d = Number(s[i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export function normalizeImei(raw: string) {
  return raw.replace(/[\s-]/g, "");
}

/** Categories where the IMEI field is offered. */
export const IMEI_CATEGORIES = ["smartphone", "tablet"] as const;

// ---------- condition checklist ----------
export const BIOMETRICS_STATES = ["ok", "broken", "none"] as const;
export const REPAIR_KINDS = ["none", "screen", "battery", "back", "other"] as const;
export const KIT_ITEMS = ["box", "charger", "receipt", "warranty"] as const;
/** PC parts (video cards first): was it used for mining. */
export const MINING_STATES = ["never", "yes", "unknown"] as const;
/** Monitors: dead / stuck pixels. */
export const PIXEL_STATES = ["none", "few", "many"] as const;

/** Structured condition instead of free text (Back Market / Swappa style); every field is optional. */
export interface ConditionChecklist {
  /** Battery health from Settings → Battery, %. */
  batteryPct?: number;
  biometrics?: (typeof BIOMETRICS_STATES)[number];
  repairs?: Array<(typeof REPAIR_KINDS)[number]>;
  kit?: Array<(typeof KIT_ITEMS)[number]>;
  mining?: (typeof MINING_STATES)[number];
  deadPixels?: (typeof PIXEL_STATES)[number];
  /** How long the item has been in use, years (0 = less than a year). */
  ageYears?: number;
  /** Signed out of iCloud / Google / the maker's account, reset (the seller's word; the courier checks). */
  accountUnlocked?: boolean;
}
export type ChecklistField = keyof ConditionChecklist;

/** Which checklist fields the seller fills for a category; a category that is not listed has no checklist. */
export const CHECKLIST_FIELDS: Partial<Record<CheckCategory, readonly ChecklistField[]>> = {
  smartphone: ["accountUnlocked", "batteryPct", "biometrics", "repairs", "kit"],
  tablet: ["accountUnlocked", "batteryPct", "biometrics", "repairs", "kit"],
  laptop: ["accountUnlocked", "ageYears", "repairs", "kit"],
  smartwatch: ["accountUnlocked", "batteryPct", "repairs", "kit"],
  pc_parts: ["mining", "ageYears", "repairs", "kit"],
  monitor: ["deadPixels", "ageYears", "repairs", "kit"],
  home_appliance: ["ageYears", "repairs", "kit"],
  large_appliance: ["ageYears", "repairs", "kit"],
};

export function checklistFields(category: string): readonly ChecklistField[] {
  return CHECKLIST_FIELDS[category as CheckCategory] ?? [];
}

/** Repair kinds and kit items that make sense for a category (screen/battery/charger are phone things). */
export function repairKinds(category: string): ReadonlyArray<(typeof REPAIR_KINDS)[number]> {
  return (IMEI_CATEGORIES as readonly string[]).includes(category) ? REPAIR_KINDS : ["none", "other"];
}
const CHARGER_CATEGORIES = ["smartphone", "tablet", "laptop", "smartwatch", "headphones"];
export function kitItems(category: string): ReadonlyArray<(typeof KIT_ITEMS)[number]> {
  return CHARGER_CATEGORIES.includes(category) ? KIT_ITEMS : ["box", "receipt", "warranty"];
}

/** Nothing the category asks for is filled in yet. */
export function checklistEmpty(category: string, c: ConditionChecklist): boolean {
  return checklistFields(category).every((f) => {
    const v = c[f];
    return v == null || (Array.isArray(v) && v.length === 0);
  });
}

// ---------- «Проверено Ishonch»: courier's inspection at pickup ----------
export const INSPECTION_CHECKS = [
  "matches_description",
  "screen",
  "camera",
  "biometrics",
  "imei_match",
  "battery",
  "powers_on",
  "load_test",
  "dead_pixels",
  "noise",
  "no_leaks",
] as const;
export type InspectionCheck = (typeof INSPECTION_CHECKS)[number];

const DEVICE_CHECKS: InspectionCheck[] = ["matches_description", "screen", "camera", "biometrics", "imei_match", "battery"];
const CATEGORY_CHECKS: Partial<Record<CheckCategory, InspectionCheck[]>> = {
  pc_parts: ["matches_description", "powers_on", "load_test", "noise"],
  monitor: ["matches_description", "powers_on", "dead_pixels"],
  home_appliance: ["matches_description", "powers_on", "noise"],
  large_appliance: ["matches_description", "powers_on", "noise", "no_leaks"],
};

/** What the courier checks at pickup for this category (IMEI only when the listing has one). */
export function inspectionChecks(category: string, hasImei: boolean): InspectionCheck[] {
  const list = CATEGORY_CHECKS[category as CheckCategory] ?? DEVICE_CHECKS;
  return list.filter((c) => c !== "imei_match" || hasImei);
}

/** true = passed, false = failed; a check that does not apply is left out. */
export interface Inspection {
  checks: Partial<Record<InspectionCheck, boolean>>;
  passed: boolean;
  note: string | null;
  at: string;
}

/** The badge stays on the listing this long after a passed inspection (the item may come back on sale). */
export const VERIFIED_BADGE_DAYS = 30;

// ---------- reviews ----------
/** One reminder this long after delivery if the buyer has not reviewed yet. */
export const REVIEW_REMINDER_HOURS = 24;
export const REVIEW_REMINDER_MAX_DAYS = 7;

// ---------- bundles ----------
/** Extra items of the same seller in one delivery. */
export const MAX_BUNDLE_EXTRA = 4;

// ---------- seller insights ("почему не продаётся") ----------
export const INSIGHT_TIPS = [
  "price_above_market",
  "favorites_no_requests",
  "low_views",
  "stale",
  "few_photos",
  "short_description",
  "no_checklist",
  "no_account_check",
  "no_imei",
  "no_cod",
] as const;
export type InsightTip = (typeof INSIGHT_TIPS)[number];

export interface ListingInsights {
  stats: {
    daysOnSale: number;
    views: number;
    viewsPerDay: number;
    /** Average views per day of live listings in the same category (null: too few to compare). */
    categoryViewsPerDay: number | null;
    favorites: number;
    requests: number;
  };
  /** Market price for the model (median) and how far the listing is from it, %. */
  market: { median: number; diffPct: number } | null;
  /** Most important first. */
  tips: Array<{ code: InsightTip; severity: "high" | "medium" | "low"; params: Record<string, string | number> }>;
}

/** Public seller page: profile facts + live listings. */
export const SELLER_PAGE_LIMIT = 30;

// ---------- trade-in between people («обмен с доплатой») ----------
/** The buyer's item offered in exchange; `estimate` is our valuation of it (null: unknown model). */
export interface TradeItem {
  title: string;
  condition: Condition;
  description: string | null;
  modelKey: string | null;
  estimate: number | null;
}
/** Top-up limit either way, as a share of the asking price (a 10x top-up is not an exchange). */
export const TRADE_MAX_TOPUP_PCT = 200;

// ---------- valuation («Сколько стоит?») ----------
/** Reference prices are for a used item in good condition; other conditions scale them. */
export const CONDITION_FACTOR: Record<Condition, number> = { new: 1.15, like_new: 1.05, good: 1, fair: 0.85, broken: 0.5 };
export const VALUATION_HISTORY_MONTHS = 6;

export interface Valuation {
  /** The model we priced (the matched reference row, else the normalized query). */
  modelKey: string;
  condition: Condition;
  /** Market range for the condition. */
  range: MarketRange | null;
  source: "reference" | "catalog" | "none";
  /** Quick / market / max price for the condition. */
  estimate: PriceSuggestion | null;
  /** Sold on Ishonch in the last 90 days. */
  sold: { count: number; median: number | null };
  /** Live listings of the model now. */
  live: number;
  /** Median asking price per month (oldest first), months without listings left out. */
  history: Array<{ month: string; median: number; n: number }>;
}

// ---------- Ishonch guarantee: disputes after delivery ----------
/** The buyer can open a dispute this long after delivery (hidden defects show up in use). */
export const GUARANTEE_DAYS = 3;
export const DISPUTE_REASONS = ["not_as_described", "hidden_defect", "not_working", "counterfeit", "incomplete", "other"] as const;
export type DisputeReason = (typeof DISPUTE_REASONS)[number];
/** refund: the item goes back, full refund; partial: compensation of `amount`; rejected: no fault found. */
export const DISPUTE_RESOLUTIONS = ["refund", "partial", "rejected"] as const;
export type DisputeResolution = (typeof DISPUTE_RESOLUTIONS)[number];

export interface DisputeDto {
  id: string;
  orderId: string;
  reason: DisputeReason;
  text: string;
  sellerResponse: string | null;
  status: "open" | "resolved";
  resolution: DisputeResolution | null;
  amount: number | null;
  note: string | null;
  /** The buyer's photos (signed URLs). */
  photos: string[];
  createdAt: string;
  resolvedAt: string | null;
}

// ---------- evidence (stage 15) ----------
export const MAX_DISPUTE_PHOTOS = 3;
export const MAX_INSPECTION_PHOTOS = 4;
/** The seller's video check: a short clip (switching on, screen, camera), one per listing. */
export const MAX_VIDEO_BYTES = 20 * 1024 * 1024;

// ---------- selling faster (stage 16, docs/plan.md) ----------
/** «Предложить избранным» (Poshmark "Offer to Likers"): at least this much below the price, 24 h, every 3 days. */
export const LIKERS_OFFER_MIN_PCT = 10;
export const LIKERS_OFFER_HOURS = 24;
export const LIKERS_OFFER_EVERY_DAYS = 3;
/** Автоснижение (Mercari Smart Pricing): −5 % every 3 days down to the seller's floor (not below half the price). */
export const AUTO_DROP_PCT = 5;
export const AUTO_DROP_EVERY_DAYS = 3;
export const AUTO_DROP_MIN_FLOOR_PCT = 50;

/** The next automatic price: 5 % lower, rounded to 10 000 sum, never below the floor. */
export function nextAutoDropPrice(price: number, floor: number) {
  return Math.max(floor, Math.floor((price * (100 - AUTO_DROP_PCT)) / 100 / 10_000) * 10_000);
}

/** The highest price a likers' offer may have (10 % off, rounded down to 1 000 sum). */
export function maxLikersOffer(price: number) {
  return Math.floor((price * (100 - LIKERS_OFFER_MIN_PCT)) / 100 / 1000) * 1000;
}

/** Seller badges, earned only by facts on Ishonch (eBay Top Rated style); recomputed on every view. */
export const SELLER_BADGES = ["fast_reply", "courier_checked", "reliable"] as const;
export type SellerBadge = (typeof SELLER_BADGES)[number];

export function sellerBadges(s: {
  responseMinutes: number | null;
  inspections: { passed: number; failed: number };
  platformSales: number;
  disputesLost: number;
}): SellerBadge[] {
  const out: SellerBadge[] = [];
  if (s.responseMinutes != null && s.responseMinutes <= 60) out.push("fast_reply");
  if (s.inspections.passed >= 3 && s.inspections.failed === 0) out.push("courier_checked");
  if (s.platformSales >= 5 && s.disputesLost === 0) out.push("reliable");
  return out;
}

// ---------- Stage 17: coming back to buy (docs/plan.md) ----------

/** Quiet hours in Tashkent (UTC+5): optional notifications wait until the morning. */
export const QUIET_FROM_HOUR = 22;
export const QUIET_TO_HOUR = 8;
const TASHKENT_OFFSET_MS = 5 * 3600_000;

/** When `now` falls in the quiet hours, the moment they end (next 08:00 Tashkent); otherwise null. */
export function quietUntil(now: Date): Date | null {
  const local = new Date(now.getTime() + TASHKENT_OFFSET_MS);
  const h = local.getUTCHours();
  if (h >= QUIET_TO_HOUR && h < QUIET_FROM_HOUR) return null;
  const morning = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + (h >= QUIET_FROM_HOUR ? 1 : 0), QUIET_TO_HOUR));
  return new Date(morning.getTime() - TASHKENT_OFFSET_MS);
}

/** A shop's discount for buying several of its items in one delivery: % for 2 items and for 3 or more. */
export interface BundleDiscount {
  two: number;
  three: number;
}
export const BUNDLE_DISCOUNT_MAX_PCT = 30;

/** The percentage for `n` items in one delivery (0 when there is no discount). */
export function bundleDiscountPct(d: BundleDiscount | null | undefined, n: number) {
  if (!d || n < 2) return 0;
  return n >= 3 ? Math.max(d.three, d.two) : d.two;
}

/** The discounted item price, rounded down to 1 000 sum. */
export function applyDiscount(price: number, pct: number) {
  return pct > 0 ? Math.floor((price * (100 - pct)) / 100 / 1000) * 1000 : price;
}

/** At most one "new item from a seller you follow" message per seller and Tashkent day. */
export const FOLLOW_ALERTS_PER_DAY = 1;

// ---------- Stage 18: meeting in person (docs/plan.md) ----------

/**
 * Busy public places with security and cameras where buyers and sellers of electronics meet in Tashkent
 * (OfferUp "MeetUp Spots"). A starting list: the main entrance of big malls and the electronics market.
 */
export const MEETING_SPOTS = ["samarqand_darvoza", "mega_planet", "compass", "riviera", "malika"] as const;
export type MeetingSpot = (typeof MEETING_SPOTS)[number];

/** Daytime only (Tashkent time): from 9:00, the last meeting starts at 20:00. */
export const MEETING_FROM_HOUR = 9;
export const MEETING_TO_HOUR = 21;
export const MEETING_MAX_DAYS = 7;
export const MEETING_MIN_LEAD_MINUTES = 60;
export const MEETINGS_PER_DAY = 5;
export const MEETING_REMIND_HOURS = 2;

export const MEETING_STATUSES = ["pending", "accepted", "declined", "cancelled", "bought", "not_bought"] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export interface MeetingDto {
  id: string;
  listingId: string;
  title: string;
  price: number | null;
  category: string;
  role: "buyer" | "seller";
  spot: MeetingSpot | null;
  /** The buyer's own place when no spot from the list was chosen. */
  place: string | null;
  at: string;
  note: string | null;
  status: MeetingStatus;
  actions: Array<"accept" | "decline" | "cancel" | "report" | "confirm_sold">;
}

/** Why a meeting time is not allowed (null — fine). Times are whole hours in Tashkent. */
export function meetingTimeError(at: Date, now: Date): "too_soon" | "too_far" | "night" | null {
  if (at.getTime() < now.getTime() + MEETING_MIN_LEAD_MINUTES * 60_000) return "too_soon";
  if (at.getTime() > now.getTime() + MEETING_MAX_DAYS * 864e5) return "too_far";
  const local = new Date(at.getTime() + 5 * 3600_000);
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  if (minutes < MEETING_FROM_HOUR * 60 || minutes > (MEETING_TO_HOUR - 1) * 60) return "night";
  return null;
}

/** Bookable hourly slots for one Tashkent day (`dayOffset` 0 = today), as UTC instants. */
export function meetingSlots(now: Date, dayOffset: number): Date[] {
  const local = new Date(now.getTime() + 5 * 3600_000);
  const out: Date[] = [];
  for (let h = MEETING_FROM_HOUR; h < MEETING_TO_HOUR; h++) {
    const at = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + dayOffset, h) - 5 * 3600_000);
    if (!meetingTimeError(at, now)) out.push(at);
  }
  return out;
}
