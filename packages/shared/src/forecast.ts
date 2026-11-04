// «Что будет с устройством»: a rough picture of how a used device may change over the next years, depending on
// how it is used. It is an ESTIMATE from typical values per category, not a measurement and not a market
// forecast: the screens say so every time. Pure functions, so the numbers are the same on the listing and in
// the comparison, and tests can pin them down.
import type { Condition } from "./listing.js";
import type { ConditionChecklist } from "./market.js";
import type { CheckCategory } from "./types.js";

export const USAGE_LEVELS = ["light", "normal", "heavy"] as const;
export type UsageLevel = (typeof USAGE_LEVELS)[number];
export const FORECAST_YEARS = [1, 2, 3, 5] as const;
export type ForecastYears = (typeof FORECAST_YEARS)[number];

const IDX: Record<UsageLevel, 0 | 1 | 2> = { light: 0, normal: 1, heavy: 2 };

/** Battery capacity lost per year, percentage points, for [light, normal, heavy] use (a charge cycle or two a day is "normal"). */
const BATTERY_LOSS: Partial<Record<CheckCategory, readonly [number, number, number]>> = {
  smartphone: [4, 7, 11],
  tablet: [3, 5, 8],
  smartwatch: [4, 7, 10],
  laptop: [3, 6, 10],
  headphones: [5, 9, 14],
};
/** Below this health the battery is worth replacing (laptops and earbuds are used with less). */
const BATTERY_THRESHOLD: Partial<Record<CheckCategory, number>> = { smartphone: 80, tablet: 80, smartwatch: 80, laptop: 75, headphones: 70 };
/** Past the threshold the loss speeds up. */
const ACCELERATION = 1.5;

/** Service tasks: months between them for [light, normal, heavy] use. The first one is counted from today. */
export const MAINTENANCE = {
  laptop: [
    ["clean_cooling", [48, 36, 24]],
    ["thermal_paste", [60, 48, 36]],
  ],
  console: [
    ["clean_dust", [24, 18, 12]],
    ["thermal_paste", [60, 48, 36]],
  ],
  pc_parts: [
    ["clean_fans", [18, 12, 9]],
    ["thermal_paste", [60, 48, 36]],
  ],
  smartphone: [["clean_ports", [18, 12, 9]]],
  headphones: [["pads_replace", [30, 24, 18]]],
  tv: [["dust_vents", [36, 24, 18]]],
  camera: [["sensor_clean", [24, 12, 6]]],
  home_appliance: [
    ["descale", [9, 6, 3]],
    ["filters_clean", [8, 6, 4]],
  ],
  large_appliance: [
    ["seals_hoses", [24, 18, 12]],
    ["descale_clean", [12, 9, 6]],
  ],
} as const satisfies Partial<Record<CheckCategory, ReadonlyArray<readonly [string, readonly [number, number, number]]>>>;
export type MaintenanceKey = (typeof MAINTENANCE)[keyof typeof MAINTENANCE][number][0];

/** Share of the value lost per year by category (the first years are the steepest; this is an average). */
const DEPRECIATION: Record<CheckCategory, number> = {
  smartphone: 0.27,
  tablet: 0.22,
  laptop: 0.2,
  smartwatch: 0.25,
  headphones: 0.22,
  console: 0.12,
  tv: 0.14,
  camera: 0.1,
  pc_parts: 0.22,
  monitor: 0.12,
  home_appliance: 0.1,
  large_appliance: 0.08,
  other_electronics: 0.15,
  other: 0.15,
};
const USAGE_PRICE_ADJ: Record<UsageLevel, number> = { light: -0.03, normal: 0, heavy: 0.04 };
/** A device never drops below this share of today's price (parts, scrap). */
const PRICE_FLOOR = 0.08;
const CONDITION_HEALTH: Record<Condition, number> = { new: 100, like_new: 95, good: 88, fair: 78, broken: 60 };

export interface ForecastInput {
  category: CheckCategory;
  condition: Condition | null;
  price: number | null;
  checklist: ConditionChecklist;
}

export interface BatteryForecast {
  /** Health at year 0..horizon, percent of the original capacity. */
  series: number[];
  /** The starting value: from the checklist, or guessed from the age / condition (`estimated`). */
  start: number;
  estimated: boolean;
  /** Months until it falls to the replacement threshold; 0 = already time. */
  replaceInMonths: number;
  threshold: number;
}

