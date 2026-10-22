"use client";

import { useId, useState } from "react";

import { dateTime, ms } from "@/lib/format";

export interface Point {
  t: string | Date;
  avgMs: number | null;
  up: number;
  total: number;
}

const W = 800;
const H = 220;
const PAD = { l: 52, r: 12, t: 12, b: 28 };

/** Response-time area chart. Buckets with failed checks are marked below the axis. */
export function ResponseChart({ points }: { points: Point[] }) {
  const gradient = useId();
  const [hover, setHover] = useState<number | null>(null);

  if (points.length === 0) {
    return (
      <div className="text-muted-foreground grid h-56 place-items-center text-sm">
        No checks in this range yet.
      </div>
    );
  }

  const values = points.map((p) => p.avgMs).filter((v): v is number => v != null);
  const max = Math.max(100, ...values) * 1.1;
  const x = (i: number) =>
    PAD.l +
    (points.length === 1
      ? (W - PAD.l - PAD.r) / 2
      : (i * (W - PAD.l - PAD.r)) / (points.length - 1));
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);

  // Split into runs so null buckets (no response) leave a gap instead of a false line.
  const runs: number[][] = [];
  points.forEach((p, i) => {
    if (p.avgMs == null)
      return void (runs.length && runs[runs.length - 1]!.length && runs.push([]));
    if (!runs.length) runs.push([]);
    runs[runs.length - 1]!.push(i);
  });
  const baseline = H - PAD.b;
  const bw = Math.max(3, Math.min(24, (W - PAD.l - PAD.r) / points.length - 2));
  const ticks = [0, 0.5, 1].map((f) => f * max);
  const h = hover != null ? points[hover]! : null;

  return (
    <div>
      <div className="text-muted-foreground mb-2 h-5 text-xs" aria-live="polite">
        {h
          ? `${dateTime(h.t)} · ${ms(h.avgMs)} · ${h.up}/${h.total} checks up`
          : "Hover the chart for details"}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-56 w-full"
        role="img"
        aria-label={`Response time over time. Peak ${ms(Math.round(Math.max(...values, 0)))}.`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          const i = Math.round(((px - PAD.l) / (W - PAD.l - PAD.r)) * (points.length - 1));
          setHover(Math.min(points.length - 1, Math.max(0, i)));
        }}
      >
        <defs>
          <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--brand)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--brand)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="var(--border)" />
            <text
              x={PAD.l - 8}
              y={y(v) + 4}
              textAnchor="end"
              fontSize="11"
              fill="var(--muted-foreground)"
            >
              {ms(Math.round(v))}
            </text>
          </g>
        ))}
        {runs.map((run, k) =>
          run.length === 1 ? (
            <circle
              key={k}
              cx={x(run[0]!)}
              cy={y(points[run[0]!]!.avgMs!)}
              r="3"
              fill="var(--brand)"
            />
          ) : (
            <g key={k}>
              <path
                d={`M${x(run[0]!)},${baseline} ${run.map((i) => `L${x(i)},${y(points[i]!.avgMs!)}`).join(" ")} L${x(run[run.length - 1]!)},${baseline}Z`}
                fill={`url(#${gradient})`}
              />
              <path
                d={run.map((i, n) => `${n ? "L" : "M"}${x(i)},${y(points[i]!.avgMs!)}`).join(" ")}
                fill="none"
                stroke="var(--brand)"
                strokeWidth="2"
                strokeLinejoin="round"
              />
            </g>
          ),
        )}
        {points.map(
          (p, i) =>
            p.up < p.total && (
              <rect
                key={i}
                x={x(i) - bw / 2}
                y={baseline + 4}
                width={bw}
                height="5"
                rx="2.5"
                fill="var(--destructive)"
              />
            ),
        )}
        {h && hover != null && (
          <line
            x1={x(hover)}
            x2={x(hover)}
            y1={PAD.t}
            y2={baseline}
            stroke="var(--foreground)"
            strokeOpacity="0.25"
          />
        )}
        <text x={PAD.l} y={H - 4} fontSize="11" fill="var(--muted-foreground)">
          {dateTime(points[0]!.t)}
        </text>
        <text x={W - PAD.r} y={H - 4} textAnchor="end" fontSize="11" fill="var(--muted-foreground)">
          {dateTime(points[points.length - 1]!.t)}
        </text>
      </svg>
      <p className="text-muted-foreground mt-1 text-xs">
        Red marks show intervals with failed checks.
      </p>
    </div>
  );
}
