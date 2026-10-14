import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";

/** Stable advisory-lock keys (any 64-bit numbers unique within the app). */
export const LOCKS = { migrate: 7_100_001, hourly: 7_100_002, digest: 7_100_003 } as const;

/**
 * Runs `fn` on one instance only: a transaction-scoped advisory lock is held while it runs; other
 * instances skip (return null) instead of waiting. The lock is released on commit, even if `fn` throws.
 */
export async function singleton<T>(db: Db, key: number, fn: () => Promise<T>): Promise<T | null> {
  return db.transaction(async (tx) => {
    const [row] = (await tx.execute(sql`select pg_try_advisory_xact_lock(${key}) as ok`)) as unknown as [{ ok: boolean }];
    if (!row?.ok) return null;
    return fn();
  });
}
