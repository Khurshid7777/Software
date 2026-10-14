// CI check for the dictionaries: `pnpm check:i18n`. Exits 1 with a list of problems.
//  - ru.json and uz.json have the same keys and the same {placeholders} per key, no empty values;
//  - Uzbek is in Latin script (Cyrillic only where intentionally bilingual);
//  - every literal key used in code (t("…"), t(lang, "…"), tList(lang, "…")) exists.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const ru = JSON.parse(readFileSync(join(root, "packages/shared/i18n/ru.json"), "utf8")) as Record<string, string>;
const uz = JSON.parse(readFileSync(join(root, "packages/shared/i18n/uz.json"), "utf8")) as Record<string, string>;
const BILINGUAL = new Set(["bot.choose_language"]);
const problems: string[] = [];

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
for (const k of Object.keys(ru)) if (!(k in uz)) problems.push(`missing in uz.json: ${k}`);
for (const k of Object.keys(uz)) if (!(k in ru)) problems.push(`missing in ru.json: ${k}`);
for (const k of Object.keys(ru)) {
  if (!(k in uz)) continue;
  if (!ru[k]!.trim() || !uz[k]!.trim()) problems.push(`empty value: ${k}`);
  if (placeholders(ru[k]!) !== placeholders(uz[k]!)) problems.push(`placeholders differ: ${k} (ru {${placeholders(ru[k]!)}} / uz {${placeholders(uz[k]!)}})`);
  if (/[а-яё]/i.test(uz[k]!) && !BILINGUAL.has(k)) problems.push(`Cyrillic in uz.json: ${k}`);
}

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* sources(p);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}
const KEY_USE = /\b(?:t|tList|translate)\(\s*(?:(?:[\w.!]+|"[a-z]{2}")\s*,\s*)?"([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)"/g;
let used = 0;
for (const dir of ["apps/api/src", "apps/bot/src", "apps/miniapp/src", "packages/shared/src"]) {
  for (const file of sources(join(root, dir))) {
    for (const m of readFileSync(file, "utf8").matchAll(KEY_USE)) {
      used++;
      if (!(m[1]! in ru)) problems.push(`unknown key ${m[1]} in ${file.slice(root.length)}`);
    }
  }
}

if (problems.length) {
  console.error(`i18n: ${problems.length} problem(s)\n` + problems.map((p) => ` - ${p}`).join("\n"));
  process.exit(1);
}
console.log(`i18n ok: ${Object.keys(ru).length} keys in ru/uz, ${used} literal uses checked`);
