import { decryptJson } from "@upzy/crypto";
import {
  activeMaintenance,
  checkQueue,
  recordRollup,
  regionalVerdict,
  regionsOf,
  schema,
  workerRegion,
  type Db,
} from "@upzy/db";
import { runProbe } from "@upzy/probes";
import { enqueue, work } from "@upzy/queue";
import { and, eq, ne, sql } from "drizzle-orm";

import { evaluate } from "../evaluate";
import { createGate, openGate, type Gate } from "../gate";
import { heartbeatResult } from "../heartbeat";
import { AI_QUEUE, type AiJob } from "./agent";
import { CORRELATE_QUEUE, type CorrelateJob } from "./correlator";
import { NOTIFY_QUEUE, type NotifyJob } from "./notifier";
import { type CheckJob } from "./scheduler";
import { STATUS_NOTIFY_QUEUE, type StatusNotifyJob } from "./status-notify";

const REGION = workerRegion();

/** Runs one check, stores the result, then updates monitor state and opens/resolves incidents. */
export async function handleCheck(
  db: Db,
  { monitorId, region: jobRegion }: CheckJob,
  opts: {
    encryptionKey?: string;
    probe?: typeof runProbe;
    now?: () => Date;
    /** Limits how many checks use database connections at once; the probe itself is never held up by it. */
    gate?: Gate;
  } = {},
) {
  const { monitors, monitorChecks, monitorRegionState, incidents } = schema;
  const region = jobRegion ?? REGION;
  const gate = opts.gate ?? openGate;
  const [m] = await gate.run(() => db.select().from(monitors).where(eq(monitors.id, monitorId)));
  if (!m || !m.active) return;
  // The monitor was edited after this job was queued, and is no longer checked from here.
  if (!regionsOf(m).includes(region)) return;

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

  await gate.run(() =>
    db.transaction(async (tx) => {
      // A heartbeat is evaluated every minute, but only a change of state is worth a row of history.
      const unchanged = m.type === "heartbeat" && result.status === m.lastStatus;
      if (!unchanged) {
        await tx.insert(monitorChecks).values({
          monitorId: m.id,
          status: result.status,
          responseMs: result.responseMs,
          region,
          statusCode: result.statusCode,
          error: result.error,
          errorKind: result.errorKind,
          ttfbMs: result.ttfbMs,
          tlsDaysLeft: result.tlsDaysLeft,
        });
        // Counted into its five-minute bucket in the same transaction, so charts and reports never need the raw rows.
        await recordRollup(tx, {
          monitorId: m.id,
          region,
          status: result.status,
          responseMs: result.responseMs,
        });
      }

      // Lock the monitor row so concurrent checks cannot both open an incident.
      const [fresh] = await tx.select().from(monitors).where(eq(monitors.id, m.id)).for("update");
      if (!fresh) return;
      const [open] = await tx
        .select({ id: incidents.id })
        .from(incidents)
        .where(and(eq(incidents.monitorId, m.id), ne(incidents.status, "resolved")));

      // A monitor checked from several regions is down when most of them say so, not when one does. The streaks are
      // kept per region, and the state machine below then sees a single "down" or "up" with the streak already met.
      let status: "up" | "down" = result.status;
      let streak = fresh.consecutiveFailures;
      let where = "";
      if (fresh.regions.length > 0) {
        const failed = result.status === "down";
        await tx
          .insert(monitorRegionState)
          .values({
            monitorId: m.id,
            region,
            consecutiveFailures: failed ? 1 : 0,
            lastStatus: result.status,
          })
          .onConflictDoUpdate({
            target: [monitorRegionState.monitorId, monitorRegionState.region],
            set: {
              consecutiveFailures: failed ? sql`${monitorRegionState.consecutiveFailures} + 1` : 0,
              lastStatus: result.status,
              lastCheckAt: new Date(),
            },
          });
        const states = (
          await tx.select().from(monitorRegionState).where(eq(monitorRegionState.monitorId, m.id))
        ).filter((s) => fresh.regions.includes(s.region));
        const verdict = regionalVerdict(states, {
          failureThreshold: fresh.failureThreshold,
          intervalSeconds: fresh.interval,
          now: (opts.now ?? (() => new Date()))(),
        });
        status = verdict.down ? "down" : "up";
        streak = verdict.down ? fresh.failureThreshold - 1 : 0;
        if (verdict.down && verdict.considered > 1) where = ` from ${verdict.failing.join(", ")}`;
      }

      // Up, but slower than the monitor's own latency threshold. Never an incident: it only affects the state shown.
      const slow =
        result.status === "up" &&
        fresh.latencyThresholdMs != null &&
        result.responseMs != null &&
        result.responseMs > fresh.latencyThresholdMs;
      // Only a failure that is about to open an incident needs to know about maintenance.
      const window =
        status === "down" && !open
          ? (await activeMaintenance(tx, [m.id], (opts.now ?? (() => new Date()))())).get(m.id)
          : undefined;

      const next = evaluate({
        resultStatus: status,
        consecutiveFailures: streak,
        failureThreshold: fresh.failureThreshold,
        hasOpenIncident: !!open,
        slow,
        consecutiveSlow: fresh.consecutiveSlow,
        inMaintenance: !!window,
      });

      await tx
        .update(monitors)
        .set({
          consecutiveFailures: next.consecutiveFailures,
          consecutiveSlow: next.consecutiveSlow,
          lastStatus: next.monitorStatus,
          ...(unchanged ? {} : { lastCheckAt: sql`now()` }),
        })
        .where(eq(monitors.id, m.id));

      if (next.suppressedByMaintenance)
        console.log(`[incident] held for ${m.name}: maintenance "${window!.name}" is in progress`);

      if (next.incident === "open") {
        const [created] = await tx
          .insert(incidents)
          .values({
            workspaceId: m.workspaceId,
            monitorId: m.id,
            type: "uptime",
            status: "open",
            title: `${m.name} is down${where}${result.error ? `: ${result.error}` : ""}`,
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
          .innerJoin(
            schema.workspaces,
            eq(schema.workspaces.orgId, schema.aiSettings.organizationId),
          )
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
    }),
  );
}

export interface ProberConfig {
  /** Checks in flight at once. They are network waits, so this can be far higher than the database pool. */
  concurrency: number;
  /** Checks using database connections at once. Leaves a few connections for claiming and finishing jobs. */
  dbConcurrency: number;
}

/**
 * PROBER_CONCURRENCY  checks in flight at once, default 200 (1 to 2000). Each is mostly waiting on a network answer,
 *                     so during an outage, when every check runs to its timeout, 200 checks at the 10 second default
 *                     is 20 checks a second per prober.
 * DB_POOL_MAX         the process's database connections, default 10. At most two fewer than this are used by checks
 *                     at once (never fewer than 2), so claiming and finishing jobs never wait behind them.
 */
export function parseProberConfig(
  env: Record<string, string | undefined> = process.env,
): ProberConfig {
  const raw = env.PROBER_CONCURRENCY?.trim();
  const concurrency = raw ? Number(raw) : 200;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2000)
    throw new Error(`PROBER_CONCURRENCY must be a whole number from 1 to 2000 (got "${raw}")`);
  const pool = Number(env.DB_POOL_MAX) || 10;
  return { concurrency, dbConcurrency: Math.max(2, pool - 2) };
}

export const runProber = (
  db: Db,
  signal: AbortSignal,
  opts: {
    encryptionKey?: string;
    concurrency?: number;
    dbConcurrency?: number;
    probe?: typeof runProbe;
  } = {},
) => {
  const config = parseProberConfig();
  const gate = createGate(opts.dbConcurrency ?? config.dbConcurrency);
  return work<CheckJob>(
    db,
    checkQueue(REGION),
    (payload) =>
      handleCheck(db, payload, { encryptionKey: opts.encryptionKey, probe: opts.probe, gate }),
    { concurrency: opts.concurrency ?? config.concurrency, signal },
  );
};
