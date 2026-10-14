import type ru from "../i18n/ru.json";
import type { Lang } from "./types.js";

export type { Lang };

/** Keys of the Russian dictionary (both dictionaries have the same keys — checked in tests and CI). */
export type I18nKey = keyof typeof ru;

/**
 * Dictionaries are registered, not imported here: the server registers both at start (i18n.ts),
 * the Mini App downloads only the user's language (loadLanguage in client.ts).
 */
export const dictionaries: Partial<Record<Lang, Record<string, string>>> = {};

export function registerDictionary(lang: Lang, dict: Record<string, string>) {
  dictionaries[lang] = dict;
}

export const DEFAULT_LANG: Lang = "uz";

/** Maps a Telegram `language_code` to one of our two UI languages. */
export function normalizeLang(code: string | null | undefined): Lang {
  if (!code) return DEFAULT_LANG;
  const c = code.toLowerCase();
  if (c.startsWith("ru") || c.startsWith("kk") || c.startsWith("be") || c.startsWith("uk")) return "ru";
  return "uz";
}

export function t(lang: Lang, key: I18nKey, params?: Record<string, string | number>): string {
  const template = dictionaries[lang]?.[key] ?? dictionaries.ru?.[key] ?? dictionaries.uz?.[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (params[name] !== undefined ? String(params[name]) : m));
}

/** Lists are stored as "a|b|c" strings so that translators edit one line per list. */
export function tList(lang: Lang, key: I18nKey): string[] {
  return t(lang, key)
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}
