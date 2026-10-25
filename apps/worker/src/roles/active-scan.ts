import { ACTIVE_SCAN_QUEUE, SCAN_RESULT_QUEUE, schema, type Db } from "@upzy/db";
import { enqueue, work } from "@upzy/queue";
import { ACTIVE_CHECKS, PASSIVE_CHECKS, ALL_CHECKS, type Check } from "@upzy/security";
import type { ScannerResult } from "@upzy/validator";
import { eq } from "drizzle-orm";

import { applyScanResult } from "./scanner";

const { assets, scans, scanProvenance } = schema;

export type ActiveEngine = "builtin" | "nuclei";

/**
 * ACTIVE_SCAN_ENGINE=builtin (default) runs the active checks inside the worker, as before.
 * ACTIVE_SCAN_ENGINE=nuclei hands exposed-file checks to the separate upzy-scan program (nuclei, a curated template
 * set, a rate limit, a provenance log). Port checks stay in the worker either way.
 */
export function activeEngine(env: Record<string, string | undefined> = process.env): ActiveEngine {
  const v = env.ACTIVE_SCAN_ENGINE?.trim().toLowerCase();
  if (!v || v === "builtin") return "builtin";
  if (v === "nuclei") return "nuclei";
  throw new Error(`ACTIVE_SCAN_ENGINE must be builtin or nuclei (got "${v}")`);
}

/** The checks a scan of this asset runs in the worker. A verified asset also gets the active ones, per the engine. */
export function checksFor(verified: boolean, engine: ActiveEngine): Check[] {
  if (!verified) return PASSIVE_CHECKS;
  if (engine === "builtin") return ALL_CHECKS;
  return [...PASSIVE_CHECKS, ...ACTIVE_CHECKS.filter((c) => c.family === "ports")];
}

/** Queues an active scan for the scanner. Only a verified asset is ever queued; the API checks again when handing it out. */
export async function queueActiveScan(db: Db, asset: { id: string; verified: boolean }) {
  if (!asset.verified) return null;
  return enqueue(db, ACTIVE_SCAN_QUEUE, { assetId: asset.id }, { dedupeKey: `active:${asset.id}` });
}

export interface ScanResultJob {
  assetId: string;
  scannerId: string;
  result: ScannerResult;
}

/**
 * Records what the scanner reported: its findings, through the same path as any scan (so they dedupe by fingerprint,
 * reopen, notify and auto-resolve like the rest), and a provenance row saying what was run. The asset is checked for
 * ownership once more here: if the verification was withdrawn while the scan ran, the result is dropped.
 */
export async function handleScanResult(db: Db, { assetId, scannerId, result }: ScanResultJob) {
  const [asset] = await db.select().from(assets).where(eq(assets.id, assetId));
  if (!asset) return;
  if (!asset.verified) {
    console.log(`[active-scan] dropped a result for ${asset.value}: it is no longer verified`);
    return;
  }
  const [scan] = await db
    .insert(scans)
    .values({
      workspaceId: asset.workspaceId,
      assetId,
      status: "running",
      startedAt: new Date(result.provenance.startedAt),
      triggeredBy: "active-scan",
    })
    .returning();
  // A scan that did not finish may have missed things, so it can add findings but must not mark anything fixed.
  const complete = !result.error;
  await applyScanResult(db, scan!, {
    findings: result.findings,
    outcomes: complete ? { exposure: "ok", nuclei: "ok" } : {},
    errors: result.error ? { nuclei: result.error } : {},
  });
  const p = result.provenance;
  await db.insert(scanProvenance).values({
    workspaceId: asset.workspaceId,
    assetId,
    scanId: scan!.id,
    scannerId,
    engine: p.engine,
    engineVersion: p.engineVersion,
    templateSet: p.templateSet,
    templatesRun: p.templatesRun,
    requests: p.requests,
    rateLimitPerSecond: p.rateLimitPerSecond,
    startedAt: new Date(p.startedAt),
    finishedAt: new Date(p.finishedAt),
    findings: result.findings.length,
    error: result.error ?? null,
    templates: p.templates,
  });
  await db.update(assets).set({ lastScanAt: new Date() }).where(eq(assets.id, assetId));
  console.log(
    `[active-scan] ${asset.value}: ${result.findings.length} finding(s) from ${p.templatesRun} template(s)${result.error ? ` (${result.error})` : ""}`,
  );
}

export const runScanResultIngest = (db: Db, signal: AbortSignal) =>
  work<ScanResultJob>(db, SCAN_RESULT_QUEUE, (payload) => handleScanResult(db, payload), {
    concurrency: 2,
    signal,
    discardWhenDone: true,
  });
