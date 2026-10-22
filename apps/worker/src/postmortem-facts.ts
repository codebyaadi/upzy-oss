import { schema, type Db } from "@upzy/db";
import type { PostmortemContent } from "@upzy/db";
import { and, asc, eq, gte, lte, ne } from "drizzle-orm";

const { incidents, monitors, monitorChecks, notificationDeliveries, notificationChannels } = schema;

const iso = (d: Date) => d.toISOString();
const clip = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n)}…` : s);
const count = (items: string[]) => {
  const m = new Map<string, number>();
  for (const i of items) m.set(i, (m.get(i) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
};

export interface PostmortemFacts {
  monitor: { name: string; type: string; target: string };
  openedAt: Date;
  resolvedAt: Date;
  durationMinutes: number;
  facts: string[];
  /** Built from recorded events only: the model never writes this part. */
  timeline: PostmortemContent["timeline"];
}

/** Everything Upzy recorded about a resolved incident, as plain facts plus a deterministic timeline. */
export async function gatherPostmortemFacts(
  db: Db,
  incidentId: string,
): Promise<PostmortemFacts | null> {
  const [inc] = await db.select().from(incidents).where(eq(incidents.id, incidentId));
  if (!inc?.monitorId || !inc.resolvedAt) return null;
  const [m] = await db.select().from(monitors).where(eq(monitors.id, inc.monitorId));
  if (!m) return null;

  const durationMinutes = Math.max(
    1,
    Math.round((inc.resolvedAt.getTime() - inc.createdAt.getTime()) / 60_000),
  );
  const timeline: PostmortemFacts["timeline"] = [];
  const facts: string[] = [
    `Incident title: ${clip(inc.title)}`,
    `Monitor: ${m.name} (${m.type}) checks every ${m.interval}s and declares an outage after ${m.failureThreshold} consecutive failures.`,
    `Opened ${iso(inc.createdAt)}, resolved ${iso(inc.resolvedAt)}: ${durationMinutes} minute(s) of downtime.`,
  ];

  // Checks from shortly before the incident to its end.
  const from = new Date(inc.createdAt.getTime() - 15 * 60_000);
  const checks = await db
    .select()
    .from(monitorChecks)
    .where(
      and(
        eq(monitorChecks.monitorId, m.id),
        gte(monitorChecks.createdAt, from),
        lte(monitorChecks.createdAt, new Date(inc.resolvedAt.getTime() + 5 * 60_000)),
      ),
    )
    .orderBy(asc(monitorChecks.createdAt))
    .limit(500);
  const failed = checks.filter((c) => c.status === "down");
  const firstFail = failed[0];
  const recovery = checks.find((c) => c.status === "up" && c.createdAt >= inc.createdAt);
  if (firstFail) {
    timeline.push({
      at: iso(firstFail.createdAt),
      event: `First failed check${firstFail.error ? `: ${clip(firstFail.error, 160)}` : ""}`,
    });
    const kinds = count(failed.map((c) => c.errorKind ?? "unknown"))
      .map(([k, n]) => `${k}×${n}`)
      .join(", ");
    const codes = count(failed.filter((c) => c.statusCode).map((c) => String(c.statusCode)))
      .map(([k, n]) => `${k}×${n}`)
      .join(", ");
    facts.push(
      `${failed.length} of ${checks.length} checks in the window failed. Failure types: ${kinds}.${codes ? ` HTTP statuses: ${codes}.` : ""}`,
    );
    const topError = count(failed.map((c) => c.error ?? "")).find(([e]) => e);
    if (topError) facts.push(`Most common error text: "${clip(topError[0], 200)}".`);
  } else facts.push("No failed checks were stored for the window.");
  timeline.push({ at: iso(inc.createdAt), event: "Incident opened and the outage was declared" });

  const sent = await db
    .select({
      at: notificationDeliveries.createdAt,
      event: notificationDeliveries.event,
      status: notificationDeliveries.status,
      kind: notificationChannels.kind,
    })
    .from(notificationDeliveries)
    .innerJoin(notificationChannels, eq(notificationChannels.id, notificationDeliveries.channelId))
    .where(eq(notificationDeliveries.incidentId, inc.id))
    .orderBy(asc(notificationDeliveries.createdAt));
  for (const d of sent) {
    const what = d.event === "incident.opened" ? "down alert" : "recovery alert";
    timeline.push({
      at: iso(d.at),
      event: `${d.status === "sent" ? "Sent" : "Failed to send"} ${what} via ${d.kind}`,
    });
  }
  facts.push(
    sent.length
      ? `${sent.filter((d) => d.status === "sent").length} of ${sent.length} alert deliveries succeeded.`
      : "No alert deliveries were recorded for this incident.",
  );

  if (recovery) timeline.push({ at: iso(recovery.createdAt), event: "First passing check" });
  timeline.push({ at: iso(inc.resolvedAt), event: "Incident resolved automatically" });

  const t = inc.aiTriage as { likelyCause?: string; summary?: string; confidence?: string } | null;
  if (t?.summary)
    facts.push(
      `Earlier AI analysis during the incident (unverified): ${clip(t.summary)} Likely cause: ${t.likelyCause}, ${t.confidence} confidence.`,
    );

  const past = await db
    .select({ id: incidents.id })
    .from(incidents)
    .where(
      and(
        eq(incidents.monitorId, m.id),
        ne(incidents.id, inc.id),
        gte(incidents.createdAt, new Date(inc.createdAt.getTime() - 90 * 86_400_000)),
      ),
    );
  facts.push(`${past.length} other incident(s) on this monitor in the 90 days before.`);

  timeline.sort((a, b) => a.at.localeCompare(b.at));
  return {
    monitor: { name: m.name, type: m.type, target: m.target },
    openedAt: inc.createdAt,
    resolvedAt: inc.resolvedAt,
    durationMinutes,
    facts,
    timeline,
  };
}
