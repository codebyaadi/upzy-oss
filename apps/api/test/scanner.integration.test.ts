import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createAuth } from "@upzy/auth/server";
import { ACTIVE_SCAN_QUEUE, SCAN_RESULT_QUEUE, createDb, schema } from "@upzy/db";
import { claim, requeueStale } from "@upzy/queue";
import { and, eq, sql } from "drizzle-orm";

import { createApp } from "../src/app";
import { newAgentToken } from "../src/lib/agent-auth";

// Real Postgres. Needs: DATABASE_URL=... bun test
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

// The worker is a separate program; loading it by a computed path keeps it out of this package's type-check while the
// test still drives the real code.
const worker = (name: string) => import(`${"../../worker/src/roles/"}${name}`);

run("active scanner API (postgres)", () => {
  process.env.BETTER_AUTH_SECRET ??= "integration-test-secret-integration-test-secret";
  const db = createDb(url);
  const { organizations, workspaces, assets, findings, jobs, probeAgents, scanProvenance } = schema;
  const auth = createAuth(db, {
    sendEmail: async () => {},
    signup: { mode: "open", allowedEmails: [], allowedDomains: [] },
  });
  const app = createApp({
    db,
    auth,
    webOrigin: "http://localhost:3001",
    encryptionKey: Buffer.alloc(32, 4).toString("base64"),
    rateLimit: { rules: [{ match: () => true, bucket: "t", max: Infinity, windowMs: 1 }] },
  });
  const tag = `sc${Date.now()}`;
  const orgId = `${tag}-org`;
  let ws = "";
  let scannerToken = "";
  let probeToken = "";

  const post = async (token: string | null, path: string, body: unknown) => {
    const res = await app.handle(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, body: (await res.json()) as any };
  };

  const makeToken = async (kind: "probe" | "scanner", region: string) => {
    const t = newAgentToken();
    await db.insert(probeAgents).values({
      name: `${tag}-${kind}`,
      kind,
      region,
      hashedToken: t.hashedToken,
      prefix: t.prefix,
    });
    return t.token;
  };

  const makeAsset = async (value: string, verified = true) =>
    (
      await db
        .insert(assets)
        .values({
          workspaceId: ws,
          kind: "domain",
          value,
          verified,
          verificationToken: "t",
        })
        .returning()
    )[0]!;

  const result = (over: Record<string, unknown> = {}) => ({
    findings: [],
    provenance: {
      engine: "nuclei",
      engineVersion: "v3.11.1",
      templateSet: "set-test",
      templatesRun: 31,
      requests: 40,
      startedAt: new Date(Date.now() - 20_000).toISOString(),
      finishedAt: new Date().toISOString(),
      rateLimitPerSecond: 5,
      templates: ["upzy-exposure-env", "git-config"],
    },
    ...over,
  });
  const envFinding = {
    checkKey: "exposure.path",
    severity: "critical",
    title: "Environment file is public (/.env)",
    description: "d",
    remediation: "r",
    subject: "/.env",
    evidence: { template: "upzy-exposure-env", path: "/.env" },
  };

  /** The scanner takes a queued scan and reports a result; the worker then records it. */
  async function scanOnce(assetId: string, res: unknown) {
    const { queueActiveScan, handleScanResult } = await worker("active-scan");
    const [a] = await db.select().from(assets).where(eq(assets.id, assetId));
    await queueActiveScan(db, a);
    const pulled = await post(scannerToken, "/scanner/jobs/pull", { max: 5 });
    const job = pulled.body.jobs.find((j: any) => j.assetId === assetId);
    expect(job).toBeTruthy();
    const reported = await post(scannerToken, `/scanner/jobs/${job.jobId}/result`, res);
    expect(reported.status).toBe(202);
    const waiting = (await claim(db, SCAN_RESULT_QUEUE, 50)).filter(
      (j) => (j.payload as any).assetId === assetId,
    );
    expect(waiting).toHaveLength(1);
    await handleScanResult(db, waiting[0]!.payload);
    return job;
  }

  const rows = (assetId: string) => db.select().from(findings).where(eq(findings.assetId, assetId));

  beforeAll(async () => {
    await db
      .insert(organizations)
      .values({ id: orgId, name: "t", slug: orgId, createdAt: new Date() });
    ws = (
      await db.insert(workspaces).values({ orgId, name: "w" }).returning({ id: workspaces.id })
    )[0]!.id;
    scannerToken = await makeToken("scanner", "-");
    probeToken = await makeToken("probe", "eu-west");
    await db.delete(jobs).where(eq(jobs.queue, ACTIVE_SCAN_QUEUE));
  });
  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(probeAgents).where(eq(probeAgents.name, `${tag}-scanner`));
    await db.delete(probeAgents).where(eq(probeAgents.name, `${tag}-probe`));
  });

  test("a scanner token and a probe token each work only on their own API", async () => {
    const hello = { version: "0.0.1", engine: "nuclei" };
    expect((await post(scannerToken, "/scanner/hello", hello)).status).toBe(200);
    expect((await post(probeToken, "/scanner/hello", hello)).status).toBe(401);
    expect((await post(probeToken, "/scanner/jobs/pull", {})).status).toBe(401);
    expect((await post(scannerToken, "/agent/jobs/pull", {})).status).toBe(401);
    expect((await post(null, "/scanner/hello", hello)).status).toBe(401);
    expect((await post("upzy_agent_nonsense", "/scanner/jobs/pull", {})).status).toBe(401);
  });

  test("a verified asset is handed out with the server's rate and time limits", async () => {
    const a = await makeAsset(`ok-${tag}.example.com`);
    const { queueActiveScan } = await worker("active-scan");
    await queueActiveScan(db, a);
    const pulled = await post(scannerToken, "/scanner/jobs/pull", { max: 5 });
    const job = pulled.body.jobs.find((j: any) => j.assetId === a.id);
    expect(job).toMatchObject({
      host: `ok-${tag}.example.com`,
      url: `https://ok-${tag}.example.com/`,
      rateLimitPerSecond: 5,
      timeoutSeconds: 900,
    });
  });

  test("an unverified asset is never queued, and one that loses verification while queued is dropped", async () => {
    const { queueActiveScan } = await worker("active-scan");
    const never = await makeAsset(`never-${tag}.example.com`, false);
    expect(await queueActiveScan(db, never)).toBeNull();

    const lapsed = await makeAsset(`lapsed-${tag}.example.com`);
    await queueActiveScan(db, lapsed);
    await db.update(assets).set({ verified: false }).where(eq(assets.id, lapsed.id));
    const pulled = await post(scannerToken, "/scanner/jobs/pull", { max: 5 });
    expect(pulled.body.jobs.filter((j: any) => j.assetId === lapsed.id)).toHaveLength(0);
    const left = await db
      .select()
      .from(jobs)
      .where(
        and(eq(jobs.queue, ACTIVE_SCAN_QUEUE), sql`${jobs.payload}->>'assetId' = ${lapsed.id}`),
      );
    expect(left).toHaveLength(0);
  });

  test("a result is recorded as findings and as provenance, and dedupes with a finding the built-in check made", async () => {
    const a = await makeAsset(`dedupe-${tag}.example.com`);
    const { applyScanResult } = await worker("scanner");
    // The built-in check found it first.
    const [scan] = await db
      .insert(schema.scans)
      .values({ workspaceId: ws, assetId: a.id, status: "running" })
      .returning();
    await applyScanResult(db, scan!, {
      findings: [envFinding as any],
      outcomes: { exposure: "ok" },
      errors: {},
    });
    expect(await rows(a.id)).toHaveLength(1);

    await scanOnce(a.id, result({ findings: [envFinding] }));
    const after = await rows(a.id);
    expect(after).toHaveLength(1); // the same finding, not a second one
    expect(after[0]!.checkKey).toBe("exposure.path");
    expect(after[0]!.status).toBe("open");

    const [p] = await db.select().from(scanProvenance).where(eq(scanProvenance.assetId, a.id));
    expect(p).toMatchObject({
      engine: "nuclei",
      templatesRun: 31,
      requests: 40,
      findings: 1,
      rateLimitPerSecond: 5,
    });
    expect(p!.templates).toEqual(["upzy-exposure-env", "git-config"]);
    expect(p!.scannerId).toBeTruthy();
  });

  test("a clean complete scan resolves what it no longer sees, but a scan that ended in an error does not", async () => {
    const a = await makeAsset(`resolve-${tag}.example.com`);
    await scanOnce(a.id, result({ findings: [envFinding] }));
    expect((await rows(a.id))[0]!.status).toBe("open");

    await scanOnce(a.id, result({ error: "The scan reached its 900 second limit" }));
    expect((await rows(a.id))[0]!.status).toBe("open"); // it may simply not have got that far

    await scanOnce(a.id, result());
    expect((await rows(a.id))[0]!.status).toBe("resolved");
  });

  test("a result for an asset whose verification was withdrawn meanwhile is dropped", async () => {
    const a = await makeAsset(`late-${tag}.example.com`);
    const { queueActiveScan, handleScanResult } = await worker("active-scan");
    await queueActiveScan(db, a);
    const job = (await post(scannerToken, "/scanner/jobs/pull", { max: 5 })).body.jobs.find(
      (j: any) => j.assetId === a.id,
    );
    await post(
      scannerToken,
      `/scanner/jobs/${job.jobId}/result`,
      result({ findings: [envFinding] }),
    );
    await db.update(assets).set({ verified: false }).where(eq(assets.id, a.id));
    for (const j of (await claim(db, SCAN_RESULT_QUEUE, 50)).filter(
      (row) => (row.payload as any).assetId === a.id,
    ))
      await handleScanResult(db, j.payload);
    expect(await rows(a.id)).toHaveLength(0);
  });

  test("a scanner can only report exposure and nuclei findings, and only valid ones", async () => {
    const a = await makeAsset(`scope-${tag}.example.com`);
    const { queueActiveScan } = await worker("active-scan");
    await queueActiveScan(db, a);
    const job = (await post(scannerToken, "/scanner/jobs/pull", { max: 5 })).body.jobs.find(
      (j: any) => j.assetId === a.id,
    );
    const other = { ...envFinding, checkKey: "headers.hsts_missing" };
    expect(
      (await post(scannerToken, `/scanner/jobs/${job.jobId}/result`, result({ findings: [other] })))
        .status,
    ).toBe(400);
    expect(
      (await post(scannerToken, `/scanner/jobs/${job.jobId}/result`, { findings: [] })).status,
    ).toBe(400);
    const bad = result();
    (bad.provenance as any).rateLimitPerSecond = 5000;
    expect((await post(scannerToken, `/scanner/jobs/${job.jobId}/result`, bad)).status).toBe(400);
    // Still waiting for a valid answer.
    const [still] = await db.select().from(jobs).where(eq(jobs.id, job.jobId));
    expect(still!.state).toBe("running");
  });

  test("a scan can only be answered once, and a made-up id is not a scan", async () => {
    const a = await makeAsset(`once-${tag}.example.com`);
    const job = await scanOnce(a.id, result());
    expect((await post(scannerToken, `/scanner/jobs/${job.jobId}/result`, result())).status).toBe(
      404,
    );
    expect(
      (
        await post(
          scannerToken,
          "/scanner/jobs/3f1c9c0e-0000-4000-8000-000000000000/result",
          result(),
        )
      ).status,
    ).toBe(404);
  });

  test("a heartbeat keeps a long scan from being given to someone else", async () => {
    const a = await makeAsset(`slow-${tag}.example.com`);
    const { queueActiveScan } = await worker("active-scan");
    await queueActiveScan(db, a);
    const job = (await post(scannerToken, "/scanner/jobs/pull", { max: 5 })).body.jobs.find(
      (j: any) => j.assetId === a.id,
    );
    // Silent for ten minutes: the queue would take it back.
    await db.execute(
      sql`update jobs set locked_at = now() - interval '10 minutes' where id = ${job.jobId}`,
    );
    expect((await post(scannerToken, `/scanner/jobs/${job.jobId}/heartbeat`, {})).status).toBe(200);
    await requeueStale(db);
    const [j] = await db.select().from(jobs).where(eq(jobs.id, job.jobId));
    expect(j!.state).toBe("running");
    expect(
      (await post(scannerToken, "/scanner/jobs/3f1c9c0e-0000-4000-8000-000000000000/heartbeat", {}))
        .status,
    ).toBe(404);
  });
});
