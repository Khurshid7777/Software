import { dictionaries, registerDictionary } from "./i18n-core.js";
import type { Lang } from "./types.js";

/** Downloads one dictionary on demand (a separate chunk per language in the Mini App build). */
export async function loadLanguage(lang: Lang): Promise<void> {
  if (dictionaries[lang]) return;
  const mod = lang === "ru" ? await import("../i18n/ru.json") : await import("../i18n/uz.json");
  registerDictionary(lang, mod.default as Record<string, string>);
}
