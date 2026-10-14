import { sql } from "drizzle-orm";
import type { Repo } from "./db/repo.js";
import type { MetricsService } from "./modules/metrics/service.js";
import type { StaffNotifier } from "./telegram/staff.js";

/** Tashkent calendar date and hour (UTC+5, no DST). */
export function tashkentClock(now: Date) {
  const t = new Date(now.getTime() + 5 * 3600_000);
  return { date: t.toISOString().slice(0, 10), hour: t.getUTCHours() };
}

/**
 * Sends the admin digest once per Tashkent day, at or after `hour`. The day is claimed in `settings`
 * with a conditional upsert, so several API instances never send it twice.
 */
export async function maybeSendDigest(
  deps: { repo: Repo; metrics: MetricsService; staff: StaffNotifier; adminLink?: () => Promise<string | null> },
  hour: number,
  now = new Date(),
): Promise<boolean> {
  if (hour < 0) return false;
  const clock = tashkentClock(now);
  if (clock.hour < hour) return false;
  const claimed = (await deps.repo.db.execute(sql`
    insert into settings (key, value, updated_at) values ('digest_sent_for', ${JSON.stringify(clock.date)}::jsonb, now())
    on conflict (key) do update set value = excluded.value, updated_at = now()
    where settings.value <> excluded.value
    returning key`)) as unknown as unknown[];
  if (!claimed.length) return false;
  const link = await deps.adminLink?.().catch(() => null);
  await deps.staff.admins(await deps.metrics.digest(now), link ? [[{ text: "Открыть админку", url: link }]] : []);
  return true;
}
