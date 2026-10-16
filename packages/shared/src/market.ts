import type { CheckCategory } from "./types.js";

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

export interface OfferDto {
  id: string;
  listingId: string;
  amount: number;
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
}
export type ChecklistField = keyof ConditionChecklist;

/** Which checklist fields the seller fills for a category; a category that is not listed has no checklist. */
export const CHECKLIST_FIELDS: Partial<Record<CheckCategory, readonly ChecklistField[]>> = {
  smartphone: ["batteryPct", "biometrics", "repairs", "kit"],
  tablet: ["batteryPct", "biometrics", "repairs", "kit"],
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
export function kitItems(category: string): ReadonlyArray<(typeof KIT_ITEMS)[number]> {
  return (IMEI_CATEGORIES as readonly string[]).includes(category) ? KIT_ITEMS : ["box", "receipt", "warranty"];
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
