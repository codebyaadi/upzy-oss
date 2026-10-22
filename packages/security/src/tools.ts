import { emailCheck } from "./checks/email-auth";
import { headersCheck } from "./checks/headers";
import { tlsCheck } from "./checks/tls";
import { defaultDeps } from "./deps";
import { fixFor, type Fix } from "./fixes";
import { gradeOf, PENALTY, type Grade } from "./health";
import { runChecks } from "./run";
import { describeStack, UNKNOWN_STACK } from "./stack";
import type { Check, Deps, Severity } from "./types";

/**
 * The free, no-sign-up checkers on the website. Each runs one family of the same checks Upzy's scheduled scans use, on
 * a hostname someone typed in, and explains the result. Nothing is stored.
 */
export type ToolId = "headers" | "ssl" | "email";

export const TOOL_IDS: readonly ToolId[] = ["headers", "ssl", "email"];
export const isToolId = (v: string): v is ToolId => (TOOL_IDS as readonly string[]).includes(v);

const CHECK: Record<ToolId, Check> = { headers: headersCheck, ssl: tlsCheck, email: emailCheck };

/** What a person typed wasn't a hostname we are willing to check. The message is safe to show. */
export class ToolInputError extends Error {}
/** The check ran but couldn't reach the site (or it isn't public). The message is safe to show. */
export class ToolUnreachableError extends Error {}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Accepts "example.com", "https://Example.com/path?x" or "www.example.com:443" and returns the hostname, or throws.
 * IP addresses, single-label names ("localhost", "intranet") and anything that is not a plain public-looking domain
 * are refused up front; the network layer refuses private addresses again when it resolves them.
 */
