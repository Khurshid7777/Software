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

// Listing expiry: reminders 3 days ahead and auto-archive after 30 days. Hourly; safe with several instances.
const runExpiry = () =>
  app.services.listings
    .runExpiry()
    .then((r) => (r.reminded || r.archived) && app.log.info(r, "listing expiry"))
    .catch((err) => app.log.error({ err }, "listing expiry failed"));
setTimeout(runExpiry, 30_000);
expiryTimer = setInterval(runExpiry, 3600_000);

// Morning digest for admins (DIGEST_HOUR, Tashkent); checked every 10 minutes, sent once a day.
digestTimer = setInterval(
  () => app.services.digest().catch((err) => app.log.error({ err }, "digest failed")),
  10 * 60_000,
);
