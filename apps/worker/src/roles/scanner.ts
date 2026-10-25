import { schema, type Db } from "@upzy/db";
import { enqueue, work } from "@upzy/queue";
import {
  defaultDeps,
  fingerprint,
  ALL_CHECKS,
  recordHealth,
  riskScore,
  runChecks,
  type Deps,
  type FindingDraft,
  type ScanResult,
} from "@upzy/security";
import { and, eq, inArray, lte, ne, notInArray, sql } from "drizzle-orm";

import { dbCache, pruneCache } from "../db-cache";
import { NOTIFY_QUEUE, type FindingNotifyJob } from "./notifier";

export const SCAN_QUEUE = "scan";
export interface ScanJob {
  assetId: string;
  triggeredBy?: string;
}
/** "Verify fix": re-run just the check family behind one finding. */
export const VERIFY_QUEUE = "verify-fix";
export interface VerifyJob {
  findingId: string;
}

const SCAN_INTERVAL = "24 hours";
/** Findings at or above this severity notify. Lower ones stay in the dashboard. */
const NOTIFY_SEVERITIES = new Set<string>(["critical", "high"]);

/**
 * Persists a scan result. Findings are deduped by fingerprint: a repeat only refreshes `last_seen`,
 * a previously resolved finding reopens, and an `ignored` one stays ignored. Findings the scan no
 * longer sees are auto-resolved, but only for check families that ran to completion.
 */
export async function applyScanResult(
  db: Db,
  scan: { id: string; workspaceId: string; assetId: string },
  result: ScanResult,
) {
  const { findings, scans, assets, assetComponents } = schema;
  const now = new Date();

  await db.transaction(async (tx) => {
    if (result.stack)
      await tx.update(assets).set({ stack: result.stack }).where(eq(assets.id, scan.assetId));
    // What the page runs, so a vulnerability announced tomorrow can be matched without scanning again. Only when the
    // page was read: a failed fetch says nothing about what is installed.
    if (result.components) {
      const keep = result.components;
      await tx.delete(assetComponents).where(
        keep.length
          ? and(
              eq(assetComponents.assetId, scan.assetId),
              notInArray(
                sql`${assetComponents.product} || '@' || ${assetComponents.version}`,
                keep.map((c) => `${c.product}@${c.version}`),
              ),
            )
          : eq(assetComponents.assetId, scan.assetId),
      );
      for (const c of keep)
        await tx
          .insert(assetComponents)
          .values({
            assetId: scan.assetId,
            product: c.product,
            version: c.version,
            display: c.display,
            detectedFrom: c.detectedFrom,
            lookup: c.lookup,
            lastSeen: now,
          })
          .onConflictDoUpdate({
            target: [assetComponents.assetId, assetComponents.product, assetComponents.version],
            set: {
              display: c.display,
              detectedFrom: c.detectedFrom,
              lookup: c.lookup,
              lastSeen: now,
            },
          });
    }
    // Before upserting, learn which findings are new or coming back, so only those notify.
    const known = new Map(
      (
        await tx
          .select({ fingerprint: findings.fingerprint, status: findings.status })
          .from(findings)
          .where(eq(findings.assetId, scan.assetId))
      ).map((r) => [r.fingerprint, r.status]),
    );

    for (const f of result.findings) {
      const values = {
        workspaceId: scan.workspaceId,
        assetId: scan.assetId,
        scanId: scan.id,
        checkKey: f.checkKey,
        fingerprint: fingerprint(scan.assetId, f),
        severity: f.severity,
        riskScore: riskScore(f.severity, f.risk),
        title: f.title,
        description: f.description,
        remediation: f.remediation,
        evidence: f.evidence ?? {},
        lastSeen: now,
      };
      const [saved] = await tx
        .insert(findings)
        .values(values)
        .onConflictDoUpdate({
          target: [findings.workspaceId, findings.fingerprint],
          set: {
            scanId: scan.id,
            severity: values.severity,
            riskScore: values.riskScore,
            title: values.title,
            description: values.description,
            remediation: values.remediation,
            evidence: values.evidence,
            lastSeen: now,
            // resolved -> open again; ignored stays ignored.
            status: sql`case when ${findings.status} = 'resolved' then 'open'::finding_status else ${findings.status} end`,
            resolvedAt: sql`case when ${findings.status} = 'resolved' then null else ${findings.resolvedAt} end`,
          },
        })
        .returning({ id: findings.id });

      const before = known.get(values.fingerprint);
      if ((before === undefined || before === "resolved") && NOTIFY_SEVERITIES.has(f.severity)) {
        await enqueue<FindingNotifyJob>(
          tx,
          NOTIFY_QUEUE,
          { findingId: saved!.id, event: "finding.opened", occurrence: scan.id },
          { dedupeKey: `${saved!.id}:finding:${scan.id}` },
        );
      }
    }

    const completed = Object.entries(result.outcomes)
      .filter(([, o]) => o === "ok")
      .map(([family]) => family);
    if (completed.length > 0) {
      const stale = await tx
        .select({ id: findings.id, checkKey: findings.checkKey })
        .from(findings)
        .where(
          and(
            eq(findings.assetId, scan.assetId),
            eq(findings.status, "open"),
            ne(findings.scanId, scan.id),
          ),
        );
      const resolvable = stale
        .filter((s) => completed.includes(s.checkKey.split(".")[0]!))
        .map((s) => s.id);
      if (resolvable.length > 0) {
        await tx
          .update(findings)
          .set({ status: "resolved", resolvedAt: now })
          .where(inArray(findings.id, resolvable));
      }
    }

    const ran = Object.values(result.outcomes).filter((o) => o !== "skipped");
    const allFailed = ran.length > 0 && ran.every((o) => o === "error");
    await tx
      .update(scans)
      .set({ status: allFailed ? "failed" : "completed", finishedAt: now, checks: result.outcomes })
      .where(eq(scans.id, scan.id));
  });
}

