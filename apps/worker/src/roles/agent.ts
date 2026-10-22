import {
  AiBudgetExceededError,
  AiDisabledError,
  AiError,
  AiNotConfiguredError,
  AiUnavailableError,
  explainFinding,
  narrateDigest,
  triageIncident,
  draftPostmortem,
  summarizeGroup,
  classifyHosts,
  type DigestNarrative,
  type DigestStats,
  type Gateway,
} from "@upzy/ai";
import { EMAIL_QUEUE, type Email } from "@upzy/auth/email";
import { schema, type Db } from "@upzy/db";
import { enqueue, work } from "@upzy/queue";
import { describeStack, type Stack } from "@upzy/security";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { computeDigestStats, weekStartOf } from "../digest-stats";
import { profileHost, realProfileDeps, type ProfileDeps } from "../host-profile";
import { gatherPostmortemFacts } from "../postmortem-facts";
import { hostOf } from "../triage-evidence";
import { gatherEvidence, realTriageDeps, type TriageDeps } from "../triage-evidence";

export const AI_QUEUE = "ai";

export type AiJob =
  | { kind: "explain-finding"; findingId: string }
  | { kind: "digest"; workspaceId: string; weekStart: string }
  | { kind: "triage-incident"; incidentId: string }
  | { kind: "postmortem"; incidentId: string; notes?: string }
  | { kind: "group-summary"; groupId: string }
  | { kind: "classify-hosts"; workspaceId: string };

const {
  findings,
  assets,
  workspaces,
  aiSettings,
  digestRuns,
  members,
  users,
  incidents,
  postmortems,
} = schema;
const { incidentGroups, monitors, monitorChecks, discoveredHosts } = schema;

/** Conditions that retrying won't fix: record them on the record and stop. */
const isPermanent = (e: unknown) =>
  e instanceof AiDisabledError ||
  e instanceof AiBudgetExceededError ||
  e instanceof AiNotConfiguredError;

/** Pulls the exploitation signals the CVE check stored in a finding's evidence. */
function exploitationSignals(evidence: Record<string, unknown>): { kev?: boolean; epss?: number } {
  const cves = Array.isArray(evidence.cves)
    ? (evidence.cves as { kev?: boolean; epss?: number | null }[])
    : [];
  if (cves.length === 0) return {};
  return { kev: cves.some((c) => c.kev), epss: Math.max(0, ...cves.map((c) => c.epss ?? 0)) };
}

/**
 * Writes an AI explanation onto a finding. "Expected" AI conditions (off, over budget, no provider) are recorded
 * on the finding and do not retry; only transient provider trouble throws so the queue tries again.
 */
export async function handleExplain(
  db: Db,
  gateway: Gateway,
  findingId: string,
  finalAttempt: boolean,
) {
  const [row] = await db
    .select({
      finding: findings,
      assetKind: assets.kind,
      assetValue: assets.value,
      assetStack: assets.stack,
      orgId: workspaces.orgId,
    })
    .from(findings)
    .innerJoin(assets, eq(assets.id, findings.assetId))
    .innerJoin(workspaces, eq(workspaces.id, findings.workspaceId))
    .where(eq(findings.id, findingId));
  if (!row) return;
  const f = row.finding;

  try {
    const result = await explainFinding(gateway, row.orgId, {
      checkKey: f.checkKey,
      severity: f.severity,
      title: f.title,
      description: f.description,
      remediation: f.remediation,
      evidence: f.evidence,
      assetKind: row.assetKind,
      assetValue: row.assetValue,
      ...(row.assetStack ? { stack: describeStack(row.assetStack as Stack) } : {}),
      ...exploitationSignals(f.evidence),
    });
    await db
      .update(findings)
      .set({
        aiExplanation: {
          ...result.data,
          model: `${result.provider}/${result.model}`,
          cached: result.cached,
        },
        aiExplainedAt: new Date(),
        aiExplainStatus: null,
        aiExplainError: null,
      })
      .where(eq(findings.id, findingId));
    console.log(
      `[ai] explained finding ${f.checkKey} via ${result.provider}${result.cached ? " (cached)" : ""}`,
    );
  } catch (e) {
    const permanent = isPermanent(e);
    if (e instanceof AiError && (permanent || finalAttempt)) {
      await db
        .update(findings)
        .set({ aiExplainStatus: "failed", aiExplainError: e.userMessage })
        .where(eq(findings.id, findingId));
      return;
    }
    // Transient (provider down/rate limited) and attempts remain: let the queue back off and retry.
    if (e instanceof AiUnavailableError) throw e;
    await db
      .update(findings)
      .set({ aiExplainStatus: "failed", aiExplainError: "AI explanation failed unexpectedly." })
      .where(eq(findings.id, findingId));
    throw e;
  }
}

