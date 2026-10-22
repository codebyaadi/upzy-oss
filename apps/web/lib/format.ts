export const pct = (v: number | null | undefined, digits = 2) =>
  v == null ? "–" : `${(v * 100).toFixed(digits).replace(/\.?0+$/, "")}%`;
export const ms = (v: number | null | undefined) =>
  v == null ? "–" : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v} ms`;

export function timeAgo(input: string | Date | null | undefined): string {
  if (!input) return "never";
  const s = Math.max(0, Math.round((Date.now() - new Date(input).getTime()) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function duration(from: string | Date, to: string | Date | null): string {
  const s = Math.round(
    ((to ? new Date(to).getTime() : Date.now()) - new Date(from).getTime()) / 1000,
  );
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

export const dateTime = (d: string | Date) =>
  new Date(d).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Micro-dollars as a short US dollar amount: small sums keep enough digits to be non-zero. */
export function usd(micros: number): string {
  const d = micros / 1_000_000;
  if (d === 0) return "$0.00";
  return d < 0.01 ? `$${d.toFixed(4)}` : `$${d.toFixed(2)}`;
}
