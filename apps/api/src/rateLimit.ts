import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyRequest } from "fastify";

/** Per-route limits per user and minute; everything else gets the global limit. */
export const ROUTE_LIMITS: Record<string, number> = {
  // Paid AI calls (daily quotas apply on top).
  "POST /checks": 6,
  "POST /assistant": 10,
  "POST /assistant/compare": 6,
  "POST /listings/drafts": 6,
  "POST /listings/:id/generate": 10,
  // Messages and requests that reach other people through the bot.
  "POST /listings/:id/contact": 10,
  "POST /internal/conversations/:id/messages": 20,
  "POST /orders": 6,
  "POST /listings/:id/complaints": 10,
  // Uploads.
  "POST /listings/:id/photos": 20,
  "POST /shops/mine/photo": 10,
};
export const GLOBAL_LIMIT = 300;

/**
 * The bucket is the Telegram user, not the IP: all bot traffic comes from one container and many users
 * share mobile carrier IPs. The id is read without verification here (auth runs later); a forged id only
 * changes the bucket of a request that will then be rejected as unauthorized.
 */
export function rateKey(req: FastifyRequest): string {
  const raw = req.headers["x-telegram-user"];
  if (typeof raw === "string") {
    const id = raw.match(/"id"\s*:\s*(\d+)/)?.[1];
    if (id) return `tg:${id}`;
  }
  const auth = req.headers.authorization ?? "";
  if (auth.startsWith("tma ")) {
    try {
      const user = new URLSearchParams(auth.slice(4)).get("user");
      const id = user ? (JSON.parse(user) as { id?: number }).id : undefined;
      if (id) return `tg:${id}`;
    } catch {
      /* fall through to the IP */
    }
  }
  return `ip:${req.ip}`;
}

/** Must be registered before routes: limits are attached in the onRoute hook. In-memory store per instance. */
export async function registerRateLimits(app: FastifyInstance) {
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const max = methods.map((m) => ROUTE_LIMITS[`${m} ${route.url}`]).find((x) => x !== undefined);
    if (max !== undefined) route.config = { ...(route.config as object), rateLimit: { max, timeWindow: "1 minute" } };
  });
  await app.register(rateLimit, {
    global: true,
    max: GLOBAL_LIMIT,
    timeWindow: "1 minute",
    keyGenerator: rateKey,
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429,
      error: "rate_limited",
      message: `Слишком много запросов. Подождите ${Math.ceil(ctx.ttl / 1000)} с · Juda ko'p so'rov. ${Math.ceil(ctx.ttl / 1000)} soniya kuting`,
    }),
  });
}
