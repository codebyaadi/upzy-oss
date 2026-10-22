import { z } from "zod";

import type { Gateway, StructuredResult } from "../gateway";

/** One fact Upzy collected itself (never the model). The model may only cite these by id. */
export interface EvidenceItem {
  id: string;
  /** Short category shown in the UI, e.g. "recent checks", "live re-check", "dns". */
  kind: string;
  text: string;
}

export const CAUSES = [
  "dns",
  "network",
  "tls_certificate",
  "origin_down",
  "application_error",
  "config_or_deploy",
  "provider_outage",
  "unknown",
] as const;

export const TriageSchema = z.object({
  /** One or two sentences: what is happening, for the person paged. */
  summary: z.string().min(1).max(400),
  likelyCause: z.enum(CAUSES),
  confidence: z.enum(["low", "medium", "high"]),
  /** Which collected facts support the conclusion. `ref` must be an id from the evidence list. */
  evidence: z
    .array(z.object({ ref: z.string().max(12), note: z.string().min(1).max(300) }))
    .max(8)
    .default([]),
  suggestedActions: z
    .array(z.object({ title: z.string().min(1).max(120), detail: z.string().min(1).max(400) }))
    .min(1)
    .max(5),
  /** What the evidence cannot tell us. */
  unknowns: z.array(z.string().min(1).max(250)).max(4).default([]),
});
export type Triage = z.infer<typeof TriageSchema>;

export interface TriageInput {
  monitor: { name: string; type: string; target: string };
  openedAt: string;
  evidence: EvidenceItem[];
}

const SYSTEM = `You are an on-call assistant. A monitored service just went down; you are given facts that Upzy collected from its own checks, each with an id like E1.
Decide the most likely cause and what to do first. Use ONLY the supplied facts: cite them by id in "evidence" and never invent hostnames, IPs, versions, providers or error messages.
If the facts do not clearly point to one cause, pick "unknown" or a low confidence rather than guessing. A single failing check is weak evidence; agreement between several facts is strong.
Suggested actions must be things a person can do or check now, most useful first. This is advice for a human: you cannot change anything.`;

/**
 * Keeps the model honest after the fact: citations must point at facts that exist, and a conclusion
 * with no valid supporting fact cannot claim more than low confidence.
 */
export function sanitizeTriage(out: Triage, evidence: EvidenceItem[]): Triage {
  const ids = new Set(evidence.map((e) => e.id));
  const cited = out.evidence.filter((e) => ids.has(e.ref));
  const dropped = cited.length !== out.evidence.length;
  let confidence = out.confidence;
  if (cited.length === 0) confidence = "low";
  else if (cited.length === 1 && confidence === "high") confidence = "medium";
  return {
    ...out,
    confidence,
    evidence: cited,
    unknowns: dropped
      ? [...out.unknowns, "Some claims cited facts that weren't collected and were removed."].slice(
          0,
          4,
        )
      : out.unknowns,
  };
}

/** Incident triage (feature A1): reads Upzy's own evidence and proposes a likely cause and next steps. */
export async function triageIncident(
  gateway: Gateway,
  organizationId: string,
  input: TriageInput,
): Promise<StructuredResult<Triage>> {
  const result = await gateway.generateStructured({
    feature: "triage-incident",
    role: "smart",
    organizationId,
    schema: TriageSchema,
    system: SYSTEM,
    instructions: `Monitor "${input.monitor.type}" went down at ${input.openedAt}. Work out the likely cause from the facts.`,
    data: {
      monitor: `${input.monitor.name} (${input.monitor.type}) ${input.monitor.target}`,
      // Error strings come from remote servers (attacker-influenced): the gateway fences and redacts them.
      facts: input.evidence.map((e) => `${e.id} [${e.kind}] ${e.text}`).join("\n"),
    },
    // An outage is a moment in time: never serve yesterday's analysis.
    cache: false,
    maxOutputTokens: 1000,
  });
  return { ...result, data: sanitizeTriage(result.data, input.evidence) };
}
