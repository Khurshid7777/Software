// «Паспорт товара»: how far an item can be trusted on its own, apart from the seller's reviews (docs/plan.md §2).
// Condition grade (Back Market style), checks that name who confirmed them (Swappa style) and the item's
// history on Ishonch by IMEI (Autoteka style).
import type { Condition } from "./listing.js";
import type { ConditionChecklist } from "./market.js";

export const GRADES = ["A", "B", "C", "D"] as const;
export type Grade = (typeof GRADES)[number];
/** Catalog filter «Класс A–B». */
export const GOOD_GRADES: Grade[] = ["A", "B"];

/** Why the grade is lower than the declared condition alone would give. */
export const GRADE_REASONS = ["battery_low", "battery_worn", "repaired", "dead_pixels", "dead_pixels_many", "biometrics_broken", "mining"] as const;
export type GradeReason = (typeof GRADE_REASONS)[number];

const RANK: Record<Grade, number> = { A: 0, B: 1, C: 2, D: 3 };
const worse = (a: Grade, b: Grade): Grade => (RANK[a] >= RANK[b] ? a : b);

/**
 * Condition sets the best possible grade; facts from the checklist only lower it (the worst fact wins).
 * Must stay identical to the `listings.grade` generated column (apps/api/src/db/schema.ts) — a test compares them.
 */
export function computeGrade(condition: Condition | null, c: ConditionChecklist): { grade: Grade | null; reasons: GradeReason[] } {
  if (!condition) return { grade: null, reasons: [] };
  if (condition === "broken") return { grade: "D", reasons: [] };
  let grade: Grade = condition === "fair" ? "C" : condition === "good" ? "B" : "A";
  const reasons: GradeReason[] = [];
  const cap = (g: Grade, why: GradeReason) => {
    if (RANK[g] > RANK[grade]) reasons.push(why);
    grade = worse(grade, g);
  };
  if (c.batteryPct != null && c.batteryPct < 80) cap("C", "battery_low");
  else if (c.batteryPct != null && c.batteryPct < 85) cap("B", "battery_worn");
  if (c.biometrics === "broken") cap("C", "biometrics_broken");
  if (c.deadPixels === "many") cap("C", "dead_pixels_many");
  else if (c.deadPixels === "few") cap("B", "dead_pixels");
  if (c.repairs?.some((r) => r !== "none")) cap("B", "repaired");
  if (c.mining === "yes") cap("B", "mining");
  return { grade, reasons };
}

/** Who confirmed a check: the courier at pickup, Ishonch itself (data, moderation) or the seller's word. */
export type CheckSource = "courier" | "ishonch" | "seller";
export type CheckStatus = "ok" | "warn" | "fail" | "unknown";
export const PASSPORT_CHECKS = ["inspection", "video", "imei", "account", "battery", "repairs", "photos", "price", "documents"] as const;
export type PassportCheckCode = (typeof PASSPORT_CHECKS)[number];

export interface PassportCheck {
  code: PassportCheckCode;
  status: CheckStatus;
  source: CheckSource;
  params?: Record<string, string | number>;
}

export interface ItemHistory {
  /** Earlier listings of the same device (by IMEI) on Ishonch, any seller; no names or links. */
  listings: number;
  sold: number;
  /** Earlier asking prices, newest first (at most 5). */
  prices: Array<{ at: string; price: number }>;
  inspections: { passed: number; failed: number };
}

export interface ItemPassport {
  grade: Grade | null;
  reasons: GradeReason[];
  checks: PassportCheck[];
  /** "Пройдено N из M": ok checks / all applicable checks. */
  passed: number;
  total: number;
  history: ItemHistory | null;
  /** The courier's photos from the last passed inspection (signed URLs). */
  inspectionPhotos: string[];
}

/** Categories whose items sign in to an account (iCloud / Google / Microsoft / Samsung): the "unlinked" check. */
export const ACCOUNT_CATEGORIES = ["smartphone", "tablet", "smartwatch", "laptop"] as const;
