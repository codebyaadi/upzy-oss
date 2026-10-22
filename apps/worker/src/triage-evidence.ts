import type { EvidenceItem } from "@upzy/ai";
import { schema, type Db } from "@upzy/db";
import { resolvePublic, runProbe, type CheckResult } from "@upzy/probes";
import { and, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";

const { incidents, monitors, monitorChecks, assets, findings } = schema;

export interface TriageDeps {
  probe: typeof runProbe;
  resolve: typeof resolvePublic;
  now: () => Date;
}
export const realTriageDeps: TriageDeps = {
  probe: runProbe,
  resolve: resolvePublic,
  now: () => new Date(),
};

const clip = (s: string, n = 400) => (s.length > n ? `${s.slice(0, n)}…` : s);
const minutes = (ms: number) => Math.max(0, Math.round(ms / 60_000));

/** The hostname a monitor target points at, or null when it can't be told. */
export function hostOf(type: string, target: string): string | null {
  try {
    if (type === "http") return new URL(target).hostname.toLowerCase();
    if (type === "tcp") return target.replace(/:\d+$/, "").toLowerCase() || null;
    return target.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Approximate parent domain (last two labels): good enough to group "same site" monitors. */
export const parentDomain = (host: string) => host.split(".").slice(-2).join(".");

const count = (items: string[]) => {
  const m = new Map<string, number>();
  for (const i of items) m.set(i, (m.get(i) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
};

type Check = typeof monitorChecks.$inferSelect;

/** Pure summary of the recent check history. */
export function summarizeChecks(checks: Check[], openedAt: Date): string[] {
  if (checks.length === 0) return ["No checks have been recorded for this monitor."];
  const failed = checks.filter((c) => c.status === "down");
  const passed = checks.filter((c) => c.status === "up");
  const out: string[] = [];
  const oldest = checks.at(-1)!;
  let line = `Of the last ${checks.length} check${checks.length === 1 ? "" : "s"} (since ${oldest.createdAt.toISOString()}), ${failed.length} failed and ${passed.length} passed.`;
  const firstFail = [...failed].reverse()[0];
  if (firstFail) {
    const lead = minutes(openedAt.getTime() - firstFail.createdAt.getTime());
    line += ` The first failure in this window was at ${firstFail.createdAt.toISOString()} (${lead} min before the incident opened).`;
  }
  out.push(line);
  if (failed.length) {
    const kinds = count(failed.map((c) => c.errorKind ?? "unknown"))
      .map(([k, n]) => `${k}×${n}`)
      .join(", ");
    const codes = count(failed.filter((c) => c.statusCode).map((c) => String(c.statusCode)))
      .map(([k, n]) => `${k}×${n}`)
      .join(", ");
    const msgs = count(failed.map((c) => c.error ?? "")).filter(([m]) => m);
    out.push(
      `Failure types: ${kinds}.${codes ? ` HTTP status codes seen: ${codes}.` : ""}${msgs.length ? ` Most common error text: "${clip(msgs[0]![0], 200)}".` : ""}`,
    );
  }
  const ms = (cs: Check[]) => cs.map((c) => c.responseMs).filter((v): v is number => v !== null);
  const avg = (v: number[]) =>
    v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
  const before = avg(ms(passed));
  const during = avg(ms(failed));
  if (before !== null && during !== null)
    out.push(`Average response time: ${before} ms when passing, ${during} ms when failing.`);
  return out;
}

/**
 * Collects the facts for an incident with read-only, deterministic steps: stored checks, one fresh
 * re-check through the same SSRF-guarded probe, DNS, correlated monitors, history and open findings.
 * The model never chooses what to run: it only reads what is returned here.
 */
export async function gatherEvidence(
  db: Db,
  incidentId: string,
  deps: TriageDeps = realTriageDeps,
): Promise<{
  monitor: { name: string; type: string; target: string };
  openedAt: Date;
  evidence: EvidenceItem[];
} | null> {
  const [inc] = await db.select().from(incidents).where(eq(incidents.id, incidentId));
  if (!inc?.monitorId) return null;
  const [m] = await db.select().from(monitors).where(eq(monitors.id, inc.monitorId));
  if (!m) return null;

  const evidence: EvidenceItem[] = [];
  const add = (kind: string, text: string) =>
    evidence.push({ id: `E${evidence.length + 1}`, kind, text: clip(text) });

  const checks = await db
    .select()
    .from(monitorChecks)
    .where(eq(monitorChecks.monitorId, m.id))
    .orderBy(desc(monitorChecks.createdAt))
    .limit(30);
  for (const line of summarizeChecks(checks, inc.createdAt)) add("recent checks", line);

  // A fresh look right now: is it still failing, and does it fail the same way?
  const live: CheckResult | { error: string } = await deps
    .probe({ type: m.type, target: m.target, config: m.config })
    .catch((e: unknown) => ({ error: e instanceof Error ? e.message : "probe failed" }));
  if ("status" in live) {
    add(
      "live re-check",
      live.status === "up"
        ? `A fresh check just now PASSED${live.statusCode ? ` (HTTP ${live.statusCode})` : ""} in ${live.responseMs ?? "?"} ms: the problem may have cleared or be intermittent.`
        : `A fresh check just now FAILED: ${live.error ?? "no detail"}${live.errorKind ? ` (${live.errorKind})` : ""}${live.statusCode ? `, HTTP ${live.statusCode}` : ""}.`,
    );
  } else add("live re-check", `The fresh check could not run: ${live.error}`);

  const host = hostOf(m.type, m.target);
  if (host) {
    try {
      const r = await deps.resolve(host);
      add("dns", `${host} resolves to a public address (${r.address}, IPv${r.family}).`);
    } catch (e) {
      const err = e as { code?: string; message?: string };
      add(
        "dns",
        `${host} does not resolve to a reachable public address: ${err.code ?? err.message ?? "lookup failed"}.`,
      );
    }
  }
  const lastTls = checks.find((c) => c.tlsDaysLeft !== null);
  if (lastTls)
    add("tls", `The most recent recorded certificate had ${lastTls.tlsDaysLeft} days left.`);

  // Other monitors in the workspace: one site failing together points at shared infrastructure.
  const others = await db
    .select({
      id: monitors.id,
      name: monitors.name,
      type: monitors.type,
      target: monitors.target,
      lastStatus: monitors.lastStatus,
    })
    .from(monitors)
    .where(
      and(
        eq(monitors.workspaceId, m.workspaceId),
        eq(monitors.active, true),
        ne(monitors.id, m.id),
      ),
    );
  if (host) {
    const parent = parentDomain(host);
    const same = others.filter((o) => {
      const h = hostOf(o.type, o.target);
      return h && parentDomain(h) === parent;
    });
    if (same.length) {
      const down = same.filter((o) => o.lastStatus === "down");
      add(
        "related monitors",
        `${same.length} other monitor(s) on ${parent}: ${down.length} down${down.length ? ` (${down.map((o) => o.name).join(", ")})` : ""}, ${same.length - down.length} not down.`,
      );
    }
  }
  const downElsewhere = others.filter((o) => o.lastStatus === "down").length;
  if (others.length)
    add(
      "workspace",
      `${downElsewhere} of ${others.length} other active monitors in this workspace are currently down.`,
    );

  const since = new Date(deps.now().getTime() - 90 * 86_400_000);
  const past = await db
    .select({
      createdAt: incidents.createdAt,
      resolvedAt: incidents.resolvedAt,
      title: incidents.title,
    })
    .from(incidents)
    .where(
      and(eq(incidents.monitorId, m.id), ne(incidents.id, inc.id), gte(incidents.createdAt, since)),
    )
    .orderBy(desc(incidents.createdAt))
    .limit(5);
  if (past.length) {
    const durations = past
      .filter((p) => p.resolvedAt)
      .map((p) => minutes(p.resolvedAt!.getTime() - p.createdAt.getTime()));
    add(
      "history",
      `${past.length} earlier incident(s) on this monitor in the last 90 days${durations.length ? `, resolved after ${durations.join(", ")} min` : ""}. Most recent: "${clip(past[0]!.title, 160)}".`,
    );
  } else add("history", "No earlier incidents on this monitor in the last 90 days.");

  if (host) {
    const rows = await db
      .select({ severity: findings.severity, title: findings.title })
      .from(findings)
      .innerJoin(assets, eq(assets.id, findings.assetId))
      .where(
        and(
          eq(findings.workspaceId, m.workspaceId),
          eq(findings.status, "open"),
          inArray(findings.severity, ["critical", "high"]),
          sql`(${assets.value} in (${host}, ${parentDomain(host)}) or ${assets.value} like ${`%.${parentDomain(host)}`})`,
        ),
      )
      .limit(5);
    if (rows.length)
      add(
        "security",
        `Open critical/high security findings on this site: ${rows.map((r) => `${r.severity}: ${r.title}`).join("; ")}.`,
      );
  }

  return {
    monitor: { name: m.name, type: m.type, target: m.target },
    openedAt: inc.createdAt,
    evidence,
  };
}
