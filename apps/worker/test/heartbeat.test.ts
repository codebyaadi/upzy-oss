import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { encryptJson } from "@upzy/crypto";
import { createDb, schema } from "@upzy/db";
import type { ProbeTarget } from "@upzy/probes";
import { and, eq, sql } from "drizzle-orm";

import { heartbeatResult } from "../src/heartbeat";
import { handleCheck } from "../src/roles/prober";

const T0 = new Date("2026-10-17T10:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const base = (over: object = {}) => ({
  config: { expectEvery: 3600, grace: 300 },
  lastPingAt: null as Date | null,
  lastFailAt: null as Date | null,
  heartbeatSince: T0,
  createdAt: T0,
  ...over,
});

describe("heartbeat result", () => {
  test("a new monitor isn't late until its first period plus grace is over", () => {
    expect(heartbeatResult(base(), at(30)).status).toBe("up");
    expect(heartbeatResult(base(), at(64)).status).toBe("up");
    const late = heartbeatResult(base(), at(66));
    expect(late).toMatchObject({ status: "down", errorKind: "heartbeat" });
    expect(late.error).toBe(
      "No ping for 66 minutes (expected every 60 minutes, plus 5 minutes grace)",
    );
  });

  test("each ping restarts the clock", () => {
    expect(heartbeatResult(base({ lastPingAt: at(60) }), at(120)).status).toBe("up");
    expect(heartbeatResult(base({ lastPingAt: at(60) }), at(130)).status).toBe("down");
  });

  test("a reported failure is down at once, until a later ping clears it", () => {
    const failed = base({ lastPingAt: at(10), lastFailAt: at(20) });
    expect(heartbeatResult(failed, at(21))).toMatchObject({
      status: "down",
      error: "The job reported a failure",
    });
    expect(heartbeatResult({ ...failed, lastPingAt: at(25) }, at(26)).status).toBe("up");
    // A failure from before the monitor was resumed doesn't count.
    expect(
      heartbeatResult(base({ lastFailAt: at(-100), heartbeatSince: at(0) }), at(1)).status,
    ).toBe("up");
  });

  test("daily jobs: no ping for 25 hours is fine with a 2 hour grace, 27 is not", () => {
    const daily = base({ config: { expectEvery: 86_400, grace: 7200 }, lastPingAt: T0 });
    expect(heartbeatResult(daily, at(25 * 60)).status).toBe("up");
    expect(heartbeatResult(daily, at(27 * 60)).status).toBe("down");
  });
});

const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run("monitors end to end (postgres)", () => {
  const db = createDb(url);
  const { organizations, workspaces, monitors, monitorChecks, incidents, jobs } = schema;
  const tag = `hb${Date.now()}`;
  const orgId = `${tag}-org`;
  const KEY = Buffer.alloc(32, 7).toString("base64");
  let ws = "";
  const make = async (over: Partial<typeof monitors.$inferInsert>) =>
    (
      await db
        .insert(monitors)
        .values({
          workspaceId: ws,
          name: "m",
          type: "heartbeat",
          target: "heartbeat",
          interval: 60,
          active: true,
          failureThreshold: 1,
          config: { expectEvery: 3600, grace: 300 },
          heartbeatSince: T0,
          createdAt: T0,
          ...over,
        })
        .returning()
    )[0]!;
  const rows = (id: string) =>
    db
      .select()
      .from(monitorChecks)
      .where(eq(monitorChecks.monitorId, id))
      .orderBy(monitorChecks.id);
  const open = (id: string) =>
    db
      .select()
      .from(incidents)
      .where(and(eq(incidents.monitorId, id), sql`${incidents.status} <> 'resolved'`));

  beforeAll(async () => {
    await db
      .insert(organizations)
      .values({ id: orgId, name: "t", slug: orgId, createdAt: new Date() });
    ws = (
      await db.insert(workspaces).values({ orgId, name: "w" }).returning({ id: workspaces.id })
    )[0]!.id;
  });
  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(jobs).where(sql`${jobs.payload}::text like ${`%${ws}%`}`);
  });

  test("a late heartbeat opens an incident once, stays quiet while it is still late, and a ping resolves it", async () => {
    const m = await make({ name: "nightly-sync" });
    const check = (min: number) => handleCheck(db, { monitorId: m.id }, { now: () => at(min) });

    await check(30); // on time: first check records the state change from unknown to up
    expect((await open(m.id)).length).toBe(0);
    expect((await rows(m.id)).map((r) => r.status)).toEqual(["up"]);

    await check(40); // still on time: no new history row
    expect((await rows(m.id)).length).toBe(1);

    await check(70); // late
    expect((await open(m.id)).length).toBe(1);
    expect((await open(m.id))[0]!.title).toContain("No ping for 70 minutes");
    await check(71);
    await check(72); // still late: one incident, no row spam
    expect((await open(m.id)).length).toBe(1);
    expect((await rows(m.id)).map((r) => r.status)).toEqual(["up", "down"]);
    expect((await rows(m.id)).find((r) => r.status === "down")!.errorKind).toBe("heartbeat");

    // The job pings: the next check resolves it.
    await db
      .update(monitors)
      .set({ lastPingAt: at(73) })
      .where(eq(monitors.id, m.id));
    await check(74);
    expect((await open(m.id)).length).toBe(0);
    expect((await rows(m.id)).map((r) => r.status)).toEqual(["up", "down", "up"]);
    expect((await db.select().from(monitors).where(eq(monitors.id, m.id)))[0]!.lastStatus).toBe(
      "up",
    );
  });

  test("a failure report opens an incident immediately", async () => {
    const m = await make({ name: "backup-job", lastPingAt: at(5), lastFailAt: at(10) });
    await handleCheck(db, { monitorId: m.id }, { now: () => at(11) });
    expect((await open(m.id))[0]!.title).toContain("The job reported a failure");
  });

  test("a paused heartbeat is not checked", async () => {
    const m = await make({ name: "paused", active: false });
    await handleCheck(db, { monitorId: m.id }, { now: () => at(500) });
    expect((await rows(m.id)).length).toBe(0);
  });

  test("secrets are decrypted for the probe, and a probe error never stores them", async () => {
    const m = await make({
      name: "api",
      type: "http",
      target: "https://api.example.com/health",
      failureThreshold: 1,
      config: { headers: { Authorization: "Bearer {{secret.TOKEN}}" } },
      secretsEncrypted: encryptJson({ TOKEN: "tok_secret_value" }, KEY),
    });
    let seen: ProbeTarget | undefined;
    await handleCheck(
      db,
      { monitorId: m.id },
      {
        encryptionKey: KEY,
        probe: async (t) => {
          seen = t;
          return { status: "up", responseMs: 5 };
        },
      },
    );
    expect(seen?.secrets).toEqual({ TOKEN: "tok_secret_value" });
    expect(seen?.config.headers).toEqual({ Authorization: "Bearer {{secret.TOKEN}}" });
    const all = JSON.stringify(await rows(m.id));
    expect(all).not.toContain("tok_secret_value");
    // Without the key the monitor still runs; it just has no secrets (and its probe reports the missing one).
    let without: ProbeTarget | undefined;
    await handleCheck(
      db,
      { monitorId: m.id },
      { probe: async (t) => ((without = t), { status: "up", responseMs: 1 }) },
    );
    expect(without?.secrets).toBeUndefined();
  });
});
