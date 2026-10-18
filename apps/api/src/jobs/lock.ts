import type { Db } from "../db/client.js";

/** Stable advisory-lock keys (any 64-bit numbers unique within the app). */
export const LOCKS = { migrate: 7_100_001, hourly: 7_100_002, digest: 7_100_003 } as const;

/**
 * Runs `fn` on one instance only: a session-level advisory lock on a reserved connection; other instances
 * skip (return null) instead of waiting. No transaction stays open while `fn` sends hundreds of Telegram
 * messages, so `idle_in_transaction_session_timeout` cannot drop the lock halfway. The lock is released in
 * `finally` (and by PostgreSQL itself if the process dies and the connection closes).
 */
export async function singleton<T>(db: Db, key: number, fn: () => Promise<T>): Promise<T | null> {
  const conn = await db.$client.reserve();
  try {
    const [row] = await conn<{ ok: boolean }[]>`select pg_try_advisory_lock(${key}) as ok`;
    if (!row?.ok) return null;
    try {
      return await fn();
    } finally {
      await conn`select pg_advisory_unlock(${key})`.catch(() => undefined);
    }
  } finally {
    conn.release();
  }
}
