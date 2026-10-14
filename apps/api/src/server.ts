import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";

const config = loadConfig();
const { db, sql } = createDb(config.DATABASE_URL);
const app = await buildApp({ config, db });

let expiryTimer: NodeJS.Timeout | undefined;
let digestTimer: NodeJS.Timeout | undefined;
const shutdown = async () => {
  clearInterval(expiryTimer);
  clearInterval(digestTimer);
  await app.close();
  await sql.end();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ port: config.PORT, host: "0.0.0.0" });

// Hourly: listing expiry (reminders 3 days ahead, auto-archive after 30 days) and delivery requests unanswered for 48 h.
// Safe with several instances: rows are claimed by conditional updates.
const runExpiry = async () => {
  try {
    const r = await app.services.listings.runExpiry();
    const staleOrders = await app.services.orders.expireStale();
    if (r.reminded || r.archived || staleOrders) app.log.info({ ...r, staleOrders }, "expiry job");
  } catch (err) {
    app.log.error({ err }, "expiry job failed");
  }
};
setTimeout(runExpiry, 30_000);
expiryTimer = setInterval(runExpiry, 3600_000);

// Morning digest for admins (DIGEST_HOUR, Tashkent); checked every 10 minutes, sent once a day.
digestTimer = setInterval(
  () => app.services.digest().catch((err) => app.log.error({ err }, "digest failed")),
  10 * 60_000,
);
