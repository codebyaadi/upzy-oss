import { decryptJson } from "@upzy/crypto";
import { schema, type Db } from "@upzy/db";
import { runProbe } from "@upzy/probes";
import { enqueue, work } from "@upzy/queue";
import { and, eq, ne } from "drizzle-orm";

import { evaluate } from "../evaluate";
import { heartbeatResult } from "../heartbeat";
import { AI_QUEUE, type AiJob } from "./agent";
import { CORRELATE_QUEUE, type CorrelateJob } from "./correlator";
import { NOTIFY_QUEUE, type NotifyJob } from "./notifier";
import { CHECK_QUEUE, type CheckJob } from "./scheduler";
import { STATUS_NOTIFY_QUEUE, type StatusNotifyJob } from "./status-notify";

const REGION = process.env.WORKER_REGION ?? "local";

/** Runs one check, stores the result, then updates monitor state and opens/resolves incidents. */
export async function handleCheck(
  db: Db,
  { monitorId }: CheckJob,
  opts: { encryptionKey?: string; probe?: typeof runProbe; now?: () => Date } = {},
) {
  const { monitors, monitorChecks, incidents } = schema;
  const [m] = await db.select().from(monitors).where(eq(monitors.id, monitorId));
  if (!m || !m.active) return;

  // Secrets are decrypted only for the length of the check and handed to the probe, never stored or logged.
  let secrets: Record<string, string> | undefined;
  if (m.secretsEncrypted && opts.encryptionKey) {
    try {
      secrets = decryptJson<Record<string, string>>(m.secretsEncrypted, opts.encryptionKey);
    } catch {
      console.error(`[prober] could not decrypt the secrets of monitor ${m.id}`);
    }
  }
  const result =
    m.type === "heartbeat"
      ? heartbeatResult(m, (opts.now ?? (() => new Date()))())
      : await (opts.probe ?? runProbe)({
          type: m.type,
          target: m.target,
          config: m.config,
          secrets,
        });

  await db.transaction(async (tx) => {
    // A heartbeat is evaluated every minute, but only a change of state is worth a row of history.
    const unchanged = m.type === "heartbeat" && result.status === m.lastStatus;
    if (!unchanged)
      await tx.insert(monitorChecks).values({
        monitorId: m.id,
        status: result.status,
        responseMs: result.responseMs,
        region: REGION,
        statusCode: result.statusCode,
        error: result.error,
        errorKind: result.errorKind,
        ttfbMs: result.ttfbMs,
        tlsDaysLeft: result.tlsDaysLeft,
      });

    // Lock the monitor row so concurrent checks cannot both open an incident.
    const [fresh] = await tx.select().from(monitors).where(eq(monitors.id, m.id)).for("update");
    if (!fresh) return;
    const [open] = await tx
      .select({ id: incidents.id })
      .from(incidents)
      .where(and(eq(incidents.monitorId, m.id), ne(incidents.status, "resolved")));

    const next = evaluate({
      resultStatus: result.status,
      consecutiveFailures: fresh.consecutiveFailures,
      failureThreshold: fresh.failureThreshold,
      hasOpenIncident: !!open,
    });

    await tx
      .update(monitors)
      .set({ consecutiveFailures: next.consecutiveFailures, lastStatus: next.monitorStatus })
      .where(eq(monitors.id, m.id));

    if (next.incident === "open") {
      const [created] = await tx
        .insert(incidents)
        .values({
          workspaceId: m.workspaceId,
          monitorId: m.id,
          type: "uptime",
          status: "open",
          title: `${m.name} is down${result.error ? `: ${result.error}` : ""}`,
        })
        .returning({ id: incidents.id });
      await enqueue<NotifyJob>(
        tx,
        NOTIFY_QUEUE,
        { incidentId: created!.id, event: "incident.opened" },
        { dedupeKey: `${created!.id}:opened` },
      );
      await enqueue<StatusNotifyJob>(
        tx,
        STATUS_NOTIFY_QUEUE,
        { kind: "opened", incidentId: created!.id },
        { dedupeKey: `${created!.id}:opened` },
      );
      // Group it with other incidents opening around now (rule-based, no AI, never delays the alerts).
      await enqueue<CorrelateJob>(
        tx,
        CORRELATE_QUEUE,
        { incidentId: created!.id },
        { dedupeKey: `correlate:${created!.id}` },
      );
      // Analysis is opt-in per organization. It runs beside the alerts and never delays them.
      const [ai] = await tx
        .select({ enabled: schema.aiSettings.enabled })
        .from(schema.aiSettings)
        .innerJoin(schema.workspaces, eq(schema.workspaces.orgId, schema.aiSettings.organizationId))
        .where(eq(schema.workspaces.id, m.workspaceId));
      if (ai?.enabled) {
        await tx
          .update(incidents)
          .set({ aiTriageStatus: "pending" })
          .where(eq(incidents.id, created!.id));
        await enqueue<AiJob>(
          tx,
          AI_QUEUE,
          { kind: "triage-incident", incidentId: created!.id },
          { maxAttempts: 3, dedupeKey: `triage:${created!.id}` },
        );
      }
      console.log(`[incident] opened for ${m.name}`);
    } else if (next.incident === "resolve" && open) {
      await tx
        .update(incidents)
        .set({ status: "resolved", resolvedAt: new Date() })
        .where(eq(incidents.id, open.id));
      await enqueue<NotifyJob>(
        tx,
        NOTIFY_QUEUE,
        { incidentId: open.id, event: "incident.resolved" },
        { dedupeKey: `${open.id}:resolved` },
      );
      await enqueue<StatusNotifyJob>(
        tx,
        STATUS_NOTIFY_QUEUE,
        { kind: "resolved", incidentId: open.id },
        { dedupeKey: `${open.id}:resolved` },
      );
      console.log(`[incident] resolved for ${m.name}`);
    }
  });
}

export const runProber = (
  db: Db,
  signal: AbortSignal,
  opts: { encryptionKey?: string; concurrency?: number } = {},
) =>
  work<CheckJob>(
    db,
    CHECK_QUEUE,
    (payload) => handleCheck(db, payload, { encryptionKey: opts.encryptionKey }),
    { concurrency: opts.concurrency ?? 20, signal },
  );
