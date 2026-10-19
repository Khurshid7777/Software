/**
 * Lost/stolen device registry (UzIMEI or a carrier's base, docs/plan.md «Нужны договоры»). Ishonch has no
 * access yet, so the default is NoRegistry and the passport shows only the check against Ishonch's own
 * listings. When a contract exists, set IMEI_REGISTRY=http: the provider calls a small adapter service
 * that speaks the registry's real protocol and answers in the shape below.
 */
export type ImeiRegistryStatus = "clean" | "listed";

export interface ImeiRegistryResult {
  status: ImeiRegistryStatus;
  /** Provider name for the passport and the moderators. */
  provider: string;
}

export interface ImeiRegistry {
  readonly name: string;
  /** null: the registry did not answer (outage, timeout, unknown format); publication must not wait for it. */
  check(imei: string): Promise<ImeiRegistryResult | null>;
}

/**
 * Generic HTTP adapter: GET `${url}?imei=...` with a bearer token, answer `{ "status": "clean" | "listed" }`.
 * Anything else counts as no answer.
 */
export class HttpImeiRegistry implements ImeiRegistry {
  readonly name = "http";

  constructor(
    private opts: { url: string; token?: string; timeoutMs?: number; fetch?: typeof fetch },
  ) {}

  async check(imei: string): Promise<ImeiRegistryResult | null> {
    const url = new URL(this.opts.url);
    url.searchParams.set("imei", imei);
    try {
      const res = await (this.opts.fetch ?? fetch)(url, {
        headers: this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {},
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 3000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { status?: unknown };
      return body.status === "clean" || body.status === "listed" ? { status: body.status, provider: this.name } : null;
    } catch {
      return null;
    }
  }
}

export function createImeiRegistry(config: { IMEI_REGISTRY: "none" | "http"; IMEI_REGISTRY_URL: string; IMEI_REGISTRY_TOKEN?: string }): ImeiRegistry | null {
  switch (config.IMEI_REGISTRY) {
    case "none":
      return null;
    case "http":
      if (!config.IMEI_REGISTRY_URL) throw new Error("IMEI_REGISTRY=http needs IMEI_REGISTRY_URL");
      return new HttpImeiRegistry({ url: config.IMEI_REGISTRY_URL, token: config.IMEI_REGISTRY_TOKEN });
  }
}
