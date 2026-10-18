import { timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Db } from "./db/client.js";
import { MAX_ATTEMPTS } from "./jobs/queue.js";

/**
 * `/metrics` in the Prometheus text format (stage 30): request counts and time per route and status, the job
 * queue and the process. No client library — a few counters are enough. Off unless METRICS_TOKEN is set;
 * the scraper sends `Authorization: Bearer <token>`.
 */
export function registerOpsMetrics(app: FastifyInstance, db: Db, token: string) {
  if (!token) return;
  const requests = new Map<string, { count: number; seconds: number }>();
  app.addHook("onResponse", async (req, reply) => {
    // The route pattern, not the URL: ids would make every listing its own series.
    const route = req.routeOptions.url ?? "unmatched";
    if (route === "/metrics") return;
    const key = `${req.method}|${route}|${reply.statusCode}`;
    const r = requests.get(key) ?? { count: 0, seconds: 0 };
    r.count += 1;
    r.seconds += reply.elapsedTime / 1000;
    requests.set(key, r);
  });

  const expected = Buffer.from(`Bearer ${token}`);
  app.get("/metrics", async (req, reply) => {
    const given = Buffer.from(req.headers.authorization ?? "");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return reply.code(404).send({ error: "not_found" });
    const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const lines: string[] = [
      "# HELP ishonch_http_requests_total HTTP requests by method, route pattern and status.",
      "# TYPE ishonch_http_requests_total counter",
    ];
    const seconds: string[] = [
      "# HELP ishonch_http_request_seconds_total Time spent answering, by method, route pattern and status.",
      "# TYPE ishonch_http_request_seconds_total counter",
    ];
    for (const [key, r] of requests) {
      const [method, route, status] = key.split("|");
      const labels = `method="${method}",route="${esc(route!)}",status="${status}"`;
      lines.push(`ishonch_http_requests_total{${labels}} ${r.count}`);
      seconds.push(`ishonch_http_request_seconds_total{${labels}} ${r.seconds.toFixed(3)}`);
    }
    const [q] = (await db.execute(sql`
      select count(*) filter (where done_at is null and run_at <= now() and attempts < ${MAX_ATTEMPTS})::int as due,
             count(*) filter (where done_at is null and run_at > now())::int as deferred,
             count(*) filter (where done_at is null and attempts >= ${MAX_ATTEMPTS})::int as dead
      from jobs`)) as unknown as Array<{ due: number; deferred: number; dead: number }>;
    const mem = process.memoryUsage();
    const body = [
      ...lines,
      ...seconds,
      "# HELP ishonch_jobs Background jobs not done: due now, deferred (quiet hours, later runs), gave up after all attempts.",
      "# TYPE ishonch_jobs gauge",
      `ishonch_jobs{state="due"} ${q?.due ?? 0}`,
      `ishonch_jobs{state="deferred"} ${q?.deferred ?? 0}`,
      `ishonch_jobs{state="dead"} ${q?.dead ?? 0}`,
      "# TYPE process_resident_memory_bytes gauge",
      `process_resident_memory_bytes ${mem.rss}`,
      "# TYPE process_uptime_seconds gauge",
      `process_uptime_seconds ${Math.round(process.uptime())}`,
      "",
    ].join("\n");
    return reply.type("text/plain; version=0.0.4").send(body);
  });
}
