import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";

import { createDb, schema, type Db } from "@upzy/db";
import { eq, inArray } from "drizzle-orm";

import { scheduleDue } from "../src/roles/scheduler";

setDefaultTimeout(30_000);

const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run("scheduler (postgres)", () => {
  const db = createDb(url);
  const { organizations, workspaces, monitors, jobs } = schema;
  const orgId = `sc-org-${Date.now()}`;
  let ws = "";
  const mine: string[] = [];

  beforeAll(async () => {
    await db
      .insert(organizations)
      .values({ id: orgId, name: "t", slug: orgId, createdAt: new Date() });
    ws = (
      await db.insert(workspaces).values({ orgId, name: "w" }).returning({ id: workspaces.id })
    )[0]!.id;
  });
  afterAll(async () => {
    if (mine.length)
      await db.delete(jobs).where(
        inArray(
          jobs.dedupeKey,
          mine.map((id) => `${id}:local`),
        ),
      );
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  async function make(count: number, over: Partial<typeof monitors.$inferInsert> = {}) {
    const rows = await db
      .insert(monitors)
      .values(
        Array.from({ length: count }, (_, i) => ({
          workspaceId: ws,
          name: `m${i}`,
          type: "http" as const,
          target: "https://example.com",
          interval: 60,
          active: true,
          // Long overdue, so these are the ones a batch picks first.
          nextRun: new Date(Date.now() - 86_400_000),
          ...over,
        })),
      )
      .returning({ id: monitors.id });
    mine.push(...rows.map((r) => r.id));
    return rows.map((r) => r.id);
  }

  /** Counts the statements a scheduling pass sends, by counting what it asks the transaction to start. */
  function counting(real: Db) {
    const counter = { statements: 0 };
    const wrap = (tx: Db): Db =>
      new Proxy(tx, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (["select", "update", "insert", "delete", "execute"].includes(String(prop)))
            counter.statements++;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    const proxy = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "transaction")
          return (fn: (tx: Db) => unknown, cfg?: unknown) =>
            target.transaction((tx) => fn(wrap(tx as unknown as Db)) as never, cfg as never);
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return { db: proxy as Db, counter };
  }

  test("a batch of due monitors is scheduled in a handful of statements, however many there are", async () => {
    const few = counting(db);
    await make(3);
    await scheduleDue(few.db, 3);
    const many = counting(db);
    await make(150);
    await scheduleDue(many.db, 150);
    expect(many.counter.statements).toBe(few.counter.statements);
    expect(many.counter.statements).toBeLessThanOrEqual(3);
  });

  test("every due monitor gets one job and its next run moved forward by its own interval", async () => {
    const a = (await make(1, { interval: 60 }))[0]!;
    const b = (await make(1, { interval: 3600 }))[0]!;
    const c = (await make(1, { interval: 300, regions: ["eu-west", "us-east"] }))[0]!;
    await scheduleDue(db, 500);
    const queued = (await db.select().from(jobs)).filter((j) =>
      [a, b, c].includes((j.payload as { monitorId: string }).monitorId),
    );
    const byMonitor = (id: string) =>
      queued.filter((j) => (j.payload as { monitorId: string }).monitorId === id);
    expect(byMonitor(a).map((j) => j.queue)).toEqual(["check"]);
    expect(byMonitor(b)).toHaveLength(1);
    expect(
      byMonitor(c)
        .map((j) => j.queue)
        .sort(),
    ).toEqual(["check.eu-west", "check.us-east"]);

    const next = async (id: string) =>
      (
        await db.select({ n: monitors.nextRun }).from(monitors).where(eq(monitors.id, id))
      )[0]!.n.getTime() - Date.now();
    expect(Math.abs((await next(a)) - 60_000)).toBeLessThan(5_000);
    expect(Math.abs((await next(b)) - 3_600_000)).toBeLessThan(5_000);
    expect(Math.abs((await next(c)) - 300_000)).toBeLessThan(5_000);
  });

  test("a monitor whose check is still queued is not queued twice", async () => {
    const [id] = await make(1, { interval: 60 });
    await scheduleDue(db, 500);
    await db
      .update(monitors)
      .set({ nextRun: new Date(Date.now() - 1000) })
      .where(eq(monitors.id, id!));
    await scheduleDue(db, 500);
    const queued = (await db.select().from(jobs)).filter(
      (j) => (j.payload as { monitorId: string }).monitorId === id,
    );
    expect(queued).toHaveLength(1);
  });

  test("monitors that are paused are left alone", async () => {
    const [id] = await make(1, { active: false });
    await scheduleDue(db, 500);
    expect(
      (await db.select().from(jobs)).filter(
        (j) => (j.payload as { monitorId: string }).monitorId === id,
      ),
    ).toHaveLength(0);
  });
});