/**
 * Which findings would be news to the customer: anything not already open or ignored on this asset. Those are what
 * `runChecks` confirms with a second run before they are reported.
 */
export async function newFindingFilter(db: Db, assetId: string) {
  const { findings } = schema;
  const known = new Set(
    (
      await db
        .select({ fingerprint: findings.fingerprint, status: findings.status })
        .from(findings)
        .where(eq(findings.assetId, assetId))
    )
      .filter((r) => r.status !== "resolved")
      .map((r) => r.fingerprint),
  );
  return (f: FindingDraft) => !known.has(fingerprint(assetId, f));
}

/** Scan dependencies for production: the default network layer, with lookups cached in Postgres. */
const depsByDb = new WeakMap<Db, Deps>();
/** One instance per database handle: the NVD rate limiter is keyed on the cache object, so scans must share it. */
export const scanDeps = (db: Db): Deps => {
  let deps = depsByDb.get(db);
  if (!deps)
    depsByDb.set(
      db,
      (deps = { ...defaultDeps, vuln: { ...defaultDeps.vuln, cache: dbCache(db) } }),
    );
  return deps;
};

export async function handleScan(
  db: Db,
  { assetId, triggeredBy }: ScanJob,
  deps: Deps = scanDeps(db),
) {
  const { assets, scans } = schema;
  const [asset] = await db.select().from(assets).where(eq(assets.id, assetId));
  if (!asset) return;

  const [scan] = await db
    .insert(scans)
    .values({
      workspaceId: asset.workspaceId,
      assetId,
      status: "running",
      startedAt: new Date(),
      triggeredBy: triggeredBy ?? "schedule",
    })
    .returning();

  try {
    const result = await runChecks(
      { kind: asset.kind, value: asset.value },
      { deps, verified: asset.verified, isNew: await newFindingFilter(db, assetId) },
    );
    await applyScanResult(db, scan!, result);
    await db.update(assets).set({ lastScanAt: new Date() }).where(eq(assets.id, assetId));
    // The trend is a nicety: never fail a scan over it.
    await recordHealth(db, assetId).catch((e) => console.error("[scanner:health]", e));
    const failed = Object.entries(result.errors);
    console.log(
      `[scanner] ${asset.value}: ${result.findings.length} finding(s)${result.unconfirmed?.length ? `, ${result.unconfirmed.length} not confirmed by a second run (${result.unconfirmed.join(", ")})` : ""}${failed.length ? `, errors: ${failed.map(([k, v]) => `${k} (${v})`).join("; ")}` : ""}`,
    );
  } catch (e) {
    await db
      .update(scans)
      .set({ status: "failed", finishedAt: new Date() })
      .where(eq(scans.id, scan!.id));
    throw e;
  }
}

