import type { RiskRules } from "../schemas.js";
import defaultRulesJson from "./defaultRules.json" with { type: "json" };
import type { RiskFlag, RiskLevel, RiskResult } from "../types.js";


/** Validated against RiskRulesSchema in tests and when the API loads overrides from `settings`. */
export const DEFAULT_RISK_RULES: RiskRules = defaultRulesJson as RiskRules;

/** Facts known about a listing/seller; every field optional so module B and A can share it. */
export interface RiskSignals {
  /** signed % vs market median, negative = cheaper */
  priceDiffPct?: number | null;
  prepayment?: boolean;
  otherCity?: boolean;
  shippingOnly?: boolean;
  stockOrDuplicatePhotos?: boolean;
  accountAgeDays?: number | null;
  urgency?: boolean;
  verifiedShop?: boolean;
  goodPlatformSales?: boolean;
  /** AI correction, clamped to ±rules.aiAdjustmentMax */
  aiAdjustment?: number;
}

export function riskLevel(score: number, rules: RiskRules = DEFAULT_RISK_RULES): RiskLevel {
  if (score >= rules.levels.high) return "high";
  if (score >= rules.levels.medium) return "medium";
  return "low";
}

/** Rule-based score (section 7 of the spec) plus a bounded AI adjustment, clamped to 0..100. */
export function scoreRisk(signals: RiskSignals, rules: RiskRules = DEFAULT_RISK_RULES): RiskResult {
  const flags: RiskFlag[] = [];
  const add = (id: string, on: boolean | undefined) => {
    const weight = rules.weights[id];
    if (on && weight !== undefined && weight !== 0) flags.push({ id, weight });
  };

  add(
    "price_below_market",
    signals.priceDiffPct != null && signals.priceDiffPct <= -rules.priceBelowMarketPct,
  );
  add("prepayment", signals.prepayment);
  add("other_city_or_shipping", signals.otherCity || signals.shippingOnly);
  add("stock_or_duplicate_photos", signals.stockOrDuplicatePhotos);
  add(
    "new_account",
    signals.accountAgeDays != null && signals.accountAgeDays < rules.newAccountDays,
  );
  add("urgency", signals.urgency);
  add("verified_shop", signals.verifiedShop);
  add("good_platform_sales", signals.goodPlatformSales);

  const max = rules.aiAdjustmentMax;
  const aiAdjustment = Math.round(Math.max(-max, Math.min(max, signals.aiAdjustment ?? 0)));
  const ruleScore = flags.reduce((sum, f) => sum + f.weight, 0);
  let score = Math.max(0, Math.min(100, ruleScore + aiAdjustment));
  // The AI may raise the level but never talk hard evidence down to a lower level.
  const ruleLevel = riskLevel(ruleScore, rules);
  const floor = ruleLevel === "high" ? rules.levels.high : ruleLevel === "medium" ? rules.levels.medium : 0;
  score = Math.max(score, floor);
  return { score, level: riskLevel(score, rules), flags, aiAdjustment };
}

