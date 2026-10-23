import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  checkQueue,
  createDb,
  offeredRegions,
  regionalVerdict,
  regionsOf,
  schema,
  workerRegion,
} from "@upzy/db";
import type { runProbe } from "@upzy/probes";
import { and, eq, sql } from "drizzle-orm";

import { handleCheck } from "../src/roles/prober";
import { scheduleDue } from "../src/roles/scheduler";

type Probe = typeof runProbe;
const up: Probe = async () => ({ status: "up", responseMs: 40 });
const down: Probe = async () => ({
  status: "down",
  responseMs: null,
  error: "Connection refused",
  errorKind: "refused",
});

describe("regions (no database)", () => {
  test("the main server is always offered first, extras are cleaned up and deduplicated", () => {
    expect(offeredRegions({})).toEqual(["local"]);
    expect(
      offeredRegions({ PROBE_REGIONS: " EU-West, us-east ,eu-west,bad name,,x,local,primary" }),
    ).toEqual(["local", "eu-west", "us-east"]);
  });

  test("a process runs checks for its WORKER_REGION, or the main server", () => {
    expect(workerRegion({})).toBe("local");
    expect(workerRegion({ WORKER_REGION: " EU-West " })).toBe("eu-west");
    // Older installs named the main server "primary".
    expect(workerRegion({ WORKER_REGION: "primary" })).toBe("local");
  });

  test("the main server keeps the original queue name; other regions get their own", () => {
    expect(checkQueue("local")).toBe("check");
    expect(checkQueue("eu-west")).toBe("check.eu-west");
  });

  test("a monitor without regions is checked from the main server", () => {
    expect(regionsOf({ regions: [] })).toEqual(["local"]);
    expect(regionsOf({ regions: ["eu-west", "us-east"] })).toEqual(["eu-west", "us-east"]);
  });

  const now = new Date("2026-10-23T12:00:00Z");
  const ago = (s: number) => new Date(now.getTime() - s * 1000);
  const opts = { failureThreshold: 2, intervalSeconds: 60, now };

  test("more than half of the regions must be failing", () => {
    const s = (region: string, consecutiveFailures: number) => ({
      region,
      consecutiveFailures,
      lastCheckAt: ago(30),
    });
    expect(regionalVerdict([s("a", 2), s("b", 0), s("c", 0)], opts).down).toBe(false);
    expect(regionalVerdict([s("a", 2), s("b", 3), s("c", 0)], opts)).toMatchObject({
      down: true,
      failing: ["a", "b"],
      considered: 3,
    });
    // Two regions: both must agree.
    expect(regionalVerdict([s("a", 2), s("b", 0)], opts).down).toBe(false);
    expect(regionalVerdict([s("a", 2), s("b", 2)], opts).down).toBe(true);
    // One failing check is below the threshold.
    expect(regionalVerdict([s("a", 1), s("b", 1)], opts).down).toBe(false);
  });

  test("a region that has gone quiet is left out instead of counted either way", () => {
    const states = [
      { region: "a", consecutiveFailures: 2, lastCheckAt: ago(30) },
      { region: "b", consecutiveFailures: 0, lastCheckAt: ago(3600) },
    ];
    expect(regionalVerdict(states, opts)).toMatchObject({ down: true, considered: 1 });
    // And nothing reporting at all is not an outage.
    expect(regionalVerdict([states[1]!], opts)).toMatchObject({ down: false, considered: 0 });
  });
});