/**
 * Re-runs the one check family behind a finding, so a fix shows up in a minute instead of at tomorrow's scan.
 * Same checks, same traffic as a scheduled scan. Only that family is evaluated, so only its findings can resolve.
 */
export async function handleVerify(db: Db, { findingId }: VerifyJob, deps: Deps = scanDeps(db)) {
  const { findings, assets, scans } = schema;
  const [row] = await db
    .select({ finding: findings, asset: assets })
    .from(findings)
    .innerJoin(assets, eq(assets.id, findings.assetId))
    .where(eq(findings.id, findingId));
  if (!row) return;
  const family = row.finding.checkKey.split(".")[0]!;
  const fail = (message: string) =>
    db
      .update(findings)
      .set({ verifyStatus: "failed", verifyError: message })
      .where(eq(findings.id, findingId));

  const checks = ALL_CHECKS.filter((c) => c.family === family);
  if (checks.length === 0)
    return void (await fail("This kind of finding can't be re-checked on demand."));

  const [scan] = await db
    .insert(scans)
    .values({
      workspaceId: row.asset.workspaceId,
      assetId: row.asset.id,
      status: "running",
      startedAt: new Date(),
      triggeredBy: "verify-fix",
    })
    .returning();
  try {
    const result = await runChecks(
      { kind: row.asset.kind, value: row.asset.value },
      {
        deps,
        checks,
        verified: row.asset.verified,
        isNew: await newFindingFilter(db, row.asset.id),
      },
    );
    if (result.outcomes[family] !== "ok") {
      await db
        .update(scans)
        .set({ status: "failed", finishedAt: new Date(), checks: result.outcomes })
        .where(eq(scans.id, scan!.id));
      await fail(
        result.errors[family] ??
          (result.outcomes[family] === "skipped"
            ? "This check doesn't apply to this kind of asset."
            : "The check could not run. Try again in a minute."),
      );
      return;
    }
    await applyScanResult(db, scan!, result);
    await db
      .update(findings)
      .set({ verifyStatus: null, verifyError: null, lastVerifiedAt: new Date() })
      .where(eq(findings.id, findingId));
    await recordHealth(db, row.asset.id).catch((e) => console.error("[verify:health]", e));
    const [after] = await db
      .select({ status: findings.status })
      .from(findings)
      .where(eq(findings.id, findingId));
    console.log(`[verify] ${row.asset.value} ${row.finding.checkKey}: ${after?.status}`);
  } catch (e) {
    await db
      .update(scans)
      .set({ status: "failed", finishedAt: new Date() })
      .where(eq(scans.id, scan!.id));
    await fail(e instanceof Error ? e.message : String(e));
  }
}

/** Claims assets whose next_scan_at is due, pushes it a day out and enqueues a scan job. */
export async function scheduleScans(db: Db, batch = 50): Promise<number> {
  const { assets } = schema;
  return db.transaction(async (tx) => {
    const due = await tx
      .select({ id: assets.id })
      .from(assets)
      .where(lte(assets.nextScanAt, sql`now()`))
      .limit(batch)
      .for("update", { skipLocked: true });
    for (const a of due) {
      await tx
        .update(assets)
        .set({ nextScanAt: sql`now() + ${SCAN_INTERVAL}::interval` })
        .where(eq(assets.id, a.id));
      await enqueue<ScanJob>(
        tx,
        SCAN_QUEUE,
        { assetId: a.id },
        { dedupeKey: a.id, maxAttempts: 2 },
      );
    }
    return due.length;
  });
}

export async function runScanner(db: Db, signal: AbortSignal) {
  const scheduler = (async () => {
    let lastPrune = 0;
    while (!signal.aborted) {
      try {
        if (Date.now() - lastPrune > 6 * 3600_000) {
          lastPrune = Date.now();
          await pruneCache(db);
        }
        const n = await scheduleScans(db);
        if (n > 0) console.log(`[scanner] queued ${n} scan(s)`);
      } catch (e) {
        console.error("[scanner:schedule]", e);
      }
      await Bun.sleep(5000);
    }
  })();
  // Scans are slow and hit third-party hosts: keep concurrency low.
  await Promise.all([
    scheduler,
    work<ScanJob>(db, SCAN_QUEUE, (p) => handleScan(db, p), { concurrency: 3, signal }),
    work<VerifyJob>(db, VERIFY_QUEUE, (p) => handleVerify(db, p), { concurrency: 3, signal }),
  ]);
}
