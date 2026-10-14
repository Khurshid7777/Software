import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { AiService, type AiUsageRecord } from "../../src/ai/aiService.js";
import { analyzeListing, generateListingText } from "../../src/modules/listings/ai.js";
import { listingFixtures } from "../helpers.js";

/**
 * Real Claude calls for module D on the 5 fixtures (seller voice transcripts / texts, RU + UZ).
 *   ANTHROPIC_API_KEY=... pnpm test:ai
 */
describe.skipIf(!process.env.ANTHROPIC_API_KEY)("live AI listing creation (costs money)", () => {
  const usage: AiUsageRecord[] = [];
  const ai = new AiService({
    client: new Anthropic(),
    models: { fast: process.env.AI_MODEL_FAST ?? "claude-haiku-5-5", strong: "claude-opus-5-5" },
    recordUsage: async (u) => void usage.push(u),
    monthlySpend: async () => ({ fast: 0, strong: 0 }),
    monthlyLimitUsd: async () => 50,
  });

  for (const f of listingFixtures.filter((x) => x.input)) {
    it(f.name, { timeout: 90_000 }, async () => {
      const a = await analyzeListing({ images: [], transcript: f.input }, { ai, usdRate: 12_800, findReferencePrice: async () => null });
      expect(a.analysis.category).toBe(f.expect.category);
      expect((a.analysis.model_key ?? "").toLowerCase()).toContain(f.expect.model_key_contains);
      expect(a.analysis.questions.length).toBeLessThanOrEqual(3);

      const answers = Object.fromEntries(a.analysis.questions.map((q) => [q.key, f.answers[q.key] ?? q.options[0] ?? ""]));
      const g = await generateListingText({ analysis: a.analysis, answers, sellerWords: f.input }, { ai });
      const all = Object.values(g.text).join("\n");
      console.log(f.name, { cost: a.costUsd + g.costUsd, questions: a.analysis.questions.map((q) => q.key) }, "\n" + all);

      for (const bad of f.expect.forbidden) expect(all.toLowerCase()).not.toContain(bad.toLowerCase());
      for (const must of f.expect.must_mention) expect(all.toLowerCase()).toContain(must.toLowerCase());
      expect(g.text.title_uz).not.toMatch(/[а-яё]/i); // Uzbek must be Latin script
      expect(a.costUsd + g.costUsd).toBeLessThan(0.02);
    });
  }
});
