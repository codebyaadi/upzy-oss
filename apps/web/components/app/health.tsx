"use client";

import { cn } from "@upzy/ui/lib/utils";

import { FixForStack } from "@/components/app/fix-for-stack";
import { ErrorNote } from "@/components/app/ui";
import { api } from "@/lib/api";
import { unwrap, useApi } from "@/lib/use-api";

export type Grade = "A" | "B" | "C" | "D" | "F";
export interface HealthData {
  score: number;
  grade: Grade;
  categories: Partial<Record<"security" | "availability" | "email" | "hygiene", number>>;
  cappedBy: "critical" | "high" | "medium" | null;
}

const TONE: Record<Grade, string> = {
  A: "bg-brand text-background",
  B: "bg-lime-500 text-white",
  C: "bg-amber-400 text-black",
  D: "bg-orange-500 text-white",
  F: "bg-destructive text-white",
};
const BAR: Record<Grade, string> = {
  A: "bg-brand",
  B: "bg-lime-500",
  C: "bg-amber-400",
  D: "bg-orange-500",
  F: "bg-destructive",
};
const gradeOf = (n: number): Grade =>
  n >= 90 ? "A" : n >= 80 ? "B" : n >= 65 ? "C" : n >= 50 ? "D" : "F";

const LABEL = {
  security: "Security",
  availability: "Availability",
  email: "Email trust",
  hygiene: "Hygiene",
} as const;
const HINT = {
  security: "Headers, TLS, takeover risk and known vulnerabilities",
  availability: "Uptime over 30 days of the monitors watching this host",
  email: "SPF and DMARC",
  hygiene: "Certificate expiry, CAA and version banners",
} as const;

/** The letter people remember. */
export function GradeBadge({
  health,
  className,
}: {
  health: HealthData | null;
  className?: string;
}) {
  if (!health)
    return (
      <span
        title="Scanned soon"
        className={cn(
          "bg-muted text-muted-foreground inline-grid size-10 shrink-0 place-items-center rounded-2xl text-lg font-extrabold",
          className,
        )}
      >
        –
      </span>
    );
  return (
    <span
      title={`Health score ${health.score} / 100`}
      className={cn(
        "inline-grid size-10 shrink-0 place-items-center rounded-2xl text-lg font-extrabold",
        TONE[health.grade],
        className,
      )}
    >
      {health.grade}
    </span>
  );
}

function Trend({ points }: { points: { day: string; score: number }[] }) {
  if (points.length < 2)
    return (
      <p className="text-muted-foreground text-sm">
        The trend appears after a second day of scans.
      </p>
    );
  const w = 320;
  const h = 56;
  const xs = (i: number) => (i / (points.length - 1)) * (w - 8) + 4;
  const ys = (v: number) => h - 4 - (v / 100) * (h - 8);
  const d = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${xs(i).toFixed(1)},${ys(p.score).toFixed(1)}`)
    .join(" ");
  const first = points[0]!;
  const last = points.at(-1)!;
  return (
    <figure>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="h-14 w-full"
        role="img"
        aria-label={`Score went from ${first.score} to ${last.score} over ${points.length} days`}
      >
        <path
          d={d}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="text-brand"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle cx={xs(points.length - 1)} cy={ys(last.score)} r="3" className="fill-brand" />
      </svg>
      <figcaption className="text-muted-foreground text-xs">
        {first.day} · {first.score} → {last.day} · {last.score}
      </figcaption>
    </figure>
  );
}

/** Breakdown, trend and the one-snippet fix for missing headers. Loaded when opened. */
export function HealthPanel({ assetId }: { assetId: string }) {
  const { data, error } = useApi(`asset-health:${assetId}`, () =>
    unwrap(api.asset({ id: assetId }).health.get()),
  );
  if (error) return <ErrorNote error={error} />;
  if (!data) return <p className="text-muted-foreground mt-4 text-sm">Loading…</p>;
  const h = data.health;
  if (!h)
    return (
      <p className="text-muted-foreground mt-4 text-sm">
        There&apos;s no grade yet: it appears after the first scan finishes.
      </p>
    );
  const cats = Object.entries(h.categories) as [keyof typeof LABEL, number][];
  return (
    <div className="mt-4 space-y-4 border-t pt-4">
      <div className="grid gap-6 sm:grid-cols-2">
        <div className="space-y-3">
          {cats.map(([c, v]) => (
            <div key={c} title={HINT[c]}>
              <div className="mb-1 flex items-baseline justify-between text-sm">
                <span className="font-semibold">{LABEL[c]}</span>
                <span className="text-muted-foreground">{v}</span>
              </div>
              <div
                className="bg-muted h-2 overflow-hidden rounded-full"
                role="img"
                aria-label={`${LABEL[c]} ${v} out of 100`}
              >
                <div
                  className={cn("h-full rounded-full", BAR[gradeOf(v)])}
                  style={{ width: `${v}%` }}
                />
              </div>
            </div>
          ))}
          {h.cappedBy && (
            <p className="text-muted-foreground text-xs">
              {h.cappedBy === "medium"
                ? "An open medium finding keeps this out of the A range."
                : `An open ${h.cappedBy} finding caps the grade until it's fixed, however good the rest looks.`}
            </p>
          )}
        </div>
        <div>
          <p className="mb-1 text-sm font-semibold">Last 90 days</p>
          <Trend points={data.history} />
          {data.stackLabel && (
            <p className="text-muted-foreground mt-3 text-xs">Runs on {data.stackLabel}</p>
          )}
        </div>
      </div>
      {data.headersFix && (
        <FixForStack fix={data.headersFix} title="Add all the missing headers at once" />
      )}
    </div>
  );
}
