import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { activeMaintenance, createDb, schema } from "@upzy/db";
import type { runProbe } from "@upzy/probes";
import { eq, inArray, sql } from "drizzle-orm";

import { handleCheck } from "../src/roles/prober";

const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

type Probe = typeof runProbe;
const up =
  (responseMs: number): Probe =>
  async () => ({ status: "up", responseMs });
const down: Probe = async () => ({
  status: "down",
  responseMs: null,
  error: "Connection refused",
  errorKind: "refused",
});

run("degraded state and maintenance windows (postgres)", () => {
  const db = createDb(url);
  const {
    organizations,
    workspaces,
    monitors,
    monitorChecks,
    incidents,
    jobs,
    maintenanceWindows,
    maintenanceWindowMonitors,
  } = schema;
  const tag = `mw${Date.now()}`;
  const orgId = `${tag}-org`;
  const T = new Date("2026-10-20T12:00:00Z");
  const at = (minutes: number) => new Date(T.getTime() + minutes * 60_000);
  let ws = "";
  let otherWs = "";
  const incidentIds: string[] = [];

  const make = async (over: Partial<typeof monitors.$inferInsert> = {}, workspaceId = ws) =>
    (
      await db
        .insert(monitors)
        .values({
          workspaceId,
          name: "api",
          type: "http",
          target: "https://example.com",
          interval: 60,
          active: true,
          failureThreshold: 2,
          ...over,
        })
        .returning()
    )[0]!;
  const window = async (
    over: Partial<typeof maintenanceWindows.$inferInsert>,
    monitorIds: string[] = [],
  ) => {
    const w = (
      await db
        .insert(maintenanceWindows)
        .values({
          workspaceId: ws,
          name: "Database upgrade",
          startsAt: at(-60),
          endsAt: at(60),
          allMonitors: false,
          ...over,
        })
        .returning()
    )[0]!;
    if (monitorIds.length)
      await db
        .insert(maintenanceWindowMonitors)
        .values(monitorIds.map((monitorId) => ({ windowId: w.id, monitorId })));
    return w;
  };
  const check = (id: string, probe: Probe, minute = 0) =>
    handleCheck(db, { monitorId: id }, { probe, now: () => at(minute) });
  const state = async (id: string) =>
    (await db.select().from(monitors).where(eq(monitors.id, id)))[0]!;
  const open = async (id: string) => {
    const rows = await db.select().from(incidents).where(eq(incidents.monitorId, id));
    for (const r of rows) incidentIds.push(r.id);
    return rows.filter((r) => r.status !== "resolved");
  };

  beforeAll(async () => {
    await db
      .insert(organizations)
      .values({ id: orgId, name: "t", slug: orgId, createdAt: new Date() });
    ws = (
      await db.insert(workspaces).values({ orgId, name: "w" }).returning({ id: workspaces.id })
    )[0]!.id;
    otherWs = (
      await db.insert(workspaces).values({ orgId, name: "w2" }).returning({ id: workspaces.id })
    )[0]!.id;
  });
  // Windows from one test must not be active for the next one.
  beforeEach(async () => {
    await db
      .delete(maintenanceWindows)
      .where(inArray(maintenanceWindows.workspaceId, [ws, otherWs]));
  });
  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
    for (const id of incidentIds)
      await db.delete(jobs).where(sql`${jobs.payload}::text like ${`%${id}%`}`);
  });

  describe("degraded", () => {
    test("three slow checks in a row make a monitor degraded, without an incident, and one fast check recovers it", async () => {
      const m = await make({ latencyThresholdMs: 500 });
      await check(m.id, up(900));
      await check(m.id, up(900));
      expect((await state(m.id)).lastStatus).toBe("up");
      await check(m.id, up(900));
      expect(await state(m.id)).toMatchObject({ lastStatus: "degraded", consecutiveSlow: 3 });
      await check(m.id, up(1200));
      expect((await state(m.id)).lastStatus).toBe("degraded");
      expect(await open(m.id)).toHaveLength(0);

      await check(m.id, up(120));
      expect(await state(m.id)).toMatchObject({ lastStatus: "up", consecutiveSlow: 0 });
    });

    test("an occasional slow check does not trip it", async () => {
      const m = await make({ latencyThresholdMs: 500 });
      for (const ms of [900, 900, 100, 900, 900, 100]) await check(m.id, up(ms));
      expect((await state(m.id)).lastStatus).toBe("up");
    });

    test("a monitor without a latency threshold is never degraded", async () => {
      const m = await make({ latencyThresholdMs: null });
      for (let i = 0; i < 5; i++) await check(m.id, up(30_000));
      expect((await state(m.id)).lastStatus).toBe("up");
    });

    test("a response exactly at the threshold is not slow", async () => {
      const m = await make({ latencyThresholdMs: 500 });
      for (let i = 0; i < 4; i++) await check(m.id, up(500));
      expect((await state(m.id)).lastStatus).toBe("up");
    });

    test("an outage still opens an incident for a degraded monitor, and recovery starts fresh", async () => {
      const m = await make({ latencyThresholdMs: 500, failureThreshold: 2 });
      for (let i = 0; i < 3; i++) await check(m.id, up(900));
      await check(m.id, down);
      await check(m.id, down);
      expect((await state(m.id)).lastStatus).toBe("down");
      expect(await open(m.id)).toHaveLength(1);
      await check(m.id, up(100));
      expect((await state(m.id)).lastStatus).toBe("up");
      expect(await open(m.id)).toHaveLength(0);
    });
  });

  describe("maintenance", () => {
    test("during a window a monitor that goes down opens no incident, but its checks are still recorded", async () => {
      const m = await make();
      await window({ allMonitors: true });
      await check(m.id, down);
      await check(m.id, down);
      await check(m.id, down);
      expect(await state(m.id)).toMatchObject({ lastStatus: "down", consecutiveFailures: 3 });
      expect(await open(m.id)).toHaveLength(0);
      const history = await db
        .select()
        .from(monitorChecks)
        .where(eq(monitorChecks.monitorId, m.id));
      expect(history.map((r) => r.status)).toEqual(["down", "down", "down"]);
    });

    test("an outage that outlasts the window opens its incident on the first failed check after it", async () => {
      const m = await make();
      await window({ allMonitors: true, startsAt: at(-10), endsAt: at(30) });
      await check(m.id, down, 0);
      await check(m.id, down, 10);
      expect(await open(m.id)).toHaveLength(0);
      await check(m.id, down, 31); // the window is over
      expect(await open(m.id)).toHaveLength(1);
    });

    test("a monitor that recovers during the window opens nothing and stays clean afterwards", async () => {
      const m = await make();
      await window({ allMonitors: true });
      await check(m.id, down);
      await check(m.id, down);
      await check(m.id, up(100));
      expect(await state(m.id)).toMatchObject({ lastStatus: "up", consecutiveFailures: 0 });
      expect(await open(m.id)).toHaveLength(0);
    });

    test("a window for chosen monitors covers only those", async () => {
      const covered = await make({ name: "covered" });
      const other = await make({ name: "other" });
      await window({}, [covered.id]);
      for (const m of [covered, other]) {
        await check(m.id, down);
        await check(m.id, down);
      }
      expect(await open(covered.id)).toHaveLength(0);
      expect(await open(other.id)).toHaveLength(1);
    });

    test("a window in another workspace never covers this monitor", async () => {
      const m = await make();
      const foreign = await make({}, otherWs);
      await window({ workspaceId: otherWs, allMonitors: true });
      await window({ workspaceId: otherWs }, [foreign.id]);
      await check(m.id, down);
      await check(m.id, down);
      expect(await open(m.id)).toHaveLength(1);
    });

    test("a window that has not started, or has ended, suppresses nothing", async () => {
      const early = await make({ name: "early" });
      const late = await make({ name: "late" });
      await window({ allMonitors: true, startsAt: at(60), endsAt: at(120) }); // starts in an hour
      await window({ allMonitors: true, startsAt: at(-120), endsAt: at(-60) }); // ended an hour ago
      for (const m of [early, late]) {
        await check(m.id, down);
        await check(m.id, down);
      }
      expect(await open(early.id)).toHaveLength(1);
      expect(await open(late.id)).toHaveLength(1);
    });

    test("maintenance never closes or hides an incident that is already open", async () => {
      const m = await make();
      await check(m.id, down);
      await check(m.id, down);
      expect(await open(m.id)).toHaveLength(1);
      await window({ allMonitors: true });
      await check(m.id, down); // still down, still the same single incident
      expect(await open(m.id)).toHaveLength(1);
      await check(m.id, up(100)); // recovery is reported as usual
      expect(await open(m.id)).toHaveLength(0);
    });

    test("the window ending last is the one reported when two overlap", async () => {
      const m = await make();
      const short = await window({ name: "short", allMonitors: true, endsAt: at(10) });
      const long = await window({ name: "long", allMonitors: true, endsAt: at(90) });
      const active = await activeMaintenance(db, [m.id], T);
      expect(active.get(m.id)).toMatchObject({ id: long.id, name: "long" });
      expect(active.get(m.id)?.id).not.toBe(short.id);
      expect((await activeMaintenance(db, [m.id], at(-90))).size).toBe(0);
    });

    test("windows are removed with their monitors and their workspace", async () => {
      const m = await make();
      const w = await window({}, [m.id]);
      await db.delete(monitors).where(inArray(monitors.id, [m.id]));
      const links = await db
        .select()
        .from(maintenanceWindowMonitors)
        .where(eq(maintenanceWindowMonitors.windowId, w.id));
      expect(links).toHaveLength(0);
    });
  });
});
