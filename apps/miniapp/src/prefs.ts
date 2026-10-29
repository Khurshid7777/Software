/**
 * Small per-device conveniences (last delivery district and address). Storage may be unavailable
 * (private mode, some webviews): every access is guarded and failures fall back to defaults.
 */
export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(`ishonch.${key}`);
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string) {
  try {
    localStorage.setItem(`ishonch.${key}`, value);
  } catch {
    /* ignore */
  }
}

/** "8500000" → "8 500 000" while typing (digits only in, grouped text out). */
export const groupDigits = (raw: string) => raw.replace(/\D/g, "").replace(/\B(?=(\d{3})+(?!\d))/g, " ");
export const digitsOnly = (raw: string) => raw.replace(/\D/g, "");

/** What the buyer typed into the catalog search, newest first (a few, to tap again). */
const SEARCHES_KEY = "searches";
export function readSearches(): string[] {
  try {
    const v = JSON.parse(readPref(SEARCHES_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 6) : [];
  } catch {
    return [];
  }
}
export function rememberSearch(q: string) {
  const s = q.trim();
  if (s.length < 2) return;
  writePref(SEARCHES_KEY, JSON.stringify([s, ...readSearches().filter((x) => x.toLowerCase() !== s.toLowerCase())].slice(0, 6)));
}
export function clearSearches() {
  writePref(SEARCHES_KEY, "[]");
}

/** Listings the user opened, newest first (the storefront's "recently viewed"). */
const RECENT_KEY = "recent";
export function rememberViewed(id: string) {
  const ids = readRecent().filter((x) => x !== id);
  writePref(RECENT_KEY, [id, ...ids].slice(0, 12).join(","));
}
export function readRecent(): string[] {
  return (readPref(RECENT_KEY) ?? "").split(",").filter((x) => /^[0-9a-f-]{36}$/i.test(x));
}