/**
 * Reads the evidence Upzy collected about a new incident and stores a likely cause on it. Failure to
 * triage never touches the incident or its alerts: it only records why there is no analysis.
 */
export async function handleTriage(
  db: Db,
  gateway: Gateway,
  incidentId: string,
  finalAttempt: boolean,
  deps: TriageDeps = realTriageDeps,
) {
  const [row] = await db
    .select({ id: incidents.id, orgId: workspaces.orgId })
    .from(incidents)
    .innerJoin(workspaces, eq(workspaces.id, incidents.workspaceId))
    .where(eq(incidents.id, incidentId));
  if (!row) return;
  const fail = (message: string) =>
    db
      .update(incidents)
      .set({ aiTriageStatus: "failed", aiTriageError: message })
      .where(eq(incidents.id, incidentId));

  try {
    const gathered = await gatherEvidence(db, incidentId, deps);
    if (!gathered) {
      await fail("This incident has no monitor to analyse.");
      return;
    }
    const result = await triageIncident(gateway, row.orgId, {
      monitor: gathered.monitor,
      openedAt: gathered.openedAt.toISOString(),
      evidence: gathered.evidence,
    });
    await db
      .update(incidents)
      .set({
        aiTriage: {
          ...result.data,
          // The facts are stored beside the conclusion so every citation can be shown and checked.
          facts: gathered.evidence,
          model: `${result.provider}/${result.model}`,
        },
        aiTriagedAt: new Date(),
        aiTriageStatus: null,
        aiTriageError: null,
      })
      .where(eq(incidents.id, incidentId));
    console.log(`[ai] triaged incident: ${result.data.likelyCause} (${result.data.confidence})`);
  } catch (e) {
    const permanent = isPermanent(e);
    if (e instanceof AiError && (permanent || finalAttempt)) {
      await fail(e.userMessage);
      return;
    }
    if (e instanceof AiUnavailableError) throw e;
    await fail("AI analysis failed unexpectedly.");
    throw e;
  }
}

/**
 * Writes a postmortem draft for a resolved incident. A failure only records why on the postmortem row; text a
 * person already wrote or edited is never replaced by a failed run.
 */
