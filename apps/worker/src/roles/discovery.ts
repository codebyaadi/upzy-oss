import { schema, type Db } from "@upzy/db";
import { enqueue, work } from "@upzy/queue";
import { checkResolves, defaultDeps, discoverSubdomains } from "@upzy/security";
import { and, eq, lte, sql } from "drizzle-orm";

import { AI_QUEUE, type AiJob } from "./agent";

export const DISCOVER_QUEUE = "discover";
export interface DiscoverJob {
  assetId: string;
}

const DISCOVERY_INTERVAL = "7 days";
/** Retry sooner than the weekly cadence when every certificate source was unreachable. */
const RETRY_AFTER = "1 hour";

export interface DiscoverDeps {
  discover?: typeof discoverSubdomains;
  resolve?: (host: string) => Promise<string[]>;
}

/**
 * Looks up a domain asset's subdomains in certificate transparency logs and records the ones that
 * are not assets yet as suggestions. Nothing is scanned until a person accepts a host.
 * Returns the number of hosts seen for the first time.
 */
export async function handleDiscover(
  db: Db,
  { assetId }: DiscoverJob,
  deps: DiscoverDeps = {},
): Promise<number> {
  const { assets, discoveredHosts } = schema;
  const [asset] = await db.select().from(assets).where(eq(assets.id, assetId));
  if (!asset || asset.kind !== "domain") return 0;

  let result;
  try {
    result = await (deps.discover ?? discoverSubdomains)(asset.value);
  } catch (e) {
    await db
      .update(assets)
      .set({
        discoveryError: e instanceof Error ? e.message : String(e),
        nextDiscoveryAt: sql`now() + ${RETRY_AFTER}::interval`,
      })
      .where(eq(assets.id, assetId));
    throw e;
  }

  // Hosts that are already assets need no suggestion.
  const owned = new Set(
    (
      await db
        .select({ value: assets.value })
        .from(assets)
        .where(eq(assets.workspaceId, asset.workspaceId))
    ).map((a) => a.value),
  );
  const hosts = result.hosts.filter((h) => !owned.has(h));
  const resolved = await checkResolves(hosts, deps.resolve ?? defaultDeps.resolveAddresses);

  const known = new Set(
    (
      await db
        .select({ host: discoveredHosts.host })
        .from(discoveredHosts)
        .where(eq(discoveredHosts.workspaceId, asset.workspaceId))
    ).map((r) => r.host),
  );
  const now = new Date();
  for (let i = 0; i < hosts.length; i += 200) {
    await db
      .insert(discoveredHosts)
      .values(
        hosts.slice(i, i + 200).map((host) => ({
          workspaceId: asset.workspaceId,
          parentAssetId: asset.id,
          host,
          resolves: resolved.get(host) ?? null,
          source: result.source,
          lastSeen: now,
        })),
      )
      .onConflictDoUpdate({
        target: [discoveredHosts.workspaceId, discoveredHosts.host],
        // status is deliberately untouched: a dismissed host stays dismissed.
        set: { lastSeen: now, resolves: sql`excluded.resolves`, source: sql`excluded.source` },
      });
  }

  await db
    .update(assets)
    .set({ lastDiscoveryAt: now, discoveryError: null })
    .where(eq(assets.id, assetId));
  const fresh = hosts.filter((h) => !known.has(h)).length;
  if (fresh > 0) await queueClassification(db, asset.workspaceId);
  console.log(
    `[discovery] ${asset.value}: ${hosts.length} host(s) via ${result.source}, ${fresh} new${result.errors.length ? ` (fell back after: ${result.errors.join("; ")})` : ""}`,
  );
  return fresh;
}

/**
 * Asks the AI agent to look at the new hosts, but only for organizations that turned AI on. Marks the hosts as being
 * analysed so the page can say so.
 */
export async function queueClassification(db: Db, workspaceId: string): Promise<boolean> {
  const { workspaces, aiSettings, discoveredHosts } = schema;
  const [ai] = await db
    .select({ enabled: aiSettings.enabled })
    .from(workspaces)
    .innerJoin(aiSettings, eq(aiSettings.organizationId, workspaces.orgId))
    .where(eq(workspaces.id, workspaceId));
  if (!ai?.enabled) return false;
  await db
    .update(discoveredHosts)
    .set({ aiStatus: "pending", aiError: null })
    .where(
      and(
        eq(discoveredHosts.workspaceId, workspaceId),
        eq(discoveredHosts.status, "new"),
        eq(discoveredHosts.resolves, true),
        sql`${discoveredHosts.aiClassifiedAt} is null`,
      ),
    );
  await enqueue<AiJob>(
    db,
    AI_QUEUE,
    { kind: "classify-hosts", workspaceId },
    { maxAttempts: 3, dedupeKey: `classify:${workspaceId}` },
  );
  return true;
}

/** Claims domain assets whose weekly discovery is due and enqueues a job for each. */
export async function scheduleDiscovery(db: Db, batch = 20): Promise<number> {
  const { assets } = schema;
  return db.transaction(async (tx) => {
    const due = await tx
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.kind, "domain"), lte(assets.nextDiscoveryAt, sql`now()`)))
      .limit(batch)
      .for("update", { skipLocked: true });
    for (const a of due) {
      await tx
        .update(assets)
        .set({ nextDiscoveryAt: sql`now() + ${DISCOVERY_INTERVAL}::interval` })
        .where(eq(assets.id, a.id));
      await enqueue<DiscoverJob>(
        tx,
        DISCOVER_QUEUE,
        { assetId: a.id },
        { dedupeKey: a.id, maxAttempts: 3 },
      );
    }
    return due.length;
  });
}

export async function runDiscovery(db: Db, signal: AbortSignal) {
  const scheduler = (async () => {
    while (!signal.aborted) {
      try {
        const n = await scheduleDiscovery(db);
        if (n > 0) console.log(`[discovery] queued ${n} lookup(s)`);
      } catch (e) {
        console.error("[discovery:schedule]", e);
      }
      await Bun.sleep(10_000);
    }
  })();
  // CT services are rate limited and slow: one lookup at a time.
  await Promise.all([
    scheduler,
    work<DiscoverJob>(db, DISCOVER_QUEUE, async (p) => void (await handleDiscover(db, p)), {
      concurrency: 1,
      signal,
    }),
  ]);
}
