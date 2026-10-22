import { z } from "zod";

import type { Gateway, StructuredResult } from "../gateway";

/** What the model may propose. It is a draft: the caller validates it against the real monitor schema and a person confirms it. */
export const MonitorDraftSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(["http", "tcp", "dns", "ssl"]),
  target: z.string().min(1).max(500),
  /** Seconds. Snapped by the caller to a supported interval. */
  intervalSeconds: z.number().int().min(60).max(3600),
  failureThreshold: z.number().int().min(1).max(10).default(2),
  /** HTTP only: text the page must contain. */
  keyword: z.string().max(200).optional(),
  /** Anything in the request that could not be expressed (latency limits, regions, alert channels...). */
  unsupported: z.array(z.string().max(200)).max(5).default([]),
  rationale: z.string().min(1).max(400),
});
export type MonitorDraft = z.infer<typeof MonitorDraftSchema>;

const SYSTEM = `You turn a plain-English description into ONE uptime monitor definition.
Supported types: http (a URL), tcp (host:port), dns (a hostname), ssl (a hostname, certificate check).
Supported check intervals in seconds: 60, 300, 600, 1800, 3600. Pick the closest to what was asked; default to 300.
The target must be exactly what the person gave (do not invent hostnames). If they gave a bare domain for an http monitor, use https://<domain>.
Anything they asked for that these fields cannot express (latency thresholds, locations, who to alert) goes into "unsupported"; never pretend it is configured.`;

export const SUPPORTED_INTERVALS = [60, 300, 600, 1800, 3600] as const;
export const snapInterval = (seconds: number) =>
  SUPPORTED_INTERVALS.reduce(
    (best, s) => (Math.abs(s - seconds) < Math.abs(best - seconds) ? s : best),
    300,
  );

/** Natural-language monitor builder (feature A3). Returns a draft only: nothing is created without confirmation. */
export async function draftMonitor(
  gateway: Gateway,
  organizationId: string,
  text: string,
): Promise<StructuredResult<MonitorDraft>> {
  return gateway.generateStructured({
    feature: "monitor-draft",
    role: "fast",
    organizationId,
    schema: MonitorDraftSchema,
    system: SYSTEM,
    instructions: "Create the monitor described in the request below.",
    data: { request: text },
    maxCharsPerBlock: 1000,
    cache: false,
    maxOutputTokens: 500,
  });
}
