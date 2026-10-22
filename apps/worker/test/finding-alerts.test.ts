import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { encryptJson } from "@upzy/crypto";
import { createDb, schema } from "@upzy/db";
import type { FindingDraft, ScanResult } from "@upzy/security";
import { and, eq, sql } from "drizzle-orm";

import { fanOut, handleDeliver, type DeliverJob, type NotifierEnv } from "../src/roles/notifier";
import { applyScanResult } from "../src/roles/scanner";

// Needs a migrated Postgres: DATABASE_URL=... bun test
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

const draft = (checkKey: string, severity: FindingDraft["severity"]): FindingDraft => ({
  checkKey,
  severity,
  title: checkKey,
  description: "d",
  remediation: "r",
});
const result = (findings: FindingDraft[], outcomes: ScanResult["outcomes"]): ScanResult => ({
  findings,
  outcomes,
  errors: {},
});
const KEY = Buffer.alloc(32, 7).toString("base64");
const env: NotifierEnv = { encryptionKey: KEY, appUrl: "http://app.test", mailFrom: "x@y.z" };

run("finding alerts (postgres)", () => {
  const db = createDb(url);
  const {
    assets,
    findings,
    scans,
    organizations,
    workspaces,
    notificationChannels,
    alertRules,
    notificationDeliveries,
    monitors,
  } = schema;
  const orgId = `fa-org-${Date.now()}`;
  let ws = "",
    assetId = "",
    channelId = "",
    monitorId = "";

  beforeAll(async () => {
    await db
      .insert(organizations)
      .values({ id: orgId, name: "t", slug: orgId, createdAt: new Date() });
    ws = (
      await db.insert(workspaces).values({ orgId, name: "w" }).returning({ id: workspaces.id })
    )[0]!.id;
    assetId = (
      await db
        .insert(assets)
        .values({ workspaceId: ws, kind: "domain", value: "example.com", verificationToken: "t" })
        .returning({ id: assets.id })
    )[0]!.id;
    monitorId = (
      await db
        .insert(monitors)
        .values({
          workspaceId: ws,
          name: "m",
          type: "http",
          target: "https://example.com",
          interval: 60,
          active: true,
        })
        .returning({ id: monitors.id })
    )[0]!.id;
    channelId = (
      await db
        .insert(notificationChannels)
        .values({
          workspaceId: ws,
          name: "ops",
          kind: "slack",
          summary: "x",
          configEncrypted: encryptJson({ url: "https://hooks.slack.com/services/T/B/x" }, KEY),
        })
        .returning({ id: notificationChannels.id })
    )[0]!.id;
  });
  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  const scan = async () =>
    (
      await db.insert(scans).values({ workspaceId: ws, assetId, status: "running" }).returning()
    )[0]!;
  const notifyJobs = async () => {
    const rows = await db.execute<{ payload: { findingId: string; occurrence: string } }>(
      sql`select payload from jobs where queue = 'notify' and payload->>'event' = 'finding.opened' and payload->>'findingId' in (select id::text from findings where asset_id = ${assetId})`,
    );
    return [...rows].map((r) => r.payload);
  };

  test("a new critical finding enqueues one notification; low severity does not", async () => {
    await applyScanResult(
      db,
      await scan(),
      result(
        [
          draft("tls.cert_expired", "critical"),
          draft("headers.csp_missing", "medium"),
          draft("dns.caa_missing", "info"),
        ],
        { tls: "ok", headers: "ok", dns: "ok" },
      ),
    );
    expect(await notifyJobs()).toHaveLength(1);
  });

  test("the same finding on the next scan does not notify again", async () => {
    await applyScanResult(
      db,
      await scan(),
      result([draft("tls.cert_expired", "critical")], { tls: "ok" }),
    );
    expect(await notifyJobs()).toHaveLength(1);
  });

  test("a finding that is fixed and then returns notifies again", async () => {
    await applyScanResult(db, await scan(), result([], { tls: "ok" }));
    expect(
      (await db.select().from(findings).where(eq(findings.checkKey, "tls.cert_expired")))[0]!
        .status,
    ).toBe("resolved");
    await applyScanResult(
      db,
      await scan(),
      result([draft("tls.cert_expired", "critical")], { tls: "ok" }),
    );
    expect(await notifyJobs()).toHaveLength(2);
  });

  test("an ignored finding does not re-notify", async () => {
    await db
      .update(findings)
      .set({ status: "ignored" })
      .where(eq(findings.checkKey, "tls.cert_expired"));
    await applyScanResult(
      db,
      await scan(),
      result([draft("tls.cert_expired", "critical")], { tls: "ok" }),
    );
    expect(await notifyJobs()).toHaveLength(2);
  });

  describe("fan-out", () => {
    const job = async () => {
      const [f] = await db
        .select()
        .from(findings)
        .where(and(eq(findings.assetId, assetId), eq(findings.checkKey, "tls.cert_expired")));
      return { findingId: f!.id, event: "finding.opened" as const, occurrence: "scan-x" };
    };
    const deliverJobs = async () => {
      const rows = await db.execute<{ n: number }>(
        sql`select count(*)::int as n from jobs where queue = 'deliver' and payload->>'channelId' = ${channelId} and payload->>'findingId' is not null`,
      );
      return [...rows][0]!.n;
    };

    test("only rules that subscribe to finding.opened fire", async () => {
      const before = await deliverJobs();
      await db
        .insert(alertRules)
        .values({ workspaceId: ws, channelId, events: ["incident.opened", "incident.resolved"] });
      expect(await fanOut(db, await job())).toBe(0);
      expect(await deliverJobs()).toBe(before);
    });

    test("workspace-wide rule with finding.opened fires; monitor-scoped rules never do", async () => {
      await db
        .insert(alertRules)
        .values({ workspaceId: ws, channelId, monitorId, events: ["finding.opened"] });
      expect(await fanOut(db, await job())).toBe(0);
      await db
        .insert(alertRules)
        .values({ workspaceId: ws, channelId, events: ["finding.opened"] });
      expect(await fanOut(db, await job())).toBe(1);
    });

    test("disabled channels are skipped", async () => {
      await db
        .update(notificationChannels)
        .set({ enabled: false })
        .where(eq(notificationChannels.id, channelId));
      expect(await fanOut(db, await job())).toBe(0);
      await db
        .update(notificationChannels)
        .set({ enabled: true })
        .where(eq(notificationChannels.id, channelId));
    });

    test("delivery posts the finding to the channel, records it once, and is idempotent", async () => {
      const payload: DeliverJob = { ...(await job()), channelId };
      const calls: string[] = [];
      // Email is the one transport that can be injected here (HTTP channels use the SSRF-guarded client).
      await db
        .update(notificationChannels)
        .set({ kind: "email", configEncrypted: encryptJson({ to: "oncall@example.com" }, KEY) })
        .where(eq(notificationChannels.id, channelId));
      const email = async (m: { subject: string; text: string }) =>
        void calls.push(`${m.subject} | ${m.text}`);
      await handleDeliver(db, env, email, payload, { attempts: 1, maxAttempts: 5 });
      await handleDeliver(db, env, email, payload, { attempts: 1, maxAttempts: 5 }); // retry after success: no duplicate

      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain("[Security: Critical]");
      expect(calls[0]).toContain(`http://app.test/findings/${payload.findingId}`);
      const rows = await db
        .select()
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.findingId, payload.findingId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "sent", incidentId: null, occurrence: "scan-x" });
    });

    test("a different occurrence (regression) notifies again", async () => {
      const calls: string[] = [];
      const payload: DeliverJob = { ...(await job()), occurrence: "scan-y", channelId };
      await handleDeliver(db, env, async (m) => void calls.push(m.subject), payload, {
        attempts: 1,
        maxAttempts: 5,
      });
      expect(calls).toHaveLength(1);
    });

    test("final failure is recorded as failed", async () => {
      const payload: DeliverJob = { ...(await job()), occurrence: "scan-z", channelId };
      const failing = async () => Promise.reject(new Error("smtp down"));
      await expect(
        handleDeliver(db, env, failing, payload, { attempts: 5, maxAttempts: 5 }),
      ).rejects.toThrow("smtp down");
      const [row] = await db
        .select()
        .from(notificationDeliveries)
        .where(
          and(
            eq(notificationDeliveries.findingId, payload.findingId),
            eq(notificationDeliveries.occurrence, "scan-z"),
          ),
        );
      expect(row).toMatchObject({ status: "failed", error: "smtp down" });
    });
  });
});