const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run("checking from several regions (postgres)", () => {
  const db = createDb(url);
  const {
    organizations,
    workspaces,
    monitors,
    monitorChecks,
    incidents,
    jobs,
    monitorRegionState,
  } = schema;
  const orgId = `rg-org-${Date.now()}`;
  let ws = "";

  beforeAll(async () => {
    await db
      .insert(organizations)
      .values({ id: orgId, name: "t", slug: orgId, createdAt: new Date() });
    ws = (
      await db.insert(workspaces).values({ orgId, name: "w" }).returning({ id: workspaces.id })
    )[0]!.id;
  });
  afterAll(async () => {
    await db
      .delete(jobs)
      .where(
        sql`payload->>'monitorId' in (select id::text from monitors where workspace_id = ${ws})`,
      );
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  const make = async (regions: string[], over: Partial<typeof monitors.$inferInsert> = {}) =>
    (
      await db
        .insert(monitors)
        .values({
          workspaceId: ws,
          name: "api",
          type: "http",
          target: "https://example.com",
          interval: 60,
          active: true,
          failureThreshold: 2,
          regions,
          ...over,
        })
        .returning()
    )[0]!;
  const open = async (monitorId: string) =>
    db
      .select()
      .from(incidents)
      .where(and(eq(incidents.monitorId, monitorId), eq(incidents.status, "open")));
  const check = (monitorId: string, region: string, probe: Probe) =>
    handleCheck(db, { monitorId, region }, { probe });

  test("the scheduler queues one job per region, each on that region's queue", async () => {
    const m = await make(["local", "eu-west"], { nextRun: new Date(Date.now() - 1000) });
    const plain = await make([], { nextRun: new Date(Date.now() - 1000) });
    await scheduleDue(db, 500);
    const queued = await db.select().from(jobs);
    const mine = queued.filter((j) => (j.payload as { monitorId?: string }).monitorId === m.id);
    expect(mine.map((j) => j.queue).sort()).toEqual(["check", "check.eu-west"]);
    expect(mine.map((j) => (j.payload as { region: string }).region).sort()).toEqual([
      "eu-west",
      "local",
    ]);
    const single = queued.filter(
      (j) => (j.payload as { monitorId?: string }).monitorId === plain.id,
    );
    expect(single.map((j) => j.queue)).toEqual(["check"]);
  });

  test("one region failing is not an outage when the others see the site", async () => {
    const m = await make(["local", "eu-west", "us-east"]);
    for (let i = 0; i < 3; i++) {
      await check(m.id, "eu-west", down);
      await check(m.id, "local", up);
      await check(m.id, "us-east", up);
    }
    expect(await open(m.id)).toEqual([]);
    const [row] = await db.select().from(monitors).where(eq(monitors.id, m.id));
    expect(row!.lastStatus).toBe("up");
    const states = await db
      .select()
      .from(monitorRegionState)
      .where(eq(monitorRegionState.monitorId, m.id));
    expect(Object.fromEntries(states.map((s) => [s.region, s.lastStatus]))).toEqual({
      "eu-west": "down",
      local: "up",
      "us-east": "up",
    });
  });

  test("most regions failing opens one incident naming them, and recovery resolves it", async () => {
    const m = await make(["local", "eu-west", "us-east"]);
    for (let i = 0; i < 2; i++) {
      await check(m.id, "local", down);
      await check(m.id, "eu-west", down);
      await check(m.id, "us-east", up);
    }
    const [inc] = await open(m.id);
    expect(inc!.title).toContain("api is down from eu-west, local");
    expect(await open(m.id)).toHaveLength(1);

    await check(m.id, "local", up);
    await check(m.id, "eu-west", up);
    expect(await open(m.id)).toEqual([]);
  });

  test("each check is stored with the region it ran in", async () => {
    const m = await make(["eu-west"]);
    await check(m.id, "eu-west", up);
    const rows = await db.select().from(monitorChecks).where(eq(monitorChecks.monitorId, m.id));
    expect(rows.map((r) => r.region)).toEqual(["eu-west"]);
  });

  test("a job for a region the monitor no longer uses is dropped", async () => {
    const m = await make(["us-east"]);
    await check(m.id, "eu-west", down);
    await check(m.id, "local", down);
    const rows = await db.select().from(monitorChecks).where(eq(monitorChecks.monitorId, m.id));
    expect(rows).toEqual([]);
  });

  test("a monitor with no regions behaves exactly as before", async () => {
    const m = await make([]);
    await check(m.id, "local", down);
    expect(await open(m.id)).toEqual([]);
    await check(m.id, "local", down);
    const [inc] = await open(m.id);
    expect(inc!.title).toBe("api is down: Connection refused");
    const states = await db
      .select()
      .from(monitorRegionState)
      .where(eq(monitorRegionState.monitorId, m.id));
    expect(states).toEqual([]);
  });

  test("a silent region doesn't hide an outage seen by the one that is reporting", async () => {
    const m = await make(["local", "eu-west"]);
    // eu-west reported long ago and then went quiet.
    await db.insert(monitorRegionState).values({
      monitorId: m.id,
      region: "eu-west",
      consecutiveFailures: 0,
      lastStatus: "up",
      lastCheckAt: new Date(Date.now() - 3_600_000),
    });
    await check(m.id, "local", down);
    await check(m.id, "local", down);
    expect(await open(m.id)).toHaveLength(1);
  });
});
