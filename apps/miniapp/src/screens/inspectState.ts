import type { CheckCategory } from "@ishonch/shared/client";
import { INSPECTION_MINUTES } from "@ishonch/shared/client";
import { readPref } from "../prefs";

export const TOTAL_MS = INSPECTION_MINUTES * 60_000;

export const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** The inspection that is running now, so the storefront can offer a way back to it (one per device). */
export interface ActiveInspect {
  category: CheckCategory;
  listingId?: string;
  title?: string;
  start: number;
}
export const ACTIVE_KEY = "inspect_active";
export function readActiveInspect(now = Date.now()): ActiveInspect | null {
  try {
    const v = JSON.parse(readPref(ACTIVE_KEY) ?? "null") as ActiveInspect | null;
    return v && typeof v.start === "number" && v.category && now - v.start < TOTAL_MS ? v : null;
  } catch {
    return null;
  }
}
export const inspectLeft = (a: ActiveInspect, now = Date.now()) => clock(TOTAL_MS - (now - a.start));

