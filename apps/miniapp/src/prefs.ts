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

/** Listings the user opened, newest first (the storefront's "recently viewed"). */
const RECENT_KEY = "recent";
export function rememberViewed(id: string) {
  const ids = readRecent().filter((x) => x !== id);
  writePref(RECENT_KEY, [id, ...ids].slice(0, 12).join(","));
}
export function readRecent(): string[] {
  return (readPref(RECENT_KEY) ?? "").split(",").filter((x) => /^[0-9a-f-]{36}$/i.test(x));
}
