import type { PriceSource, PriceVerdict } from "../types.js";

export interface MarketRange {
  min: number;
  median: number;
  max: number;
}

/** Percent band around the median that still counts as "in the market". */
export const MARKET_BAND_PCT = 15;

export function priceVerdict(
  priceUzs: number | null,
  range: MarketRange | null,
  source: PriceSource,
): PriceVerdict {
  const approximate = source === "ai";
  if (priceUzs == null || priceUzs <= 0 || !range || range.median <= 0) {
    return { verdict: "unknown", diffPct: null, priceUzs, range, source: range ? source : "none", approximate };
  }
  const diffPct = Math.round(((priceUzs - range.median) / range.median) * 100);
  const verdict = diffPct <= -MARKET_BAND_PCT ? "below" : diffPct >= MARKET_BAND_PCT ? "above" : "market";
  return { verdict, diffPct, priceUzs, range, source, approximate };
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Builds a market range from AI min/max (median = midpoint). */
export function rangeFromMinMax(min: number, max: number): MarketRange | null {
  if (!(min > 0) || !(max >= min)) return null;
  return { min, median: Math.round((min + max) / 2), max };
}

const MODEL_NOISE = /\b(black|white|blue|red|green|gold|silver|purple|pink|midnight|starlight|graphite|qora|oq)\b|[(),]/g;

export function normalizeModelKey(key: string): string {
  return key
    .toLowerCase()
    .replace(MODEL_NOISE, " ")
    .replace(/(\d+)\s*(gb|гб|tb|тб)(?![a-zа-я])/g, (_m, n: string, u: string) => `${n}${/^[tт]/.test(u) ? "tb" : "gb"}`)
    .replace(/\s+/g, " ")
    .trim();
}

/** Two model keys describe the same product if all their model numbers and modifiers match. */
export function sameModel(a: string, b: string): boolean {
  const sig = (s: string) => {
    const tokens = normalizeModelKey(s).split(" ");
    const numbers = tokens.filter((x) => /\d/.test(x)).sort();
    const modifiers = tokens.filter((x) => ["pro", "max", "mini", "plus", "ultra", "lite", "fe", "air"].includes(x)).sort();
    return [...numbers, "|", ...modifiers].join(" ");
  };
  return sig(a) === sig(b);
}

const MODEL_WORDS: Record<string, string> = {
  iphone: "iPhone",
  ipad: "iPad",
  macbook: "MacBook",
  airpods: "AirPods",
  imac: "iMac",
  playstation: "PlayStation",
  xbox: "Xbox",
  rtx: "RTX",
  gtx: "GTX",
  rx: "RX",
  lg: "LG",
  btu: "BTU",
};

/** "apple iphone 13 128gb" → "Apple iPhone 13 128 GB": a model key as people write it. */
export function prettyModel(key: string): string {
  return key
    .split(" ")
    .filter(Boolean)
    .map((w) => {
      const size = w.match(/^(\d+)(gb|tb)$/);
      if (size) return `${size[1]} ${size[2]!.toUpperCase()}`;
      return MODEL_WORDS[w] ?? (/\d/.test(w) ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1));
    })
    .join(" ");
}