export function normalizeHost(input: string): string {
  let raw = input.trim().toLowerCase();
  if (!raw) throw new ToolInputError("Enter a domain, like example.com.");
  if (raw.length > 300) throw new ToolInputError("That doesn't look like a domain.");
  raw = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  raw = raw.split(/[/?#]/)[0]!;
  raw = raw
    .replace(/^[^@]*@/, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
  const labels = raw.split(".");
  const isIp = /^\d+(\.\d+){3}$/.test(raw) || raw.includes(":") || raw.startsWith("[");
  if (
    isIp ||
    raw.length > 253 ||
    labels.length < 2 ||
    !labels.every((l) => LABEL.test(l)) ||
    /^\d+$/.test(labels.at(-1)!) ||
    ["localhost", "local", "internal", "lan", "home", "test", "invalid", "example"].includes(
      labels.at(-1)!,
    )
  )
    throw new ToolInputError("Enter a public domain name, like example.com (not an IP address).");
  return raw;
}

export interface ToolFinding {
  checkKey: string;
  severity: Severity;
  title: string;
  description: string;
  remediation: string;
  /** Copy-paste instructions for the stack we detected, when we have them. */
  fix: Fix | null;
}

export interface ToolFact {
  label: string;
  /** What was found, or null when it is missing. */
  value: string | null;
}

export interface ToolResult {
  tool: ToolId;
  host: string;
  score: number;
  grade: Grade;
  findings: ToolFinding[];
  facts: ToolFact[];
  /** What the site appears to run on, in words, when we could tell. */
  detected: string | null;
  checkedAt: string;
}

/** Same penalties and caps as a monitored asset's health grade, so a site gets the same grade here and in the app. */
export function scoreOf(findings: { severity: Severity }[]): number {
  let score = 100;
  for (const f of findings) score -= PENALTY[f.severity];
  score = Math.max(0, score);
  if (findings.some((f) => f.severity === "critical")) return Math.min(score, 59);
  if (findings.some((f) => f.severity === "high")) return Math.min(score, 79);
  if (findings.some((f) => f.severity === "medium")) return Math.min(score, 89);
  return score;
}

const HEADER_FACTS: [string, string][] = [
  ["Strict-Transport-Security", "strict-transport-security"],
  ["Content-Security-Policy", "content-security-policy"],
  ["X-Frame-Options", "x-frame-options"],
  ["X-Content-Type-Options", "x-content-type-options"],
  ["Referrer-Policy", "referrer-policy"],
  ["Permissions-Policy", "permissions-policy"],
];

const clip = (v: string, n = 160) => (v.length > n ? `${v.slice(0, n)}…` : v);

async function factsFor(tool: ToolId, host: string, deps: Deps): Promise<ToolFact[]> {
  try {
    if (tool === "headers") {
      const res = await deps.fetch(`https://${host}/`);
      return HEADER_FACTS.map(([label, key]) => ({
        label,
        value: res.headers[key] ? clip(res.headers[key]!) : null,
      }));
    }
    if (tool === "ssl") {
      const t = await deps.tls(host);
      const days = t.validTo ? Math.floor((t.validTo.getTime() - Date.now()) / 86_400_000) : null;
      return [
        { label: "Protocol", value: t.protocol },
        {
          label: "Expires",
          value:
            t.validTo && days !== null
              ? `${t.validTo.toISOString().slice(0, 10)} (${days < 0 ? `${-days} days ago` : `in ${days} days`})`
              : null,
        },
        { label: "Key", value: t.keyType && t.keyBits ? `${t.keyType} ${t.keyBits}-bit` : null },
        { label: "Trusted by browsers", value: t.authorized ? "Yes" : "No" },
      ];
    }
    const txt = async (name: string) =>
      (await deps.resolveTxt(name).catch(() => [] as string[][])).map((r) => r.join(""));
    const spf = (await txt(host)).find((t) => /^v=spf1(\s|$)/i.test(t));
    const dmarc = (await txt(`_dmarc.${host}`)).find((t) => /^v=DMARC1/i.test(t));
    return [
      { label: "SPF", value: spf ? clip(spf) : null },
      { label: "DMARC", value: dmarc ? clip(dmarc) : null },
    ];
  } catch {
    // Facts are decoration; the findings are the result.
    return [];
  }
}

export async function runTool(
  tool: ToolId,
  rawHost: string,
  opts: { deps?: Deps; now?: () => Date } = {},
): Promise<ToolResult> {
  const host = normalizeHost(rawHost);
  const deps = opts.deps ?? defaultDeps;
  const result = await runChecks({ kind: "domain", value: host }, { deps, checks: [CHECK[tool]] });

  const family = CHECK[tool].family;
  const error = result.errors[family];
  if (error) {
    const blocked = error.startsWith("Blocked:");
    throw new ToolUnreachableError(
      blocked
        ? "That address isn't publicly reachable, so it can't be checked."
        : tool === "ssl"
          ? `Couldn't open a secure connection to ${host}. Is the name spelled correctly, and is the site up?`
          : tool === "email"
            ? `Couldn't look up DNS records for ${host}. Is the name spelled correctly?`
            : `Couldn't load https://${host}/. Is the name spelled correctly, and is the site up?`,
    );
  }

  // What the site runs on only changes the advice for header fixes; DNS and certificate advice is the same everywhere.
  const stack = tool === "headers" ? (result.stack ?? UNKNOWN_STACK) : UNKNOWN_STACK;
  const findings: ToolFinding[] = result.findings.map((f) => ({
    checkKey: f.checkKey,
    severity: f.severity,
    title: f.title,
    description: f.description,
    remediation: f.remediation,
    fix: fixFor({ checkKey: f.checkKey, stack, host, evidence: f.evidence }),
  }));
  const order: Severity[] = ["critical", "high", "medium", "low", "info"];
  findings.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));

  const score = scoreOf(findings);
  return {
    tool,
    host,
    score,
    grade: gradeOf(score),
    findings,
    facts: await factsFor(tool, host, deps),
    detected: describeStack(stack) === "Unknown" ? null : describeStack(stack),
    checkedAt: (opts.now?.() ?? new Date()).toISOString(),
  };
}
