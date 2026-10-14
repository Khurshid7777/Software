import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";

const config = loadConfig();
const { db, sql } = createDb(config.DATABASE_URL);
const app = await buildApp({ config, db });

let expiryTimer: NodeJS.Timeout | undefined;
const shutdown = async () => {
  clearInterval(expiryTimer);
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
