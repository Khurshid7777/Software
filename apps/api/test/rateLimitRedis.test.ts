import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { buildInitData } from "../src/auth/telegram.js";
import { registerRateLimits } from "../src/rateLimit.js";

const url = process.env.TEST_REDIS_URL ?? "redis://localhost:6379";
const probe = new Redis(url, { lazyConnect: true, connectTimeout: 500, maxRetriesPerRequest: 0, retryStrategy: () => null });
const reachable = await probe
  .connect()
  .then(() => probe.ping())
  .then(() => true)
  .catch(() => false);
probe.disconnect();

const BOT_TOKEN = "123456:TEST";
const secrets = { botToken: BOT_TOKEN, internalToken: "internal-secret", maxAgeSec: 3600 };

async function replica(redisUrl: string): Promise<FastifyInstance> {
  const app = Fastify();
  await registerRateLimits(app, secrets, redisUrl);
  app.post("/checks", async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe.skipIf(!reachable)("rate limits shared through Redis (integration)", () => {
  let a: FastifyInstance;
  let b: FastifyInstance;
  // A fresh user per run: counters from an earlier run within the same minute must not leak in.
  const user = 970_000_000 + Math.floor(Math.random() * 1_000_000);
  const headers = { authorization: `tma ${buildInitData({ id: user, language_code: "ru" }, BOT_TOKEN)}` };

  beforeAll(async () => {
    a = await replica(url);
    b = await replica(url);
  });
  afterAll(async () => {
    await a.close();
    await b.close();
  });

  it("two replicas count one limit, not one each", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const app = i % 2 ? b : a;
      codes.push((await app.inject({ method: "POST", url: "/checks", headers })).statusCode);
    }
    expect(codes).toEqual([200, 200, 200, 200, 200, 200]);
    expect((await a.inject({ method: "POST", url: "/checks", headers })).statusCode).toBe(429);
    expect((await b.inject({ method: "POST", url: "/checks", headers })).statusCode).toBe(429);
  });

  it("an unreachable Redis does not take the API down", async () => {
    const app = await replica("redis://127.0.0.1:1");
    expect((await app.inject({ method: "POST", url: "/checks", headers })).statusCode).toBe(200);
    await app.close();
  });
});
