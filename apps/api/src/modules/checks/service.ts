import { isLinkOnly, scrubPii, type CheckResult, type Lang, type MarketRange } from "@ishonch/shared";
import type { Repo } from "../../db/repo.js";
import type { User } from "../../db/schema.js";
import { AiLimitExceededError, AiOutputError, type AiService } from "../../ai/aiService.js";
import { runCheck, type CheckImage } from "./pipeline.js";

export const MAX_IMAGES = 5;

export type CheckError =
  | "empty_input"
  | "too_many_images"
  | "link_not_supported"
  | "limit_reached"
  | "not_listing"
  | "ai_unavailable";

export class CheckRejected extends Error {
  constructor(
    public code: CheckError,
    public status: number,
    public params: Record<string, number> = {},
  ) {
    super(code);
  }
}

export class CheckService {
  constructor(
    private repo: Repo,
    private ai: Pick<AiService, "structured">,
    private defaults: { checksPerDay: number; usdRate: number },
    private findCatalogPrice: (modelKey: string) => Promise<MarketRange | null> = async () => null,
  ) {}

  async limitInfo(user: User) {
    const perDay = await this.repo.getSetting("checks_per_day", this.defaults.checksPerDay);
    // Every AI run counts, including "not a listing" answers (the AI was paid either way).
    const used = await this.repo.usedToday(user.id, "quota_check");
    return { perDay, remaining: Math.max(0, perDay - used) };
  }

  async create(user: User, input: { lang?: Lang; text?: string; images: CheckImage[] }): Promise<CheckResult> {
    const lang = input.lang ?? (user.language as Lang);
    const text = input.text?.trim() ?? "";
    if (!text && input.images.length === 0) throw new CheckRejected("empty_input", 400);
    if (input.images.length > MAX_IMAGES) throw new CheckRejected("too_many_images", 400);
    if (input.images.length === 0 && isLinkOnly(text)) throw new CheckRejected("link_not_supported", 422);

    const { perDay, remaining } = await this.limitInfo(user);
    if (remaining <= 0) throw new CheckRejected("limit_reached", 429, { n: perDay });
    const reservation = await this.repo.reserveDaily(user.id, "quota_check", perDay);
    if (reservation === null) throw new CheckRejected("limit_reached", 429, { n: perDay });

    const started = Date.now();
    let outcome;
    try {
      outcome = await runCheck(
        { lang, text, images: input.images },
        {
          ai: this.ai,
          findReferencePrice: (k) => this.repo.findReferencePrice(k),
          findCatalogPrice: (k) => this.findCatalogPrice(k),
          usdRate: await this.repo.getSetting("usd_rate", this.defaults.usdRate),
          riskRules: await this.repo.riskRules(),
        },
      );
    } catch (err) {
      await this.repo.refundDaily(reservation);
      if (err instanceof AiLimitExceededError || err instanceof AiOutputError) {
        throw new CheckRejected("ai_unavailable", 503);
      }
      throw err;
    }
    if (outcome.notListing) {
      await this.repo.event(user.id, "check_not_listing", {});
      throw new CheckRejected("not_listing", 422);
    }

    const r = outcome.result;
    const row = await this.repo.insertCheck({
      userId: user.id,
      lang,
      inputType: input.images.length ? "image" : "text",
      extracted: { ...outcome.extracted, suspicious_phrases: outcome.extracted.suspicious_phrases.map(scrubPii) },
      priceVerdict: r.price.verdict,
      priceDiffPct: r.price.diffPct,
      priceUzs: r.price.priceUzs,
      priceSource: r.price.source,
      riskScore: r.risk.score,
      riskLevel: r.risk.level,
      flags: r.risk.flags,
      result: r,
      costUsd: outcome.costUsd,
      durationMs: Date.now() - started,
    });
    await this.repo.event(user.id, "check_created", { risk: r.risk.level, verdict: r.price.verdict });

    return { ...r, id: row.id, createdAt: row.createdAt.toISOString(), remainingToday: remaining - 1 };
  }

  async get(id: string): Promise<CheckResult | null> {
    const row = await this.repo.getCheck(id);
    if (!row) return null;
    return {
      ...(row.result as Omit<CheckResult, "id" | "createdAt" | "remainingToday">),
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      remainingToday: null,
    };
  }
}
