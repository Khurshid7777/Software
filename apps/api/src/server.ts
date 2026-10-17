import { buildApp } from "./app.js";
import { loadConfig, productionWarnings } from "./config.js";
import { createDb } from "./db/client.js";
import { LOCKS, singleton } from "./jobs/lock.js";

const config = loadConfig();
const { db, sql } = createDb(config.DATABASE_URL);
const app = await buildApp({ config, db, backgroundJobs: true });
const { queue, listings, orders, digest } = app.services;

let hourlyTimer: NodeJS.Timeout | undefined;
let digestTimer: NodeJS.Timeout | undefined;
const shutdown = async () => {
  clearInterval(hourlyTimer);
  clearInterval(digestTimer);
  await queue.stop(); // finish the job batch in progress
  await app.close();
  await sql.end();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

for (const w of productionWarnings(config)) app.log.warn(`UNSAFE CONFIG: ${w}`);
await app.listen({ port: config.PORT, host: "0.0.0.0" });

// Background jobs (channel posts, saved-search alerts): every instance works, SKIP LOCKED splits the queue.
queue.start();

// Hourly, on one instance at a time (advisory lock): listing expiry (reminder 3 days ahead, archive after
// 30 days), delivery requests unanswered for 48 h, expired price offers, review reminders, cleanup of finished jobs.
const hourly = () =>
  singleton(db, LOCKS.hourly, async () => {
    // Each step on its own: one failing (e.g. expiry) must not skip stale orders, reminders or cleanup.
    const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
      try {
        return await fn();
      } catch (err) {
        app.log.error({ err, step: name }, "hourly step failed");
        return null;
      }
    };
    const r = await step("expiry", () => listings.runExpiry());
    const staleOrders = await step("stale_orders", () => orders.expireStale());
    await step("offers", () => orders.expireOffers());
    await step("auto_drops", () => listings.runAutoDrops());
    await step("meetings", () => app.services.meetings.runMaintenance());
    await step("review_reminders", () => orders.remindReviews());
    await step("jobs_cleanup", () => queue.cleanup());
    await step("privacy_retention", () => app.services.repo.runRetention());
    await step("pending_replies", () => app.services.catalog.cleanupPendingReplies());
    if (r?.reminded || r?.archived || staleOrders) app.log.info({ ...r, staleOrders }, "hourly job");
  }).catch((err) => app.log.error({ err }, "hourly job failed"));
setTimeout(hourly, 30_000);
hourlyTimer = setInterval(hourly, 3600_000);

// Morning digest for admins (DIGEST_HOUR, Tashkent); checked every 10 minutes, sent once a day.
digestTimer = setInterval(
  () => singleton(db, LOCKS.digest, () => digest()).catch((err) => app.log.error({ err }, "digest failed")),
  10 * 60_000,
);
