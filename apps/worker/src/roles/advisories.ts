import { schema, type Db } from "@upzy/db";
import { enqueue } from "@upzy/queue";
import {
  assessComponents,
  componentFinding,
  fetchKevEntries,
  fingerprint,
  type Component,
  type Deps,
} from "@upzy/security";
import { and, eq } from "drizzle-orm";

import { NOTIFY_QUEUE, type FindingNotifyJob } from "./notifier";
import { sleepUnlessAborted } from "./retention";
import { applyScanResult, scanDeps } from "./scanner";

const { assetComponents, assets, findings, scans, systemState } = schema;

/** The CVE ids of the CISA catalogue as of the last check. Anything beyond them is new. */
export const KEV_SEEN_KEY = "advisories.kev_seen";

/** "HTTP Server", "http_server" and "httpserver" are one product. */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export interface AdvisoryResult {
  /** The first run only records the catalogue: everything in it is "old". */
  baseline: boolean;
  /** CVEs that appeared in the catalogue since the last check. */
  added: number;
  /** Findings opened or raised because of them. */
  affected: number;
}

/**
 * When CISA adds a CVE to its Known Exploited Vulnerabilities catalogue, finds the assets whose last scan saw the
 * affected software, confirms the exact version is vulnerable (same lookup as a scan, but never from the cache, which
 * could predate the CVE), and raises the finding with an alert. Daily scans would find it too, but up to a day later;
 * this is for the CVEs that are being exploited right now.
 *
 * Alerts go through the normal finding notification, once per finding and CVE however often this runs.
 */
export async function checkKevAdditions(
  db: Db,
  deps: Deps = scanDeps(db),
): Promise<AdvisoryResult> {
  const entries = await fetchKevEntries(deps.vuln);
  const [state] = await db.select().from(systemState).where(eq(systemState.key, KEV_SEEN_KEY));
  const remember = (ids: string[]) =>
    db
      .insert(systemState)
      .values({ key: KEV_SEEN_KEY, value: { ids } })
      .onConflictDoUpdate({
        target: systemState.key,
        set: { value: { ids }, updatedAt: new Date() },
      });

  if (!state) {
    await remember(entries.map((e) => e.cve));
    return { baseline: true, added: 0, affected: 0 };
  }
  const seen = new Set((state.value.ids as string[] | undefined) ?? []);
  const fresh = entries.filter((e) => !seen.has(e.cve));
  if (fresh.length === 0) return { baseline: false, added: 0, affected: 0 };

  // Which software could they be about? Compare product names, then confirm against the vulnerability databases.
  const products = new Map<string, Set<string>>(); // normalised product -> new CVEs naming it
  for (const e of fresh) {
    const set = products.get(norm(e.product)) ?? new Set();
    set.add(e.cve);
    products.set(norm(e.product), set);
  }
  const held = await db
    .select({
      assetId: assetComponents.assetId,
      workspaceId: assets.workspaceId,
      product: assetComponents.product,
      version: assetComponents.version,
      display: assetComponents.display,
      detectedFrom: assetComponents.detectedFrom,
      lookup: assetComponents.lookup,
    })
    .from(assetComponents)
    .innerJoin(assets, eq(assets.id, assetComponents.assetId));
  const candidates = held.filter(
    (h) => products.has(norm(h.product)) || products.has(norm(h.display)),
  );

  // Never read the cache: a cached answer for this version may be from before the CVE existed.
  const live = { ...deps.vuln, cache: { get: async () => undefined, set: deps.vuln.cache.set } };
  let failed = false;
  let affected = 0;
  const byComponent = new Map<string, typeof candidates>();
  for (const c of candidates) {
    const key = `${c.product}@${c.version}`;
    byComponent.set(key, [...(byComponent.get(key) ?? []), c]);
  }
  for (const rows of byComponent.values()) {
    const first = rows[0]!;
    const component = {
      product: first.product,
      display: first.display,
      version: first.version,
      detectedFrom: first.detectedFrom,
      lookup: first.lookup,
    } as Component;
    const newCves = new Set([
      ...(products.get(norm(first.product)) ?? []),
      ...(products.get(norm(first.display)) ?? []),
    ]);
    try {
      const [assessment] = await assessComponents(live, [component]);
      const hit = assessment?.vulns.filter((v) => v.cve && newCves.has(v.cve)) ?? [];
      if (!assessment || hit.length === 0) continue;
      const draft = componentFinding(assessment);
      for (const row of rows) {
        const [scan] = await db
          .insert(scans)
          .values({
            workspaceId: row.workspaceId,
            assetId: row.assetId,
            status: "running",
            startedAt: new Date(),
            triggeredBy: "advisory",
          })
          .returning();
        // No check family is marked complete, so nothing else on the asset is resolved by this.
        await applyScanResult(db, scan!, { findings: [draft], outcomes: {}, errors: {} });
        const [finding] = await db
          .select({ id: findings.id, status: findings.status })
          .from(findings)
          .where(
            and(
              eq(findings.workspaceId, row.workspaceId),
              eq(findings.fingerprint, fingerprint(row.assetId, draft)),
            ),
          );
        // An ignored finding was dismissed on purpose; the alert is for the ones that need attention.
        if (!finding || finding.status !== "open") continue;
        affected++;
        for (const cve of hit.map((v) => v.cve!))
          await enqueue<FindingNotifyJob>(
            db,
            NOTIFY_QUEUE,
            { findingId: finding.id, event: "finding.opened", occurrence: `kev:${cve}` },
            { dedupeKey: `${finding.id}:kev:${cve}` },
          );
      }
    } catch (e) {
      failed = true;
      console.error(`[advisories] ${component.product}@${component.version}:`, e);
    }
  }
  // After a failure the same CVEs are looked at again next time; the alerts above are deduplicated.
  if (!failed) await remember(entries.map((e) => e.cve));
  return { baseline: false, added: fresh.length, affected };
}

/** Checks the catalogue a few minutes after start and then every few hours. A failure is retried next round. */
export async function runAdvisories(
  db: Db,
  signal: AbortSignal,
  opts: { firstDelayMs?: number; intervalMs?: number; deps?: Deps } = {},
) {
  const intervalMs = opts.intervalMs ?? 4 * 3_600_000;
  await sleepUnlessAborted(opts.firstDelayMs ?? 2 * 60_000, signal);
  while (!signal.aborted) {
    try {
      const r = await checkKevAdditions(db, opts.deps);
      if (r.baseline) console.log("[advisories] recorded the current exploited-vulnerability list");
      else if (r.added)
        console.log(
          `[advisories] ${r.added} newly exploited CVE(s); ${r.affected} finding(s) raised`,
        );
    } catch (e) {
      console.error("[advisories]", e);
    }
    await sleepUnlessAborted(intervalMs, signal);
  }
}
