import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { costUsd } from "@ishonch/shared";
import { loadPrompt, renderPrompt } from "./prompts.js";

export interface AiUsageRecord {
  feature: string;
  model: string;
  promptId: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  requestId: string | null;
}

export interface AiServiceDeps {
  client: Pick<Anthropic, "messages">;
  models: { fast: string; strong: string };
  recordUsage: (u: AiUsageRecord) => Promise<void>;
  /** Running spend this calendar month, USD, per model tier (an atomic counter, not a SUM over the log). */
  monthlySpend: () => Promise<{ fast: number; strong: number }>;
  /** Adds a call's cost to the running counter. */
  addSpend?: (tier: "fast" | "strong", usd: number) => Promise<void>;
  monthlyLimitUsd: () => Promise<number>;
  /** Cap for the strong model inside the total, so the assistant cannot starve checks and moderation. */
  strongLimitUsd?: () => Promise<number>;
  logger?: { warn: (obj: object, msg: string) => void };
}

export class AiLimitExceededError extends Error {
  constructor(public spent: number, public limit: number) {
    super(`AI monthly limit exceeded: $${spent.toFixed(2)} of $${limit}`);
  }
}

export class AiOutputError extends Error {}

export interface StructuredCall<S extends z.ZodType> {
  feature: string;
  promptId: string;
  promptVersion?: number;
  vars?: Record<string, string | number>;
  content: Anthropic.ContentBlockParam[];
  schema: S;
}

export interface StructuredResult<T> {
  data: T;
  usage: AiUsageRecord;
}

/**
 * The single entry point for every Claude call in the project.
 * Loads the versioned prompt, enforces the monthly budget, validates output and logs cost to `ai_usage`.
 */
export class AiService {
  constructor(private deps: AiServiceDeps) {}

  async structured<S extends z.ZodType>(call: StructuredCall<S>): Promise<StructuredResult<z.infer<S>>> {
    const prompt = loadPrompt(call.promptId, call.promptVersion);
    const [byTier, limit, strongLimit] = await Promise.all([
      this.deps.monthlySpend(),
      this.deps.monthlyLimitUsd(),
      this.deps.strongLimitUsd?.() ?? Promise.resolve(Infinity),
    ]);
    const spent = byTier.fast + byTier.strong;
    if (spent >= limit) throw new AiLimitExceededError(spent, limit);
    if (prompt.model === "strong" && byTier.strong >= strongLimit) throw new AiLimitExceededError(byTier.strong, strongLimit);
    if (spent >= limit * 0.8) {
      this.deps.logger?.warn({ spent, limit }, "AI spend is above 80% of the monthly limit");
    }

    const model = this.deps.models[prompt.model];
    const started = Date.now();

    const response = await this.deps.client.messages.parse({
      model,
      max_tokens: prompt.maxTokens,
      system: renderPrompt(prompt.body, call.vars),
      messages: [{ role: "user", content: call.content }],
      output_config: { effort: prompt.effort, format: zodOutputFormat(call.schema) },
    });

    const usage: AiUsageRecord = {
      feature: call.feature,
      model,
      promptId: `${prompt.id}.v${prompt.version}`,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      costUsd: costUsd(model, response.usage.input_tokens, response.usage.output_tokens),
      durationMs: Date.now() - started,
      requestId: response.id,
    };
    await this.deps.recordUsage(usage);
    await this.deps.addSpend?.(prompt.model, usage.costUsd);

    if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens" || !response.parsed_output) {
      throw new AiOutputError(`No valid output (stop_reason=${response.stop_reason})`);
    }
    return { data: response.parsed_output as z.infer<S>, usage };
  }
}
