import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { loadConfig } from "../config.js";
import { LOCKS } from "../jobs/lock.js";
import { createDb } from "./client.js";

const { db, sql } = createDb(loadConfig().DATABASE_URL);
// Several API replicas start at once: one migrates, the others wait for the lock and then find nothing to do.
const lock = await sql.reserve();
await lock`select pg_advisory_lock(${LOCKS.migrate})`;
try {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
} finally {
  await lock`select pg_advisory_unlock(${LOCKS.migrate})`;
  lock.release();
}
await sql.end();
console.log("migrations applied");
