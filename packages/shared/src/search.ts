/**
 * Spellings buyers in Tashkent actually type (Cyrillic/Latin transliterations, slang)
 * → the canonical word used in listing titles. Each query word matches either form.
 */
const SYNONYMS: Record<string, string> = {
  айфон: "iphone",
  aifon: "iphone",
  ayfon: "iphone",
  iphnoe: "iphone",
  ipone: "iphone",
  макбук: "macbook",
  makbuk: "macbook",
  macbok: "macbook",
  самсунг: "samsung",
  samsug: "samsung",
  galaxi: "galaxy",
  галакси: "galaxy",
  редми: "redmi",
  сяоми: "xiaomi",
  ксиоми: "xiaomi",
  xiomi: "xiaomi",
  шаоми: "xiaomi",
  айпад: "ipad",
  aypad: "ipad",
  эирподс: "airpods",
  аирподс: "airpods",
  airpod: "airpods",
  эпл: "apple",
  пс5: "playstation",
  ps5: "playstation",
  ps4: "playstation",
  плейстейшн: "playstation",
  сони: "sony",
  леново: "lenovo",
  асус: "asus",
  ноут: "ноутбук",
  // Same thing, other language: Russian and Uzbek titles find each other.
  наушник: "quloqchin",
  наушники: "quloqchin",
  quloqchin: "наушники",
  telefon: "телефон",
};

/** Uzbek Cyrillic → Latin (the 1995 alphabet; ц/щ/ъ/ь as people type them). */
const CYR_TO_LAT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", ғ: "g'", д: "d", е: "e", ё: "yo", ж: "j", з: "z", и: "i", й: "y", к: "k", қ: "q",
  л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ў: "o'", ф: "f", х: "x", ҳ: "h", ц: "ts",
  ч: "ch", ш: "sh", щ: "sh", ъ: "", ы: "i", ь: "", э: "e", ю: "yu", я: "ya",
};
/** Latin → Cyrillic, two-letter sounds first (the reverse is ambiguous for х/ҳ; Russian spelling wins). */
const LAT_TO_CYR: Array<[string, string]> = [
  ["o'", "ў"], ["g'", "ғ"], ["ch", "ч"], ["sh", "ш"], ["yo", "ё"], ["yu", "ю"], ["ya", "я"], ["ts", "ц"],
  ["a", "а"], ["b", "б"], ["v", "в"], ["g", "г"], ["d", "д"], ["e", "е"], ["j", "ж"], ["z", "з"], ["i", "и"], ["y", "й"],
  ["k", "к"], ["q", "қ"], ["l", "л"], ["m", "м"], ["n", "н"], ["o", "о"], ["p", "п"], ["r", "р"], ["s", "с"], ["t", "т"],
  ["u", "у"], ["f", "ф"], ["x", "х"], ["h", "ҳ"], ["w", "в"], ["c", "к"],
];

/**
 * The same word in the other script: "ноутбук" → "noutbuk", "telefon" → "телефон". Only for words written in
 * one script (letters, digits, apostrophes); model codes like "a54" or mixed words stay as they are (null).
 */
export function otherScript(w: string): string | null {
  const word = w.toLowerCase();
  if (/^[\p{Script=Cyrillic}\d]+$/u.test(word) && /\p{Script=Cyrillic}/u.test(word)) {
    return [...word].map((ch) => CYR_TO_LAT[ch] ?? ch).join("");
  }
  if (/^[a-z'ʻ’\d]+$/.test(word) && /[a-z]{3}/.test(word)) {
    let out = "";
    const s = word.replace(/[ʻ’]/g, "'");
    for (let i = 0; i < s.length; ) {
      const pair = LAT_TO_CYR.find(([lat]) => s.startsWith(lat, i));
      if (pair) {
        out += pair[1];
        i += pair[0].length;
      } else {
        out += s[i] === "'" ? "" : s[i];
        i += 1;
      }
    }
    return out;
  }
  return null;
}

export function canonicalWord(w: string): string | null {
  const c = SYNONYMS[w.toLowerCase()];
  return c && c !== w.toLowerCase() ? c : null;
}

/** "айфон 13" → "iphone 13" (used for fuzzy title matching). */
export function canonicalQuery(q: string): string {
  return q
    .toLowerCase()
    .split(/\s+/)
    .map((w) => canonicalWord(w) ?? w)
    .join(" ");
}
