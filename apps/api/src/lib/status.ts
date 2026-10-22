/**
 * What the public status page shows, computed from facts that are safe to publish: when each monitor had an
 * incident. "Down" means what it means everywhere else in Upzy (an incident was open, so the failure threshold was
 * crossed); a single failed check never shows up here.
 */
export interface Outage {
  start: Date;
  /** Null while it is still going on. */
  end: Date | null;
}

export interface Day {
  /** UTC calendar day, YYYY-MM-DD. */
  date: string;
  /** Percent of the day the monitor was up, or null before the monitor existed. */
  uptime: number | null;
}

const DAY = 86_400_000;
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);
const startOfDay = (t: number) => Math.floor(t / DAY) * DAY;

/** One entry per UTC day for the last `days` days, oldest first, ending today. */
export function dailyUptime(outages: Outage[], createdAt: Date, now: Date, days = 90): Day[] {
  const today = startOfDay(now.getTime());
  const out: Day[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const from = today - i * DAY;
    const to = Math.min(from + DAY, now.getTime());
    if (to <= createdAt.getTime() || to <= from) {
      out.push({ date: isoDay(from), uptime: null });
      continue;
    }
    // The part of this day the monitor existed for.
    const live = Math.max(from, createdAt.getTime());
    const span = to - live;
    // Outages can overlap (never in practice, but don't count a minute twice).
    const spans = outages
      .map(
        (o) => [Math.max(o.start.getTime(), live), Math.min((o.end ?? now).getTime(), to)] as const,
      )
      .filter(([a, b]) => b > a)
      .sort((x, y) => x[0] - y[0]);
    let down = 0;
    let cursor = -Infinity;
    for (const [a, b] of spans) {
      const start = Math.max(a, cursor);
      if (b > start) down += b - start;
      cursor = Math.max(cursor, b);
    }
    out.push({ date: isoDay(from), uptime: Math.round((1 - down / span) * 10_000) / 100 });
  }
  return out;
}

/** Uptime over the days that have data, weighted by day length so a partial first day counts less. */
export function overallUptime(days: Day[]): number | null {
  const have = days.filter((d) => d.uptime !== null);
  if (have.length === 0) return null;
  return Math.round((have.reduce((n, d) => n + d.uptime!, 0) / have.length) * 100) / 100;
}

export type Overall = "operational" | "partial" | "major";

/** Everything up is "operational"; some components down is "partial"; all of them down is "major". */
export function overallStatus(
  components: { status: "operational" | "outage" | "paused" }[],
): Overall {
  const live = components.filter((c) => c.status !== "paused");
  const down = live.filter((c) => c.status === "outage").length;
  if (down === 0) return "operational";
  return down === live.length ? "major" : "partial";
}
