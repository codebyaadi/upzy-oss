import { z } from "zod";

import type { Gateway, StructuredResult } from "../gateway";
import { sanitizeTriage, TriageSchema, type EvidenceItem } from "./triage-incident";

/** Same shape as a triage (cause, confidence, cited evidence, actions) plus a one-line headline for the group. */
export const GroupSummarySchema = TriageSchema.extend({
  headline: z.string().min(1).max(120),
});
export type GroupSummary = z.infer<typeof GroupSummarySchema>;

export interface GroupInput {
  /** What the rule-based correlation found in common, e.g. "domain:example.com". */
  sharedKey: string;
  evidence: EvidenceItem[];
}

const SYSTEM = `You help an on-call person who just received several outage alerts that opened close together.
Upzy grouped them by a shared fact it checked itself (same site or same IP address). Using ONLY the numbered facts, say whether they most likely share one cause and what it is, citing facts by id.
Many monitors failing together on one site or address usually points at the shared layer (the host, a proxy/CDN, DNS or a certificate) rather than each service separately, but say so only when the facts support it. If the facts also show different failure types or other monitors still passing, say that the grouping may be a coincidence and lower your confidence.
Never invent providers, hostnames, IPs or error messages. Suggested actions are things a person can check now, most useful first.`;

/** Alert noise reducer (feature A6): one explanation for a group of related incidents. */
export async function summarizeGroup(
  gateway: Gateway,
  organizationId: string,
  input: GroupInput,
): Promise<StructuredResult<GroupSummary>> {
  const result = await gateway.generateStructured({
    feature: "group-summary",
    role: "smart",
    organizationId,
    schema: GroupSummarySchema,
    system: SYSTEM,
    instructions: `Several incidents opened within minutes of each other and share: ${input.sharedKey.replace(/[^\w.:\-]/g, "")}. Explain what they likely have in common.`,
    data: { facts: input.evidence.map((e) => `${e.id} [${e.kind}] ${e.text}`).join("\n") },
    cache: false,
    maxOutputTokens: 900,
  });
  // The sanitizer keeps every field it doesn't touch (headline included).
  return { ...result, data: sanitizeTriage(result.data, input.evidence) as GroupSummary };
}
