import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { AssistantQuerySchema, AssistantRecommendSchema } from "@ishonch/shared";
import { PROMPTS_DIR } from "@ishonch/shared/node";
import { AiService, type AiUsageRecord } from "../../src/ai/aiService.js";

/**
 * Real Claude calls for the buyer assistant (economical model for the query, strong model for ranking).
 *   ANTHROPIC_API_KEY=... pnpm test:ai
 */
const { catalog, cases } = JSON.parse(readFileSync(`${PROMPTS_DIR}__fixtures__/assistant.json`, "utf8"));
const LANG_NAME = { ru: "Russian", uz: "Uzbek (Latin script)" } as const;

describe.skipIf(!process.env.ANTHROPIC_API_KEY)("live AI buyer assistant (costs money)", () => {
  const usage: AiUsageRecord[] = [];
  const ai = new AiService({
    client: new Anthropic(),
    models: { fast: process.env.AI_MODEL_FAST ?? "claude-haiku-5-5", strong: process.env.AI_MODEL_STRONG ?? "claude-opus-5-5" },
    recordUsage: async (u) => void usage.push(u),
    monthlySpend: async () => ({ fast: 0, strong: 0 }),
    monthlyLimitUsd: async () => 50,
  });

  for (const c of cases) {
    it(`query: ${c.name}`, { timeout: 60_000 }, async () => {
      const res = await ai.structured({
        feature: "assistant.query",
        promptId: "assistant_query",
        vars: { lang_name: LANG_NAME[c.lang as "ru" | "uz"], usd_rate: 12_800, asked: 0 },
        content: [
          {
            type: "text",
            text: c.messages.map((m: { role: string; content: string }) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n"),
          },
        ],
        schema: AssistantQuerySchema,
      });
      console.log(c.name, res.data, res.usage.costUsd);
      expect(res.data.action).toBe(c.expect.action);
      if (c.expect.category) expect(res.data.filters.category).toBe(c.expect.category);
      if (c.expect.price_max) expect(res.data.filters.price_max_uzs).toBe(c.expect.price_max);
      expect(res.data.questions.length).toBeLessThanOrEqual(2);
      if (c.lang === "uz") expect(res.data.reply).not.toMatch(/[а-яё]/i);
    });
  }

  it("recommend: only real ids, in the user's language, with pros/cons", { timeout: 120_000 }, async () => {
    const candidates = catalog
      .filter((l: { category: string; price: number }) => l.category === "laptop" && l.price <= 8_000_000)
      .map((l: Record<string, unknown>, i: number) => ({
        id: `00000000-0000-0000-0000-00000000000${i}`,
        title: l.titleRu,
        price: `${l.price} UZS`,
        price_vs_market: "—",
        condition: l.condition,
        specs: [],
        description: l.descriptionRu,
        district: l.district,
        seller_trust: i === 0 ? "high" : "low",
      }));
    const res = await ai.structured({
      feature: "assistant.recommend",
      promptId: "assistant_recommend",
      vars: { lang_name: "Russian" },
      content: [
        {
          type: "text",
          text: JSON.stringify({
            buyer_needs: "Laptop for video editing, budget 8M UZS",
            request: "Нужен ноутбук для видеомонтажа до 8 млн",
            candidates,
          }),
        },
      ],
      schema: AssistantRecommendSchema,
    });
    console.log(JSON.stringify(res.data, null, 1), res.usage);
    const ids = new Set(candidates.map((c: { id: string }) => c.id));
    expect(res.data.options.length).toBeGreaterThan(0);
    for (const o of res.data.options) {
      expect(ids.has(o.listing_id)).toBe(true);
      expect(o.pros.length + o.cons.length).toBeGreaterThan(0);
    }
    expect(res.data.summary).toMatch(/[а-яё]/i);
    expect(res.usage.costUsd).toBeLessThan(0.1);
  });
});
