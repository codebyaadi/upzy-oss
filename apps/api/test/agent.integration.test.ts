import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createAuth } from "@upzy/auth/server";
import { encryptJson } from "@upzy/crypto";
import { RESULT_QUEUE, checkQueue, createDb, schema } from "@upzy/db";
import { claim, enqueue } from "@upzy/queue";
import { and, eq } from "drizzle-orm";

import { createApp } from "../src/app";
import { newAgentToken } from "../src/lib/agent-auth";

// Real Postgres. Needs: DATABASE_URL=... bun test
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

// The worker is a separate program; loading its code by a computed path keeps it out of this package's type-check
// while the test still drives the real thing.
const workerModule = (name: string) => import(`${"../../worker/src/roles/"}${name}`);

run("probe agent API (postgres)", () => {
  process.env.BETTER_AUTH_SECRET ??= "integration-test-secret-integration-test-secret";
  const db = createDb(url);
  const { organizations, workspaces, monitors, probeAgents, monitorChecks, incidents, jobs } =
    schema;
  const key = Buffer.alloc(32, 4).toString("base64");
  const auth = createAuth(db, {
    sendEmail: async () => {},
    signup: { mode: "open", allowedEmails: [], allowedDomains: [] },
  });
  const app = createApp({
    db,
    auth,
    webOrigin: "http://localhost:3001",
    encryptionKey: key,
    rateLimit: { rules: [{ match: () => true, bucket: "t", max: Infinity, windowMs: 1 }] },
  });
  const tag = `ag${Date.now()}`;
  const orgId = `${tag}-org`;
  let ws = "";
  const previous = process.env.PROBE_REGIONS;

  const call = async (token: string | null, path: string, body: unknown) => {
    const res = await app.handle(
      new Request(`http://localhost/agent${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, body: res.status === 204 ? null : ((await res.json()) as any) };
  };

  const makeAgent = async (region: string, over: Partial<typeof probeAgents.$inferInsert> = {}) => {
    const t = newAgentToken();
    await db.insert(probeAgents).values({
      name: `${tag}-${region}`,
      region,
      hashedToken: t.hashedToken,
      prefix: t.prefix,
      ...over,
    });
    return t.token;
  };

  const makeMonitor = async (over: Partial<typeof monitors.$inferInsert> = {}) =>
    (
      await db
        .insert(monitors)
        .values({
          workspaceId: ws,
          name: `${tag}-m`,
          type: "http",
          target: "https://example.com",
          interval: 60,
          active: true,
          failureThreshold: 1,
          regions: ["eu-west"],
          ...over,
        })
        .returning()
    )[0]!;

  /** What the scheduler does for a due monitor: one job in the region's queue. */
  const schedule = (monitorId: string, region = "eu-west") =>
    enqueue(db, checkQueue(region), { monitorId, region });

  beforeAll(async () => {
    process.env.PROBE_REGIONS = "eu-west,us-east";
    // Checks left queued by earlier runs would take the first slots of a pull.
    for (const r of ["eu-west", "us-east"])
      await db.delete(jobs).where(eq(jobs.queue, checkQueue(r)));
    await db
      .insert(organizations)
      .values({ id: orgId, name: "t", slug: orgId, createdAt: new Date() });
    ws = (
      await db.insert(workspaces).values({ orgId, name: "w" }).returning({ id: workspaces.id })
    )[0]!.id;
  });
  afterAll(async () => {
    if (previous === undefined) delete process.env.PROBE_REGIONS;
    else process.env.PROBE_REGIONS = previous;
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(probeAgents).where(eq(probeAgents.name, `${tag}-eu-west`));
    await db.delete(probeAgents).where(eq(probeAgents.name, `${tag}-us-east`));
  });

  test("a fake agent drives a full check: hello, pull, run, report, and the server opens the incident", async () => {
    const token = await makeAgent("eu-west");
    const m = await makeMonitor();

    const hello = await call(token, "/hello", {
      version: "0.0.1-test",
      os: "linux",
      arch: "amd64",
    });
    expect(hello.status).toBe(200);
    expect(hello.body).toMatchObject({ region: "eu-west", protocol: 1 });

    await schedule(m.id);
    const pulled = await call(token, "/jobs/pull", { max: 50 });
    expect(pulled.status).toBe(200);
    const mine = pulled.body.jobs.filter((j: any) => j.monitorId === m.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ type: "http", target: "https://example.com" });

    // The agent measures; it reports "down" and does not decide anything else.
    const reported = await call(token, `/jobs/${mine[0].jobId}/result`, {
      status: "down",
      responseMs: 10_000,
      error: "Request timed out",
      errorKind: "timeout",
    });
    expect(reported.status).toBe(202);
    // The check job is gone and the result waits for the worker.
    expect(await db.select().from(jobs).where(eq(jobs.id, mine[0].jobId))).toHaveLength(0);

    // The worker's side, as it runs in production.
    const { handleResult } = await workerModule("probe-results");
    const waiting = (await claim(db, RESULT_QUEUE, 50)).filter(
      (j) => (j.payload as any).monitorId === m.id,
    );
    expect(waiting).toHaveLength(1);
    await handleResult(db, waiting[0]!.payload);

    const [after] = await db.select().from(monitors).where(eq(monitors.id, m.id));
    expect(after!.lastStatus).toBe("down");
    const [check] = await db.select().from(monitorChecks).where(eq(monitorChecks.monitorId, m.id));
    expect(check).toMatchObject({ status: "down", region: "eu-west", errorKind: "timeout" });
    const open = await db.select().from(incidents).where(eq(incidents.monitorId, m.id));
    expect(open).toHaveLength(1);
    expect(open[0]!.title).toContain("Request timed out");
    // And the rollup the dashboards read.
    const rolled = await db.execute(
      `select total, up from monitor_check_rollups where monitor_id = '${m.id}'` as any,
    );
    expect([...rolled][0]).toMatchObject({ total: 1, up: 0 });
  });

  test("a later success from the agent resolves the incident through the same path", async () => {
    const token = await makeAgent("us-east");
    const m = await makeMonitor({ regions: ["us-east"] });
    const { handleResult } = await workerModule("probe-results");
    for (const status of ["down", "up"] as const) {
      await schedule(m.id, "us-east");
      const job = (await call(token, "/jobs/pull", { max: 20 })).body.jobs.find(
        (j: any) => j.monitorId === m.id,
      );
      await call(token, `/jobs/${job.jobId}/result`, {
        status,
        responseMs: status === "up" ? 80 : null,
      });
      for (const r of (await claim(db, RESULT_QUEUE, 50)).filter(
        (j) => (j.payload as any).monitorId === m.id,
      ))
        await handleResult(db, r.payload);
    }
    const [inc] = await db.select().from(incidents).where(eq(incidents.monitorId, m.id));
    expect(inc!.status).toBe("resolved");
  });

  test("monitor secrets reach the agent for the length of the check, and only then", async () => {
    const token = await makeAgent("eu-west");
    const m = await makeMonitor({
      secretsEncrypted: encryptJson({ API_TOKEN: "s3cret-value" }, key),
    });
    await schedule(m.id);
    const job = (await call(token, "/jobs/pull", { max: 20 })).body.jobs.find(
      (j: any) => j.monitorId === m.id,
    );
    expect(job.secrets).toEqual({ API_TOKEN: "s3cret-value" });
    const [row] = await db.select().from(monitors).where(eq(monitors.id, m.id));
    expect(JSON.stringify(row!.config)).not.toContain("s3cret-value");
  });

  test("an agent only gets its own region's checks and can only answer what it was handed", async () => {
    const eu = await makeAgent("eu-west");
    const us = await makeAgent("us-east");
    const m = await makeMonitor();
    await schedule(m.id);

    const stolen = await call(us, "/jobs/pull", { max: 50 });
    expect(stolen.body.jobs.filter((j: any) => j.monitorId === m.id)).toHaveLength(0);

    const job = (await call(eu, "/jobs/pull", { max: 50 })).body.jobs.find(
      (j: any) => j.monitorId === m.id,
    );
    const ok = { status: "up", responseMs: 50 };
    // Another region's agent cannot answer it, a made-up id cannot be answered, and neither can a done job twice.
    expect((await call(us, `/jobs/${job.jobId}/result`, ok)).status).toBe(404);
    expect((await call(eu, "/jobs/3f1c9c0e-0000-4000-8000-000000000000/result", ok)).status).toBe(
      404,
    );
    expect((await call(eu, `/jobs/${job.jobId}/result`, ok)).status).toBe(202);
    expect((await call(eu, `/jobs/${job.jobId}/result`, ok)).status).toBe(404);
  });

  test("a malformed result is refused and the check stays waiting", async () => {
    const eu = await makeAgent("eu-west");
    const m = await makeMonitor();
    await schedule(m.id);
    const job = (await call(eu, "/jobs/pull", { max: 50 })).body.jobs.find(
      (j: any) => j.monitorId === m.id,
    );
    expect((await call(eu, `/jobs/${job.jobId}/result`, { status: "melting" })).status).toBe(400);
    expect(
      (await call(eu, `/jobs/${job.jobId}/result`, { status: "up", responseMs: -5 })).status,
    ).toBe(400);
    const [still] = await db.select().from(jobs).where(eq(jobs.id, job.jobId));
    expect(still!.state).toBe("running");
  });

  test("paused monitors and kinds an agent cannot run are dropped instead of handed out", async () => {
    const eu = await makeAgent("eu-west");
    const paused = await makeMonitor({ active: false });
    const beat = await makeMonitor({ type: "heartbeat", target: "heartbeat" });
    await schedule(paused.id);
    await schedule(beat.id);
    const pulled = (await call(eu, "/jobs/pull", { max: 50 })).body.jobs;
    expect(pulled.filter((j: any) => [paused.id, beat.id].includes(j.monitorId))).toHaveLength(0);
    const left = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.queue, checkQueue("eu-west")), eq(jobs.state, "queued")));
    expect(left.filter((j) => [paused.id, beat.id].includes((j.payload as any).monitorId))).toEqual(
      [],
    );
  });

  test("no token, a wrong token and a revoked token are all refused", async () => {
    expect((await call(null, "/hello", { version: "1" })).status).toBe(401);
    expect((await call("upzy_agent_nonsense", "/jobs/pull", {})).status).toBe(401);
    expect((await call("upzy_mcp_wrongkind", "/jobs/pull", {})).status).toBe(401);

    const revoked = await makeAgent("eu-west", { revokedAt: new Date() });
    expect((await call(revoked, "/jobs/pull", {})).status).toBe(401);
  });
});
