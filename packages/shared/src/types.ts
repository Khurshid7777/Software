
export const LANGS = ["uz", "ru"] as const;
export type Lang = (typeof LANGS)[number];

export const ROLES = ["buyer", "seller", "shop", "operator", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const CHECK_CATEGORIES = [
  "smartphone",
  "laptop",
  "tablet",
  "headphones",
  "smartwatch",
  "console",
  "tv",
  "camera",
  "pc_parts",
  "monitor",
  "home_appliance",
  "large_appliance",
  "other_electronics",
  "other",
] as const;
export type CheckCategory = (typeof CHECK_CATEGORIES)[number];

export const CURRENCIES = ["UZS", "USD"] as const;
export type Currency = (typeof CURRENCIES)[number];



export type PriceVerdictKind = "below" | "market" | "above" | "unknown";
export type PriceSource = "reference" | "catalog" | "ai" | "none";

export interface PriceVerdict {
  verdict: PriceVerdictKind;
  /** signed difference vs. market median, percent (negative = cheaper) */
  diffPct: number | null;
  priceUzs: number | null;
  range: { min: number; median: number; max: number } | null;
  source: PriceSource;
  approximate: boolean;
}

export type RiskLevel = "low" | "medium" | "high";

export interface RiskFlag {
  id: string;
  weight: number;
}

export interface RiskResult {
  score: number;
  level: RiskLevel;
  flags: RiskFlag[];
  aiAdjustment: number;
}

/** What the API returns to the bot / Mini App for one check. */
export interface CheckResult {
  id: string;
  lang: Lang;
  createdAt: string;
  title: string;
  category: CheckCategory;
  price: PriceVerdict;
  risk: RiskResult;
  redFlags: string[];
  pros: string[];
  cons: string[];
  questions: string[];
  checklist: string[];
  remainingToday: number | null;
}
