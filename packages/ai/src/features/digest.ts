import { z } from "zod";

import type { Gateway, StructuredResult } from "../gateway";

export const DigestNarrativeSchema = z.object({
  headline: z.string().min(1).max(140),
  summary: z.string().min(1).max(700),
  highlights: z.array(z.string().min(1).max(250)).max(4).default([]),
  actions: z.array(z.string().min(1).max(250)).max(3).default([]),
});
export type DigestNarrative = z.infer<typeof DigestNarrativeSchema>;

/** The numbers behind a weekly digest. Computed by code from the database; the model only narrates them. */
export interface DigestStats {
  workspace: string;
  periodStart: string;
  periodEnd: string;
  monitors: { name: string; uptime: number | null; avgMs: number | null; checks: number }[];
  incidents: { opened: number; resolved: number; stillOpen: number; totalDowntimeMinutes: number };
  findings: {
    new: number;
    resolved: number;
    open: number;
    topOpen: { title: string; severity: string; asset: string }[];
  };
}

const SYSTEM = `You write a short weekly status summary for the owner of a small team's websites.
Use ONLY the numbers and names in the data. Do not invent figures, causes or events. Lead with what matters most (outages, then serious security findings), mention good news briefly, and keep a calm tone.
"actions" are concrete next steps grounded in the data; leave it empty if nothing needs doing.`;

/** Weekly digest narrative (feature A8): one call per workspace per week. */
export async function narrateDigest(
  gateway: Gateway,
  organizationId: string,
  stats: DigestStats,
): Promise<StructuredResult<DigestNarrative>> {
  return gateway.generateStructured({
    feature: "weekly-digest",
    role: "smart",
    organizationId,
    schema: DigestNarrativeSchema,
    system: SYSTEM,
    instructions: "Summarise the week from the statistics below.",
    // Monitor names and finding titles can contain third-party text (page titles, banners), so the whole block is untrusted.
    data: { statistics: JSON.stringify(stats, null, 1) },
    maxCharsPerBlock: 6000,
    cache: false,
    maxOutputTokens: 700,
  });
}
