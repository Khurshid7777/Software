import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { jobs } from "../db/schema.js";

export type JobHandler = (payload: Record<string, unknown>) => Promise<unknown>;

export const MAX_ATTEMPTS = 5;
/** How long a claimed job stays invisible to other workers; a crashed worker's job is retried after it. */
const LOCK_SECONDS = 300;

/**
 * Background jobs in PostgreSQL. Workers claim due jobs with FOR UPDATE SKIP LOCKED, so several API
 * instances share the work without double-processing. Failures retry with backoff (30 s, 2, 8, 32 min).
 *
 * `inline` runs a job right inside `enqueue` (tests, local dev) — same handlers, no worker needed. A job
 * deferred to a later `runAt` (quiet hours) is always stored, so it waits for a worker even then.
 */
export class JobQueue {
  private handlers = new Map<string, JobHandler>();
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> = Promise.resolve();

  constructor(
    private db: Db,
    private opts: { inline: boolean; logger?: { error: (obj: object, msg: string) => void } },
  ) {}

  register(kind: string, handler: JobHandler) {
    this.handlers.set(kind, handler);
  }

  async enqueue(kind: string, payload: Record<string, unknown>, runAt?: Date | null) {
    if (runAt && runAt.getTime() > Date.now()) {
      await this.db.insert(jobs).values({ kind, payload, runAt });
      return;
    }
    if (this.opts.inline) {
      try {
        await this.handlers.get(kind)?.(payload);
      } catch (err) {
        this.opts.logger?.error({ err, kind }, "inline job failed");
      }
      return;
    }
    await this.db.insert(jobs).values({ kind, payload });
  }

  /** Claims and runs up to `limit` due jobs; returns how many ran. */
  async runOnce(limit = 20): Promise<number> {
    const claimed = (await this.db.execute(sql`
      update ${jobs} set locked_until = now() + make_interval(secs => ${LOCK_SECONDS}), attempts = attempts + 1
      where id in (
        select id from ${jobs}
        where done_at is null and run_at <= now() and attempts < ${MAX_ATTEMPTS}
          and (locked_until is null or locked_until < now())
        order by run_at
        limit ${limit}
        for update skip locked
      )
      returning id, kind, payload, attempts`)) as unknown as Array<{ id: number; kind: string; payload: Record<string, unknown>; attempts: number }>;

    for (const job of claimed) {
      const handler = this.handlers.get(job.kind);
      try {
        if (!handler) throw new Error(`no handler for job kind ${job.kind}`);
        await handler(job.payload);
        await this.db.execute(sql`update ${jobs} set done_at = now(), locked_until = null where id = ${job.id}`);
      } catch (err) {
        const backoff = 30 * 4 ** (job.attempts - 1);
        this.opts.logger?.error({ err, kind: job.kind, attempts: job.attempts }, "job failed");
        await this.db.execute(sql`
          update ${jobs} set locked_until = null, last_error = ${String(err).slice(0, 500)},
            run_at = now() + make_interval(secs => ${backoff})
          where id = ${job.id}`);
      }
    }
    return claimed.length;
  }

  /** Polls every `intervalMs`; a full batch is followed immediately by the next one. */
  start(intervalMs = 2000) {
    const tick = async () => {
      try {
        while ((await this.runOnce()) === 20);
      } catch (err) {
        this.opts.logger?.error({ err }, "job worker tick failed");
      }
    };
    this.timer = setInterval(() => {
      this.running = this.running.then(tick);
    }, intervalMs);
  }

  /** Stops polling and waits for the batch in progress (graceful shutdown). */
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  /** Done jobs are kept a week for debugging, then removed. */
  async cleanup(days = 7) {
    await this.db.execute(sql`delete from ${jobs} where done_at < now() - make_interval(days => ${days})`);
    // Jobs that gave up after MAX_ATTEMPTS: kept a month for investigation (last_error), then removed.
    await this.db.execute(sql`delete from ${jobs} where done_at is null and attempts >= ${MAX_ATTEMPTS} and created_at < now() - interval '30 days'`);
  }

  /** Jobs that gave up (for the admin dashboard and the morning digest). */
  async failedCount(): Promise<number> {
    const rows = (await this.db.execute(sql`select count(*)::int as n from ${jobs} where done_at is null and attempts >= ${MAX_ATTEMPTS}`)) as unknown as Array<{ n: number }>;
    return rows[0]?.n ?? 0;
  }
}
