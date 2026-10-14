import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { DEFAULT_RISK_RULES, sameModel } from "@ishonch/shared";
import { AiService, type AiUsageRecord } from "../../src/ai/aiService.js";
import { runCheck } from "../../src/modules/checks/pipeline.js";
import { fixtures } from "../helpers.js";

/**
 * Real Claude calls on the 5 fixtures. Costs a few cents. Run with:
 *   ANTHROPIC_API_KEY=... pnpm test:ai
 */
describe.skipIf(!process.env.ANTHROPIC_API_KEY)("live AI check (costs money)", () => {
  const usage: AiUsageRecord[] = [];
  const ai = new AiService({
    client: new Anthropic(),
    models: { fast: process.env.AI_MODEL_FAST ?? "claude-haiku-5-5", strong: "claude-opus-5-5" },
    recordUsage: async (u) => void usage.push(u),
    monthlySpend: async () => ({ fast: 0, strong: 0 }),
    monthlyLimitUsd: async () => 50,
  });
  const reference = { "apple iphone 13 128gb": { min: 5_200_000, median: 5_800_000, max: 6_500_000 } };

  for (const f of fixtures) {
    it(f.name, { timeout: 60_000 }, async () => {
      usage.length = 0;
      const started = Date.now();
      const out = await runCheck(
        { lang: f.lang, text: f.input },
        {
          ai,
          findReferencePrice: async (k) => Object.entries(reference).find(([r]) => sameModel(r, k))?.[1] ?? null,
          findCatalogPrice: async () => null,
          usdRate: 12_800,
          riskRules: DEFAULT_RISK_RULES,
        },
      );
      const seconds = (Date.now() - started) / 1000;
      console.log(f.name, { seconds, cost: out.costUsd, risk: out.result.risk, price: out.result.price.verdict });

      expect(seconds).toBeLessThan(20);
      expect(out.costUsd).toBeLessThan(0.02);
      expect(out.result.category).toBe(f.expect.category);
      expect(out.extracted.model_key ?? "").toContain(f.expect.model_key_contains);
      expect(out.extracted.seller_signals.prepayment).toBe(f.expect.prepayment);
      expect(out.result.risk.level).toBe(f.expect.risk_level);
      expect(out.result.questions).toHaveLength(5);
      expect(JSON.stringify(out.extracted)).not.toMatch(/\+?998\d{9}/);
    });
  }
});