export async function handlePostmortem(
  db: Db,
  gateway: Gateway,
  incidentId: string,
  notes: string | undefined,
  finalAttempt: boolean,
) {
  const [row] = await db
    .select({ orgId: workspaces.orgId })
    .from(incidents)
    .innerJoin(workspaces, eq(workspaces.id, incidents.workspaceId))
    .where(eq(incidents.id, incidentId));
  if (!row) return;
  const fail = (message: string) =>
    db
      .update(postmortems)
      .set({ status: "failed", error: message, updatedAt: new Date() })
      .where(eq(postmortems.incidentId, incidentId));

  try {
    const g = await gatherPostmortemFacts(db, incidentId);
    if (!g) {
      await fail("A postmortem can only be written for a resolved incident that has a monitor.");
      return;
    }
    const result = await draftPostmortem(gateway, row.orgId, {
      monitor: g.monitor,
      openedAt: g.openedAt.toISOString(),
      resolvedAt: g.resolvedAt.toISOString(),
      durationMinutes: g.durationMinutes,
      facts: g.facts,
      notes,
    });
    await db
      .update(postmortems)
      .set({
        // The timeline comes from recorded events, never from the model.
        content: { ...result.data, timeline: g.timeline },
        aiGenerated: true,
        model: `${result.provider}/${result.model}`,
        status: null,
        error: null,
        updatedAt: new Date(),
      })
      // Someone saved their own text while the draft was being written: theirs wins.
      .where(and(eq(postmortems.incidentId, incidentId), eq(postmortems.status, "pending")));
    console.log("[ai] drafted postmortem");
  } catch (e) {
    const permanent = isPermanent(e);
    if (e instanceof AiError && (permanent || finalAttempt)) {
      await fail(e.userMessage);
      return;
    }
    if (e instanceof AiUnavailableError) throw e;
    await fail("Drafting the postmortem failed unexpectedly.");
    throw e;
  }
}

const CLASSIFY_BATCH = 10;
const CLASSIFY_PER_JOB = 30;

/**
 * Looks at newly discovered subdomains: one anonymous request each (collected by code through the SSRF guard), then
 * a model reads those facts and labels what each host probably is and whether it looks risky. Suggestions only:
 * nothing is added, scanned or dismissed from here.
 */
