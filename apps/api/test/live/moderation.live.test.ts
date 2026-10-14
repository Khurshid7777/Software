import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { ListingModerationSchema } from "@ishonch/shared";
import { PROMPTS_DIR } from "@ishonch/shared/node";
import { AiService, type AiUsageRecord } from "../../src/ai/aiService.js";

/**
 * Real Claude calls for listing pre-moderation (economical model, text only).
 *   ANTHROPIC_API_KEY=... pnpm test:ai
 */
const cases = JSON.parse(readFileSync(`${PROMPTS_DIR}__fixtures__/moderation.json`, "utf8")) as Array<{
  name: string;
  lang: "ru" | "uz";
  listing: Record<string, unknown>;
  expect: { decision: string[]; reason?: string };
}>;

describe.skipIf(!process.env.ANTHROPIC_API_KEY)("live AI moderation (costs money)", () => {
  const usage: AiUsageRecord[] = [];
  const ai = new AiService({
    client: new Anthropic(),
    models: { fast: process.env.AI_MODEL_FAST ?? "claude-haiku-5-5", strong: process.env.AI_MODEL_STRONG ?? "claude-opus-5-5" },
    recordUsage: async (u) => void usage.push(u),
    monthlySpend: async () => 0,
    monthlyLimitUsd: async () => 50,
  });

  for (const c of cases) {
    it(c.name, { timeout: 60_000 }, async () => {
      const res = await ai.structured({
        feature: "listing.moderate",
        promptId: "listing_moderate",
        content: [{ type: "text", text: JSON.stringify({ ...c.listing, has_photo: false }) }],
        schema: ListingModerationSchema,
      });
      console.log(c.name, JSON.stringify(res.data), res.usage.costUsd);
      expect(c.expect.decision).toContain(res.data.decision);
      if (c.expect.reason) expect(res.data.reasons.map((r) => r.code)).toContain(c.expect.reason);
      if (res.data.decision !== "approved") expect(res.data.seller_message_uz).not.toMatch(/[а-яё]/i);
    });
  }

  it("cost stays small", () => {
    const total = usage.reduce((s, u) => s + u.costUsd, 0);
    console.log(`moderation: ${usage.length} calls, $${total.toFixed(4)}`);
    if (usage.length) expect(total / usage.length).toBeLessThan(0.01);
  });
});
