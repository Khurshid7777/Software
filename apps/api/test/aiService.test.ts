import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AiLimitExceededError, AiService, type AiServiceDeps } from "../src/ai/aiService.js";

/** A fake Anthropic client that returns a fixed parsed output and token usage. */
function fakeClient(calls: string[]) {
  return {
    messages: {
      parse: async (req: { model: string }) => {
        calls.push(req.model);
        return { id: "msg_1", stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: 200 }, parsed_output: { ok: true } };
      },
    },
  } as unknown as AiServiceDeps["client"];
}

function service(spent: { fast: number; strong: number }, limits: { total: number; strong: number }) {
  const calls: string[] = [];
  const added: Array<[string, number]> = [];
  const ai = new AiService({
    client: fakeClient(calls),
    models: { fast: "claude-haiku-5-5", strong: "claude-opus-5-5" },
    recordUsage: async () => undefined,
    monthlySpend: async () => spent,
    addSpend: async (tier, usd) => void added.push([tier, usd]),
    monthlyLimitUsd: async () => limits.total,
    strongLimitUsd: async () => limits.strong,
  });
  return { ai, calls, added };
}
const call = (promptId: string) => ({ feature: "t", promptId, content: [{ type: "text" as const, text: "x" }], schema: z.object({ ok: z.boolean() }) });

describe("AI budget", () => {
  it("counts each call into the running counter of its tier", async () => {
    const { ai, added } = service({ fast: 1, strong: 1 }, { total: 50, strong: 20 });
    await ai.structured(call("check_extract"));
    await ai.structured(call("assistant_recommend"));
    expect(added.map(([tier]) => tier)).toEqual(["fast", "strong"]);
    expect(added.every(([, usd]) => usd > 0)).toBe(true);
  });

  it("the strong model stops at its own cap while cheap features keep working", async () => {
    const { ai, calls } = service({ fast: 5, strong: 20 }, { total: 50, strong: 20 });
    await expect(ai.structured(call("assistant_recommend"))).rejects.toBeInstanceOf(AiLimitExceededError);
    await ai.structured(call("check_extract"));
    expect(calls).toEqual(["claude-haiku-5-5"]);
  });

  it("the total limit stops everything", async () => {
    const { ai } = service({ fast: 45, strong: 5 }, { total: 50, strong: 20 });
    await expect(ai.structured(call("check_extract"))).rejects.toBeInstanceOf(AiLimitExceededError);
  });
});