export interface MaintenanceItem {
  key: MaintenanceKey;
  /** First time, months from today. */
  inMonths: number;
  everyMonths: number;
}

export interface PriceForecast {
  /** Year 0..horizon: the middle estimate and a band around it, sum. Year 0 is today's price. */
  series: Array<{ year: number; mid: number; low: number; high: number }>;
}

export interface DeviceForecast {
  usage: UsageLevel;
  years: number;
  battery: BatteryForecast | null;
  maintenance: MaintenanceItem[];
  price: PriceForecast | null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Battery health after `t` years starting from `start`: linear, then faster below the threshold. */
export function batteryAt(start: number, lossPerYear: number, threshold: number, t: number): number {
  if (t <= 0) return start;
  const toThreshold = start > threshold ? (start - threshold) / lossPerYear : 0;
  const health = t <= toThreshold ? start - lossPerYear * t : Math.min(start, threshold) - lossPerYear * ACCELERATION * (t - toThreshold);
  return clamp(round1(health), 0, 100);
}

function batteryForecast(input: ForecastInput, usage: UsageLevel, years: number): BatteryForecast | null {
  const loss = BATTERY_LOSS[input.category]?.[IDX[usage]];
  const threshold = BATTERY_THRESHOLD[input.category];
  if (loss == null || threshold == null) return null;
  const c = input.checklist;
  const normalLoss = BATTERY_LOSS[input.category]![1];
  // The seller's number if there is one; else the age (years of normal use), else what the condition suggests.
  const known = c.batteryPct != null ? clamp(c.batteryPct, 30, 100) : null;
  const byAge = c.ageYears != null ? clamp(100 - normalLoss * Math.max(c.ageYears, 0.5), 40, 100) : null;
  const start = known ?? byAge ?? (input.condition ? CONDITION_HEALTH[input.condition] : 88);
  const series = Array.from({ length: years + 1 }, (_, t) => batteryAt(start, loss, threshold, t));
  return {
    series,
    start,
    estimated: known == null,
    threshold,
    replaceInMonths: start <= threshold ? 0 : Math.round(((start - threshold) / loss) * 12),
  };
}

function priceForecast(input: ForecastInput, usage: UsageLevel, years: number, battery: BatteryForecast | null): PriceForecast | null {
  if (!input.price) return null;
  const d = clamp(DEPRECIATION[input.category] + USAGE_PRICE_ADJ[usage], 0.03, 0.45);
  const series = Array.from({ length: years + 1 }, (_, year) => {
    // A tired battery costs a replacement: up to 8% of the value once it is well under the threshold.
    const tired = battery ? clamp((battery.threshold - battery.series[year]!) / 20, 0, 1) : 0;
    const mid = Math.max(input.price! * PRICE_FLOOR, input.price! * (1 - d) ** year * (1 - 0.08 * tired));
    // The further away, the less sure: the band widens with the horizon.
    const band = year === 0 ? 0 : 0.07 + 0.05 * year;
    const to1000 = (n: number) => Math.round(n / 1000) * 1000;
    return { year, mid: to1000(mid), low: to1000(mid * (1 - band)), high: to1000(Math.min(mid * (1 + band), input.price!)) };
  });
  return { series };
}

/** The estimate for one device: battery, service, price, for a given use and horizon. */
export function forecastDevice(input: ForecastInput, usage: UsageLevel = "normal", years: number = 3): DeviceForecast {
  const y = clamp(Math.round(years), 1, 5);
  const battery = batteryForecast(input, usage, y);
  const tasks = (MAINTENANCE as Partial<Record<CheckCategory, ReadonlyArray<readonly [MaintenanceKey, readonly [number, number, number]]>>>)[input.category] ?? [];
  const age = input.checklist.ageYears;
  const maintenance: MaintenanceItem[] = tasks
    .map(([key, months]) => {
      const every = months[IDX[usage]];
      // An item already a few years old is nearer its first service: count what is left of the interval.
      const used = age != null ? (age * 12) % every : 0;
      return { key, everyMonths: every, inMonths: Math.max(1, Math.round(every - used)) };
    })
    .sort((a, b) => a.inMonths - b.inMonths);
  return { usage, years: y, battery, maintenance, price: priceForecast(input, usage, y, battery) };
}
