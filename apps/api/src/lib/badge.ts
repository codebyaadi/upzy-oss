/**
 * A small flat badge ("status | operational", "security | A") as SVG, for embedding in a README or a site footer.
 * Both texts come from fixed vocabularies, never from user input, and are still escaped.
 */
const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

// Verdana 11px averages about 6.5px per character; close enough to size the boxes without font metrics.
const width = (s: string) => Math.round(s.length * 6.5 + 12);

export type BadgeTone = "good" | "ok" | "warn" | "bad" | "muted";
const COLOR: Record<BadgeTone, string> = {
  good: "#0f7a6a",
  ok: "#65a30d",
  warn: "#b45309",
  bad: "#b91c1c",
  muted: "#6b7280",
};

export function badge(label: string, value: string, tone: BadgeTone): string {
  const lw = width(label);
  const vw = width(value);
  const w = lw + vw;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${esc(label)}: ${esc(value)}"><title>${esc(label)}: ${esc(value)}</title><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath><g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#374151"/><rect x="${lw}" width="${vw}" height="20" fill="${COLOR[tone]}"/><rect width="${w}" height="20" fill="url(#s)"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11"><text x="${lw / 2}" y="14">${esc(label)}</text><text x="${lw + vw / 2}" y="14">${esc(value)}</text></g></svg>`;
}

export const GRADE_TONE: Record<string, BadgeTone> = {
  A: "good",
  B: "ok",
  C: "warn",
  D: "warn",
  F: "bad",
};
