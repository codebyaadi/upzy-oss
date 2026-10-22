import { lookup } from "node:dns/promises";

import { schema, type Db } from "@upzy/db";
import { enqueue, work } from "@upzy/queue";
import { and, asc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";

import { hostOf, parentDomain } from "../triage-evidence";
import { AI_QUEUE, type AiJob } from "./agent";

export const CORRELATE_QUEUE = "correlate";
export interface CorrelateJob {
  incidentId: string;
}

/** Incidents opened within this long of each other can be grouped. */
export const WINDOW_MS = 5 * 60_000;
const MAX_GROUP_FOR_AI = 20;

export interface CorrelateDeps {
  /** All addresses a hostname resolves to (empty when it doesn't resolve). */
  addresses: (host: string) => Promise<string[]>;
}
export const realCorrelateDeps: CorrelateDeps = {
  addresses: async (host) => {
    try {
      const rows = await Promise.race([
        lookup(host, { all: true }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("dns timeout")), 4000)),
      ]);
      return [...new Set(rows.map((r) => r.address))].sort().slice(0, 8);
    } catch {
      return [];
    }
  },
};

/**
 * What an incident's monitor shares with others: its site (parent domain) and every address it resolves to.
 * Addresses come first, because they are the more specific signal.
 */
export function correlationKeys(host: string | null, addresses: string[]): string[] {
  if (!host) return [];
  return [...addresses.map((a) => `ip:${a}`), `domain:${parentDomain(host)}`];
}

/** The first of `mine` that also appears in `theirs`: the reason two incidents belong together. */
export const sharedKey = (mine: string[], theirs: string[]) => mine.find((k) => theirs.includes(k));

const { incidents, incidentGroups, monitors, workspaces, aiSettings } = schema;

/**
 * Puts a newly opened incident in a group with the other open incidents of its workspace that opened within five
 * minutes and share a site or IP address with it. Grouping never hides or delays anything: every incident keeps
 * its own alerts. Returns the group when one now exists.
 */
export async function handleCorrelate(
  db: Db,
  incidentId: string,
  deps: CorrelateDeps = realCorrelateDeps,
): Promise<{ groupId: string; size: number; reason: string } | null> {
  const [row] = await db
    .select({
      inc: incidents,
      type: monitors.type,
      target: monitors.target,
      orgId: workspaces.orgId,
    })
    .from(incidents)
    .innerJoin(monitors, eq(monitors.id, incidents.monitorId))
    .innerJoin(workspaces, eq(workspaces.id, incidents.workspaceId))
    .where(eq(incidents.id, incidentId));
  if (!row) return null;
  const inc = row.inc;
  const host = hostOf(row.type, row.target);
  const keys = correlationKeys(host, host ? await deps.addresses(host) : []);

  const outcome = await db.transaction(async (tx) => {
    // One correlation at a time per workspace, so two incidents opening together can't create two groups.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${inc.workspaceId}))`);
    await tx.update(incidents).set({ correlationKeys: keys }).where(eq(incidents.id, inc.id));
    if (keys.length === 0) return null;

    const near = await tx
      .select({ id: incidents.id, keys: incidents.correlationKeys, groupId: incidents.groupId })
      .from(incidents)
      .where(
        and(
          eq(incidents.workspaceId, inc.workspaceId),
          ne(incidents.id, inc.id),
          ne(incidents.status, "resolved"),
          gte(incidents.createdAt, new Date(inc.createdAt.getTime() - WINDOW_MS)),
          lte(incidents.createdAt, new Date(inc.createdAt.getTime() + WINDOW_MS)),
        ),
      )
      .limit(200);
    const related = near.filter((n) => n.keys && sharedKey(keys, n.keys));
    if (related.length === 0) return null;

    const reason = sharedKey(keys, related[0]!.keys!)!;
    const groupIds = [
      ...new Set([inc.groupId, ...related.map((r) => r.groupId)].filter(Boolean)),
    ] as string[];
    let groupId: string;
    if (groupIds.length === 0) {
      [{ id: groupId }] = (await tx
        .insert(incidentGroups)
        .values({ workspaceId: inc.workspaceId, sharedKey: reason })
        .returning({ id: incidentGroups.id })) as [{ id: string }];
    } else {
      // Join the oldest existing group and fold any others into it.
      const [oldest] = await tx
        .select({ id: incidentGroups.id })
        .from(incidentGroups)
        .where(inArray(incidentGroups.id, groupIds))
        .orderBy(asc(incidentGroups.createdAt))
        .limit(1);
      groupId = oldest!.id;
    }
    await tx
      .update(incidents)
      .set({ groupId })
      .where(inArray(incidents.id, [inc.id, ...related.map((r) => r.id)]));
    if (groupIds.length > 1)
      await tx.update(incidents).set({ groupId }).where(inArray(incidents.groupId, groupIds));
    const [{ n }] = (await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(incidents)
      .where(eq(incidents.groupId, groupId))) as [{ n: number }];
    return { groupId, size: n, reason };
  });
  if (!outcome) return null;

  // An explanation is only written for organizations that turned AI on.
  const [ai] = await db
    .select({ enabled: aiSettings.enabled })
    .from(aiSettings)
    .where(eq(aiSettings.organizationId, row.orgId));
  if (ai?.enabled && outcome.size <= MAX_GROUP_FOR_AI) {
    await db
      .update(incidentGroups)
      .set({ summaryStatus: "pending", summaryError: null })
      .where(eq(incidentGroups.id, outcome.groupId));
    await enqueue<AiJob>(
      db,
      AI_QUEUE,
      { kind: "group-summary", groupId: outcome.groupId },
      { maxAttempts: 3, dedupeKey: `group:${outcome.groupId}:${outcome.size}` },
    );
  }
  return outcome;
}

export const runCorrelator = (db: Db, signal: AbortSignal) =>
  work<CorrelateJob>(
    db,
    CORRELATE_QUEUE,
    (job) => handleCorrelate(db, job.incidentId).then(() => {}),
    {
      concurrency: 2,
      signal,
    },
  );