export async function handleClassifyHosts(
  db: Db,
  gateway: Gateway,
  workspaceId: string,
  finalAttempt: boolean,
  deps: ProfileDeps = realProfileDeps,
) {
  const [ws] = await db
    .select({ orgId: workspaces.orgId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  if (!ws) return;
  const rows = await db
    .select({
      id: discoveredHosts.id,
      host: discoveredHosts.host,
      parent: assets.value,
    })
    .from(discoveredHosts)
    .innerJoin(assets, eq(assets.id, discoveredHosts.parentAssetId))
    .where(
      and(
        eq(discoveredHosts.workspaceId, workspaceId),
        eq(discoveredHosts.status, "new"),
        eq(discoveredHosts.resolves, true),
        isNull(discoveredHosts.aiClassifiedAt),
      ),
    )
    .orderBy(discoveredHosts.firstSeen)
    .limit(CLASSIFY_PER_JOB);
  if (rows.length === 0) return;
  const ids = rows.map((r) => r.id);
  const fail = (message: string) =>
    db
      .update(discoveredHosts)
      .set({ aiStatus: "failed", aiError: message })
      .where(inArray(discoveredHosts.id, ids));

  try {
    // Profiles first (a few at a time, politely), stored whether or not the model call succeeds.
    const profiles = new Map<string, Awaited<ReturnType<typeof profileHost>>>();
    for (let i = 0; i < rows.length; i += 5) {
      await Promise.all(
        rows.slice(i, i + 5).map(async (r) => {
          const p = await profileHost(r.host, true, deps);
          profiles.set(r.host, p);
          await db
            .update(discoveredHosts)
            .set({ profile: p as unknown as Record<string, unknown> })
            .where(eq(discoveredHosts.id, r.id));
        }),
      );
    }
    const byParent = new Map<string, typeof rows>();
    for (const r of rows) byParent.set(r.parent, [...(byParent.get(r.parent) ?? []), r]);
    let classified = 0;
    for (const [parent, group] of byParent) {
      for (let i = 0; i < group.length; i += CLASSIFY_BATCH) {
        const batch = group.slice(i, i + CLASSIFY_BATCH);
        const result = await classifyHosts(
          gateway,
          ws.orgId,
          parent,
          batch.map((b) => profiles.get(b.host)!),
        );
        for (const v of result.data.hosts) {
          const row = batch.find((b) => b.host === v.host)!;
          await db
            .update(discoveredHosts)
            .set({
              aiClassification: { ...v, model: `${result.provider}/${result.model}` },
              aiClassifiedAt: new Date(),
              aiStatus: null,
              aiError: null,
            })
            .where(eq(discoveredHosts.id, row.id));
          classified++;
        }
      }
    }
    // Hosts the model skipped aren't left "pending" forever.
    await db
      .update(discoveredHosts)
      .set({ aiStatus: null })
      .where(and(inArray(discoveredHosts.id, ids), isNull(discoveredHosts.aiClassifiedAt)));
    console.log(`[ai] classified ${classified} of ${rows.length} discovered host(s)`);

    // More waiting than one job handles: queue the next slice.
    const [left] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(discoveredHosts)
      .where(
        and(
          eq(discoveredHosts.workspaceId, workspaceId),
          eq(discoveredHosts.status, "new"),
          eq(discoveredHosts.resolves, true),
          isNull(discoveredHosts.aiClassifiedAt),
          isNull(discoveredHosts.aiStatus),
        ),
      );
    if ((left?.n ?? 0) > 0 && classified > 0)
      await enqueue<AiJob>(
        db,
        AI_QUEUE,
        { kind: "classify-hosts", workspaceId },
        { maxAttempts: 3, dedupeKey: `classify:${workspaceId}` },
      );
  } catch (e) {
    if (e instanceof AiError && (isPermanent(e) || finalAttempt)) {
      await fail(e.userMessage);
      return;
    }
    if (e instanceof AiUnavailableError) throw e;
    await fail("The analysis failed unexpectedly.");
    throw e;
  }
}

/** Writes the explanation of a group of related incidents from facts about its members. */
export async function handleGroupSummary(
  db: Db,
  gateway: Gateway,
  groupId: string,
  finalAttempt: boolean,
) {
  const [g] = await db
    .select({
      id: incidentGroups.id,
      workspaceId: incidentGroups.workspaceId,
      key: incidentGroups.sharedKey,
      orgId: workspaces.orgId,
    })
    .from(incidentGroups)
    .innerJoin(workspaces, eq(workspaces.id, incidentGroups.workspaceId))
    .where(eq(incidentGroups.id, groupId));
  if (!g) return;
  const fail = (message: string) =>
    db
      .update(incidentGroups)
      .set({ summaryStatus: "failed", summaryError: message })
      .where(eq(incidentGroups.id, groupId));

  try {
    const members = await db
      .select({
        id: incidents.id,
        title: incidents.title,
        status: incidents.status,
        createdAt: incidents.createdAt,
        name: monitors.name,
        type: monitors.type,
        target: monitors.target,
        monitorId: monitors.id,
      })
      .from(incidents)
      .innerJoin(monitors, eq(monitors.id, incidents.monitorId))
      .where(eq(incidents.groupId, groupId))
      .orderBy(incidents.createdAt);
    if (members.length < 2) {
      await db
        .update(incidentGroups)
        .set({ summaryStatus: null })
        .where(eq(incidentGroups.id, groupId));
      return;
    }
    const t0 = members[0]!.createdAt.getTime();
    const evidence: { id: string; kind: string; text: string }[] = [];
    const add = (kind: string, text: string) =>
      evidence.push({ id: `E${evidence.length + 1}`, kind, text: text.slice(0, 400) });
    add(
      "grouping",
      `These ${members.length} incidents opened within minutes of each other and share: ${g.key}.`,
    );
    for (const m of members) {
      const [last] = await db
        .select({
          error: monitorChecks.error,
          kind: monitorChecks.errorKind,
          code: monitorChecks.statusCode,
        })
        .from(monitorChecks)
        .where(and(eq(monitorChecks.monitorId, m.monitorId), eq(monitorChecks.status, "down")))
        .orderBy(desc(monitorChecks.createdAt))
        .limit(1);
      add(
        "member",
        `${m.name} (${m.type} ${hostOf(m.type, m.target) ?? "?"}) opened +${Math.round((m.createdAt.getTime() - t0) / 1000)}s after the first; ${m.status}. Failure: ${last?.kind ?? "unknown"}${last?.code ? ` HTTP ${last.code}` : ""}${last?.error ? `, "${last.error.slice(0, 160)}"` : ""}.`,
      );
    }
    const [others] = await db
      .select({
        down: sql<number>`count(*) filter (where ${monitors.lastStatus} = 'down')::int`,
        total: sql<number>`count(*)::int`,
      })
      .from(monitors)
      .where(and(eq(monitors.workspaceId, g.workspaceId), eq(monitors.active, true)));
    add(
      "workspace",
      `${others?.down ?? 0} of ${others?.total ?? 0} active monitors in the workspace are currently down.`,
    );

    const result = await summarizeGroup(gateway, g.orgId, { sharedKey: g.key, evidence });
    await db
      .update(incidentGroups)
      .set({
        summary: {
          ...result.data,
          facts: evidence,
          model: `${result.provider}/${result.model}`,
          size: members.length,
        },
        summaryAt: new Date(),
        summaryStatus: null,
        summaryError: null,
      })
      .where(eq(incidentGroups.id, groupId));
    console.log(`[ai] summarised a group of ${members.length} incidents`);
  } catch (e) {
    const permanent = isPermanent(e);
    if (e instanceof AiError && (permanent || finalAttempt)) {
      await fail(e.userMessage);
      return;
    }
    if (e instanceof AiUnavailableError) throw e;
    await fail("The group summary failed unexpectedly.");
    throw e;
  }
}

const pct = (v: number | null) => (v === null ? "no data" : `${(v * 100).toFixed(2)}%`);

/** The digest body. The numbers always come from `stats`; the narrative, when AI is available, is added on top. */
export function renderDigest(
  stats: DigestStats,
  narrative: DigestNarrative | null,
  appUrl: string,
): Email["text"] {
  const lines: string[] = [];
  lines.push(
    `Weekly summary for ${stats.workspace}`,
    `${stats.periodStart} to ${stats.periodEnd}`,
    "",
  );
  if (narrative) {
    lines.push(narrative.headline, "", narrative.summary, "");
    if (narrative.highlights.length) lines.push(...narrative.highlights.map((h) => `- ${h}`), "");
    if (narrative.actions.length)
      lines.push("Worth doing:", ...narrative.actions.map((a) => `- ${a}`), "");
  }
  lines.push("Uptime");
  lines.push(
    ...(stats.monitors.length
      ? stats.monitors.map(
          (m) =>
            `- ${m.name}: ${pct(m.uptime)}${m.avgMs !== null ? `, avg ${m.avgMs} ms` : ""} (${m.checks} checks)`,
        )
      : ["- No monitors yet"]),
  );
  lines.push(
    "",
    `Incidents: ${stats.incidents.opened} opened, ${stats.incidents.resolved} resolved, ${stats.incidents.stillOpen} still open, ${stats.incidents.totalDowntimeMinutes} min of downtime`,
  );
  lines.push(
    `Security findings: ${stats.findings.new} new, ${stats.findings.resolved} resolved, ${stats.findings.open} open`,
  );
  if (stats.findings.topOpen.length)
    lines.push(
      "Top open findings:",
      ...stats.findings.topOpen.map((f) => `- [${f.severity}] ${f.title} (${f.asset})`),
    );
  lines.push("", `Open the dashboard: ${appUrl}/monitors`);
  return lines.join("\n");
}

export async function handleDigest(
  db: Db,
  gateway: Gateway,
  appUrl: string,
  workspaceId: string,
  weekStart: string,
) {
  const [ws] = await db
    .select({ orgId: workspaces.orgId, name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  if (!ws) return;

  const recipients = await db
    .selectDistinct({ email: users.email })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(members.organizationId, ws.orgId), inArray(members.role, ["owner", "admin"])));
  if (recipients.length === 0) return;

  const stats = await computeDigestStats(db, workspaceId, weekStart);
  let narrative: DigestNarrative | null = null;
  try {
    narrative = (await narrateDigest(gateway, ws.orgId, stats)).data;
  } catch (e) {
    // Fail soft: the numbers are the digest; the prose is a bonus.
    if (!(e instanceof AiError)) throw e;
    console.warn(`[ai] digest narrative skipped: ${e.message}`);
  }

  const text = renderDigest(stats, narrative, appUrl);
  for (const r of recipients) {
    await enqueue<Email>(
      db,
      EMAIL_QUEUE,
      { to: r.email, subject: `Your weekly Upzy summary: ${ws.name}`, text },
      { maxAttempts: 5, dedupeKey: `digest:${workspaceId}:${weekStart}:${r.email}` },
    );
  }
  await db
    .update(digestRuns)
    .set({ recipients: recipients.length, usedAi: narrative !== null })
    .where(and(eq(digestRuns.workspaceId, workspaceId), eq(digestRuns.weekStart, weekStart)));
  console.log(
    `[ai] digest for ${ws.name}: ${recipients.length} recipient(s), ${narrative ? "with" : "without"} AI narrative`,
  );
}

/**
 * Once a week (Monday, 07:00 UTC onwards) claims a digest slot per workspace of every AI-enabled organization.
 * The unique (workspace, week) row makes this safe with several workers: only the one that inserts it enqueues.
 */
export async function scheduleDigests(db: Db, now = new Date()): Promise<number> {
  const weekStart = weekStartOf(now);
  const weekBegan = Date.parse(`${weekStart}T07:00:00Z`);
  if (now.getTime() < weekBegan) return 0;

  const candidates = await db
    .select({ workspaceId: workspaces.id })
    .from(workspaces)
    .innerJoin(
      aiSettings,
      and(eq(aiSettings.organizationId, workspaces.orgId), eq(aiSettings.enabled, true)),
    );

  let queued = 0;
  for (const c of candidates) {
    const claimed = await db
      .insert(digestRuns)
      .values({ workspaceId: c.workspaceId, weekStart })
      .onConflictDoNothing()
      .returning({ id: digestRuns.id });
    if (claimed.length === 0) continue;
    await enqueue<AiJob>(
      db,
      AI_QUEUE,
      { kind: "digest", workspaceId: c.workspaceId, weekStart },
      { maxAttempts: 3, dedupeKey: `digest:${c.workspaceId}:${weekStart}` },
    );
    queued++;
  }
  return queued;
}

export async function runAgent(db: Db, gateway: Gateway, appUrl: string, signal: AbortSignal) {
  const scheduler = (async () => {
    while (!signal.aborted) {
      try {
        const n = await scheduleDigests(db);
        if (n > 0) console.log(`[ai] queued ${n} weekly digest(s)`);
      } catch (e) {
        console.error("[ai:schedule]", e);
      }
      await Bun.sleep(10 * 60_000);
    }
  })();
  // Free tiers are rate limited: one AI job at a time.
  await Promise.all([
    scheduler,
    work<AiJob>(
      db,
      AI_QUEUE,
      async (job, meta) => {
        if (job.kind === "explain-finding")
          return handleExplain(db, gateway, job.findingId, meta.attempts >= meta.maxAttempts);
        if (job.kind === "classify-hosts")
          return handleClassifyHosts(
            db,
            gateway,
            job.workspaceId,
            meta.attempts >= meta.maxAttempts,
          );
        if (job.kind === "group-summary")
          return handleGroupSummary(db, gateway, job.groupId, meta.attempts >= meta.maxAttempts);
        if (job.kind === "postmortem")
          return handlePostmortem(
            db,
            gateway,
            job.incidentId,
            job.notes,
            meta.attempts >= meta.maxAttempts,
          );
        if (job.kind === "triage-incident")
          return handleTriage(db, gateway, job.incidentId, meta.attempts >= meta.maxAttempts);
        return handleDigest(db, gateway, appUrl, job.workspaceId, job.weekStart);
      },
      { concurrency: 1, signal },
    ),
  ]);
}
