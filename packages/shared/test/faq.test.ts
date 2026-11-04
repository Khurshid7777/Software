import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FAQ_ACTION_KINDS, FAQ_ACTIONS, FAQ_GROUPS, FAQ_IDS, isFaqId } from "../src/faq.js";

const load = (lang: string) => JSON.parse(readFileSync(new URL(`../i18n/${lang}.json`, import.meta.url), "utf8")) as Record<string, string>;
const dict = { ru: load("ru"), uz: load("uz") };
/** The numbers the FAQ screen passes to every answer (Faq.tsx PARAMS). */
const PARAMS = ["min", "days", "compare", "pct", "hours", "accepted", "ttl", "remind", "bump", "mb", "imeiChecks", "videoChecks", "keep", "from", "to"];

describe("FAQ", () => {
  it("is big enough to matter, and ids are unique", () => {
    expect(FAQ_IDS.length).toBeGreaterThanOrEqual(50);
    expect(new Set(FAQ_IDS).size).toBe(FAQ_IDS.length);
    expect(FAQ_GROUPS.every((g) => g.items.length >= 3)).toBe(true);
  });

  for (const lang of ["ru", "uz"] as const) {
    it(`every question has a real question and answer in ${lang}`, () => {
      for (const id of FAQ_IDS) {
        const q = dict[lang][`faq.${id}.q`];
        const a = dict[lang][`faq.${id}.a`];
        expect(q, `faq.${id}.q`).toBeTruthy();
        expect(q!.trim().endsWith("?"), `${id}: a question ends with ?`).toBe(true);
        expect(a, `faq.${id}.a`).toBeTruthy();
        expect(a!.length, `${id}: not a stub`).toBeGreaterThan(60);
        // Only numbers the screen really passes: an unknown {name} would show up as raw text.
        for (const m of a!.matchAll(/\{(\w+)\}/g)) expect(PARAMS, `${id}: {${m[1]}}`).toContain(m[1]);
      }
      for (const g of FAQ_GROUPS) expect(dict[lang][`faq.group.${g.id}`], `group ${g.id}`).toBeTruthy();
    });
  }

  it("a button on an answer leads somewhere that exists", () => {
    for (const [id, action] of Object.entries(FAQ_ACTIONS)) {
      expect(isFaqId(id)).toBe(true);
      expect(FAQ_ACTION_KINDS).toContain(action);
      expect(dict.ru[`faq.action.${action}`], `faq.action.${action}`).toBeTruthy();
      expect(dict.uz[`faq.action.${action}`], `faq.action.${action}`).toBeTruthy();
    }
  });

  it("the answers never promise what the product does not do", () => {
    // Ishonch holds no money, takes no prepayment and offers no instalments: wording that implies otherwise is a bug.
    const all = FAQ_IDS.map((id) => dict.ru[`faq.${id}.a`]!.toLowerCase()).join("\n");
    expect(all).not.toMatch(/эскроу|холдир|гарантируем возврат|мы вернём деньги|выплата от платформы будет/);
  });
});
