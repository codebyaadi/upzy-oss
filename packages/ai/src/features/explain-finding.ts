import { z } from "zod";

import type { Gateway, StructuredResult } from "../gateway";

const Snippet = z.object({
  /** What the snippet configures, e.g. "nginx", "Cloudflare", "DNS". */
  platform: z.string().min(1).max(40),
  /** Display only: used to label the code block. Never executed or interpreted by Upzy. */
  language: z.enum(["nginx", "apache", "caddy", "json", "yaml", "dns", "shell", "text"]),
  code: z.string().min(1).max(1500),
});

export const ExplainFindingSchema = z.object({
  /** One or two sentences, plain English, for someone who is not a security specialist. */
  summary: z.string().min(1).max(400),
  /** What could actually go wrong, concretely. */
  impact: z.string().min(1).max(700),
  /** How realistic exploitation is, using the supplied evidence and exploitation signals only. */
  exploitability: z.string().min(1).max(500),
  steps: z
    .array(z.object({ title: z.string().min(1).max(120), detail: z.string().min(1).max(600) }))
    .min(1)
    .max(6),
  snippets: z.array(Snippet).max(4).default([]),
  /** What could not be determined, or ways the finding may be a false positive. */
  caveats: z.array(z.string().min(1).max(300)).max(4).default([]),
  confidence: z.enum(["low", "medium", "high"]),
});
export type ExplainFindingOutput = z.infer<typeof ExplainFindingSchema>;

export interface FindingInput {
  checkKey: string;
  severity: string;
  title: string;
  description: string;
  remediation: string;
  evidence: Record<string, unknown>;
  assetKind: string;
  assetValue: string;
  /** What the site runs on, detected from its response headers (e.g. "Cloudflare in front of nginx"). */
  stack?: string;
  /** Exploitation signals for CVE findings. */
  kev?: boolean;
  epss?: number;
}

const SYSTEM = `You write remediation guidance for one security finding about a website or domain.
Ground every statement in the finding and its evidence. If the evidence does not support a claim, do not make it.
Prefer concrete, minimal fixes. When the finding is about HTTP headers, TLS or DNS, include configuration snippets for the common platforms that apply (nginx, Apache, Caddy, Cloudflare/Vercel-style header rules, DNS records), clearly labelled. Never invent version numbers, CVE ids or URLs: use only those present in the evidence.
Explain jargon briefly. Keep it short and actionable.`;

/**
 * Plain-English impact and a concrete fix for a finding (feature A2). Cached by finding content, so the same
 * issue on many assets is explained once.
 */
export async function explainFinding(
  gateway: Gateway,
  organizationId: string,
  f: FindingInput,
): Promise<StructuredResult<ExplainFindingOutput>> {
  return gateway.generateStructured({
    feature: "explain-finding",
    role: "smart",
    organizationId,
    schema: ExplainFindingSchema,
    system: SYSTEM,
    instructions: `Explain this finding for the owner of the asset. Severity: ${f.severity}. Check: ${f.checkKey}. Asset type: ${f.assetKind}.${f.stack && f.stack !== "Unknown" ? ` Detected stack: ${f.stack}. Give the fix for that stack first.` : ""}${f.kev ? " It is listed in CISA's Known Exploited Vulnerabilities catalogue." : ""}${f.epss !== undefined ? ` EPSS exploitation probability: ${(f.epss * 100).toFixed(1)}%.` : ""}`,
    data: {
      title: f.title,
      description: f.description,
      builtin_remediation: f.remediation,
      // Evidence can contain page content, headers and DNS values: attacker-influenced.
      evidence: JSON.stringify(f.evidence, null, 1),
    },
    // Not part of the cache identity: the same issue on different assets reuses one explanation.
    cache: { ttlMs: 7 * 24 * 3600_000 },
    maxOutputTokens: 1400,
  });
}
