import { timingSafeEqual } from "node:crypto";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { validateInitData } from "./auth/telegram.js";

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
  "POST /listings/:id/offers": 10,
  "POST /listings/:id/trade-offers": 6,
  "POST /listings/:id/offer-likers": 5,
  "POST /listings/:id/meetings": 6,
  "POST /orders/:id/dispute": 5,
  // Uploads.
  "POST /listings/:id/photos": 20,
  "POST /shops/mine/photo": 10,
  "POST /listings/:id/video": 5,
  "POST /orders/:id/dispute/photos": 10,
  "POST /operator/orders/:id/inspection/photos": 20,
};
export const GLOBAL_LIMIT = 300;

export interface RateKeySecrets {
  botToken: string;
  internalToken: string;
  maxAgeSec: number;
}

/**
 * The bucket is the Telegram user, not the IP: all bot traffic comes from one container and many users
 * share mobile carrier IPs. Only a verified identity picks the bucket: the bot's header with the internal
 * token, or initData with a valid signature. Anything else (a forged id, a random user per request)
 * falls back to the IP, so a client cannot get a fresh bucket per request.
 */
export function makeRateKey(secrets: RateKeySecrets) {
  const internal = Buffer.from(`Internal ${secrets.internalToken}`);
  return (req: FastifyRequest): string => {
    const auth = req.headers.authorization ?? "";
    if (auth.startsWith("Internal ")) {
      const given = Buffer.from(auth);
      const raw = req.headers["x-telegram-user"];
      if (given.length === internal.length && timingSafeEqual(given, internal) && typeof raw === "string") {
        const id = raw.match(/"id"\s*:\s*(\d+)/)?.[1];
        if (id) return `tg:${id}`;
      }
    } else if (auth.startsWith("tma ")) {
      const res = validateInitData(auth.slice(4), secrets.botToken, secrets.maxAgeSec);
      if (res.ok) return `tg:${res.user.id}`;
    }
    return `ip:${req.ip}`;
  };
}

/** Must be registered before routes: limits are attached in the onRoute hook. In-memory store per instance. */
export async function registerRateLimits(app: FastifyInstance, secrets: RateKeySecrets) {
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const max = methods.map((m) => ROUTE_LIMITS[`${m} ${route.url}`]).find((x) => x !== undefined);
    if (max !== undefined) route.config = { ...(route.config as object), rateLimit: { max, timeWindow: "1 minute" } };
  });
  await app.register(rateLimit, {
    global: true,
    max: GLOBAL_LIMIT,
    timeWindow: "1 minute",
    keyGenerator: makeRateKey(secrets),
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429,
      error: "rate_limited",
      message: `Слишком много запросов. Подождите ${Math.ceil(ctx.ttl / 1000)} с · Juda ko'p so'rov. ${Math.ceil(ctx.ttl / 1000)} soniya kuting`,
    }),
  });
}
