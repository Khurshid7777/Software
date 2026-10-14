import type { CheckCategory, Lang } from "./types.js";
import { tList } from "./i18n-core.js";

const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b(?:olx\.uz|t\.me|instagram\.com|telegram\.me)\/\S*/gi;

/** True when the text is essentially just links (we never scrape other marketplaces). */
export function isLinkOnly(text: string): boolean {
  const withoutLinks = text.replace(URL_RE, "").replace(/[\s\p{P}]/gu, "");
  return withoutLinks.length < 15 && new RegExp(URL_RE.source, "i").test(text);
}

// Uzbek numbers: a mobile operator or regional code, then 7 digits; "-", "." or spaces as separators.
// Never inside a longer run of digits, so prices (125000000), IMEI and serial numbers are left alone.
const UZ_CODES = "(?:20|33|50|55|6[1-9]|7[0-9]|88|9[0-9])";
const PHONE_RE = new RegExp(
  `(?<![\\d.])(?:\\+?998[\\s.-]?)?\\(?${UZ_CODES}\\)?[\\s.-]?\\d{3}[\\s.-]?\\d{2}[\\s.-]?\\d{2}(?![\\d.]?\\d)`,
  "g",
);
const HANDLE_RE = /@[a-z0-9_]{4,}/gi;
const CARD_RE = /\b(?:\d{4}[\s-]?){3}\d{4}\b/g;

/** Removes phones, card numbers, @handles and links from text that we are about to store. */
export function scrubPii(text: string): string {
  return text
    .replace(CARD_RE, "[card]")
    .replace(PHONE_RE, "[phone]")
    .replace(HANDLE_RE, "[user]")
    .replace(URL_RE, "[link]");
}

export function inspectionChecklist(lang: Lang, category: CheckCategory): string[] {
  return tList(lang, `checklist.${category}` as Parameters<typeof tList>[1]);
}
