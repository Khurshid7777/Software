import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { eq, inArray } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { jobs } from "../src/db/schema.js";
import { LOCKS, singleton } from "../src/jobs/lock.js";
import { JobQueue } from "../src/jobs/queue.js";

const url = process.env.TEST_DATABASE_URL ?? "postgres://ishonch:ishonch@localhost:5432/ishonch";
const reachable = await postgres(url, { max: 1, connect_timeout: 2 })`select 1`
  .then(() => true)
  .catch(() => false);

describe.skipIf(!reachable)("job queue and singleton lock (integration)", () => {
  let db: ReturnType<typeof createDb>["db"];
  let close: () => Promise<unknown>;
  const KIND = "test_job";

  beforeAll(() => {
    const created = createDb(url);
    db = created.db;
    close = () => created.sql.end();
  });
  beforeEach(async () => {
    await db.delete(jobs).where(inArray(jobs.kind, [KIND, "test_fail"]));
  });
  afterAll(async () => {
    await db.delete(jobs).where(inArray(jobs.kind, [KIND, "test_fail"]));
    await close();
  });

  it("two workers share the queue: every job runs exactly once", async () => {
    const seen: number[] = [];
    const mk = () => {
      const q = new JobQueue(db, { inline: false });
      q.register(KIND, async (p) => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push(p.n as number);
      });
      return q;
    };
    const a = mk();
    const b = mk();
    for (let n = 0; n < 30; n++) await a.enqueue(KIND, { n });
    await Promise.all([a.runOnce(10), b.runOnce(10), a.runOnce(10), b.runOnce(10)]);
    expect(seen.sort((x, y) => x - y)).toEqual([...Array(30).keys()]);
    const left = await db.select().from(jobs).where(eq(jobs.kind, KIND));
    expect(left.every((j) => j.doneAt !== null)).toBe(true);
  });

  it("a worker leaves job kinds it has no handler for", async () => {
    await db.insert(jobs).values({ kind: "test_unknown_kind", payload: {} });
    const q = new JobQueue(db, { inline: false });
    q.register("test_some_other_kind", async () => undefined);
    expect(await q.runOnce()).toBe(0);
    const [j] = await db.select().from(jobs).where(eq(jobs.kind, "test_unknown_kind"));
    expect(j!.attempts).toBe(0);
    await db.delete(jobs).where(eq(jobs.kind, "test_unknown_kind"));
  });

  it("a failing job is retried later with backoff and keeps the error", async () => {
    let tries = 0;
    const q = new JobQueue(db, { inline: false });
    q.register("test_fail", async () => {
      tries++;
      throw new Error("telegram is down");
    });
    await q.enqueue("test_fail", {});
    expect(await q.runOnce()).toBe(1);
    expect(await q.runOnce()).toBe(0); // not due yet
    const [j] = await db.select().from(jobs).where(eq(jobs.kind, "test_fail"));
    expect(j!.attempts).toBe(1);
    expect(j!.lastError).toContain("telegram is down");
    expect(j!.runAt.getTime()).toBeGreaterThan(Date.now() + 20_000);
    await db.update(jobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(jobs.id, j!.id));
    await q.runOnce();
    expect(tries).toBe(2);
  });

  it("inline mode runs the handler right away", async () => {
    const q = new JobQueue(db, { inline: true });
    let ran = false;
    q.register(KIND, async () => void (ran = true));
    await q.enqueue(KIND, {});
    expect(ran).toBe(true);
    expect((await db.select().from(jobs).where(eq(jobs.kind, KIND))).length).toBe(0);
  });

  it("singleton: a second instance skips while the first holds the lock", async () => {
    let release!: () => void;
    const first = singleton(db, LOCKS.hourly + 1000, () => new Promise<string>((r) => (release = () => r("first"))));
    await new Promise((r) => setTimeout(r, 50));
    expect(await singleton(db, LOCKS.hourly + 1000, async () => "second")).toBeNull();
    release();
    expect(await first).toBe("first");
    expect(await singleton(db, LOCKS.hourly + 1000, async () => "third")).toBe("third");
  });
});
