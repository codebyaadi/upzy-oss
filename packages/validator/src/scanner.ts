import z from "zod";

import { FindingDraftSchema } from "./finding";

/**
 * The contract between the API and the active scanner (`upzy-scan`, written in Go, running nuclei over a curated set of
 * non-intrusive templates). It only ever scans assets whose ownership has been verified: the server hands out nothing
 * else, and checks again when it takes the result. Bump `SCANNER_PROTOCOL` for a change an old scanner cannot read.
 */
export const SCANNER_PROTOCOL = 1;

export const ScannerHelloSchema = z.object({
  version: z.string().trim().min(1).max(40),
  engine: z.string().trim().min(1).max(40),
  engineVersion: z.string().trim().max(40).optional(),
  /** Which curated template set it carries, for the provenance log. */
  templateSet: z.string().trim().max(80).optional(),
  os: z.string().trim().max(40).optional(),
  arch: z.string().trim().max(40).optional(),
  protocol: z.number().int().min(1).default(SCANNER_PROTOCOL),
});

export const ScannerPullSchema = z.object({
  /** Scans it can run at once. A scan is slow and heavy, so this is small. */
  max: z.number().int().min(1).max(5).default(1),
});

/** One asset to scan. Everything the scanner is allowed to do is in here; it decides nothing about scope itself. */
export const ScannerJobSchema = z.object({
  jobId: z.uuid(),
  assetId: z.uuid(),
  /** Hostname for a domain or subdomain, or the URL's host for a URL asset. */
  host: z.string(),
  /** The page to start from, always https. */
  url: z.string(),
  /** At most this many requests a second to the target, in total. */
  rateLimitPerSecond: z.number().int().min(1).max(50),
  /** Stop and report what was found after this long. */
  timeoutSeconds: z.number().int().min(30).max(3600),
});

export const ScanProvenanceSchema = z.object({
  engine: z.string().trim().min(1).max(40),
  engineVersion: z.string().trim().max(40).optional(),
  templateSet: z.string().trim().max(80).optional(),
  /** How many templates ran and how many requests they sent. */
  templatesRun: z.number().int().min(0).max(100_000),
  requests: z.number().int().min(0).max(10_000_000),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  rateLimitPerSecond: z.number().int().min(1).max(50),
  /** Ids of the templates that ran, so a customer can see exactly what was sent to their site. */
  templates: z.array(z.string().max(120)).max(1000),
});

/** What the scanner reports. Only findings from the `exposure` and `nuclei` families are accepted. */
export const ScannerResultSchema = z.object({
  findings: z
    .array(
      FindingDraftSchema.refine(
        (f) => f.checkKey.startsWith("exposure.") || f.checkKey.startsWith("nuclei."),
        "A scanner may only report exposure.* and nuclei.* findings",
      ),
    )
    .max(200),
  provenance: ScanProvenanceSchema,
  /** Set when the scan could not complete. Findings may still be present; nothing is resolved on an error. */
  error: z.string().max(500).optional(),
});

export type ScannerJob = z.infer<typeof ScannerJobSchema>;
export type ScannerResult = z.infer<typeof ScannerResultSchema>;
export type ScanProvenance = z.infer<typeof ScanProvenanceSchema>;
