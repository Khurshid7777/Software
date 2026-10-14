import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export function createDb(url: string) {
  const sql = postgres(url, {
    max: 10,
    // Thresholds for the pg_trgm operators (% and <%), which, unlike similarity() calls, can use GIN indexes.
    connection: { "pg_trgm.similarity_threshold": "0.4", "pg_trgm.word_similarity_threshold": "0.4" },
    onnotice: () => undefined, // "already exists, skipping" from migrations
  });
  return { db: drizzle(sql, { schema }), sql };
}

export type Db = ReturnType<typeof createDb>["db"];
