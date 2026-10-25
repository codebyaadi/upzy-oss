import z from "zod";

/**
 * The contract between the API and a probe agent (`upzy-agent`, written in Go). Everything an agent receives or sends
 * is defined here, so the two sides cannot drift apart. Bump `AGENT_PROTOCOL` for a change an old agent cannot read.
 */
export const AGENT_PROTOCOL = 1;

export const AgentHelloSchema = z.object({
  /** The agent's own version, for the operator's eyes. */
  version: z.string().trim().min(1).max(40),
  os: z.string().trim().max(40).optional(),
  arch: z.string().trim().max(40).optional(),
  protocol: z.number().int().min(1).default(AGENT_PROTOCOL),
});

export const AgentPullSchema = z.object({
  /** How many checks it can run right now. */
  max: z.number().int().min(1).max(50).default(10),
});

export const AGENT_MONITOR_TYPES = ["http", "tcp", "dns", "ssl", "flow"] as const;

/** One check to run, with everything it needs. Secrets are sent decrypted, over TLS, for this one check. */
export const AgentJobSchema = z.object({
  jobId: z.uuid(),
  monitorId: z.uuid(),
  type: z.enum(AGENT_MONITOR_TYPES),
  target: z.string(),
  /** The monitor's per-type options (method, headers, assertions, steps...). */
  config: z.record(z.string(), z.unknown()),
  secrets: z.record(z.string(), z.string()).optional(),
});

export const AGENT_ERROR_KINDS = [
  "dns",
  "timeout",
  "tls",
  "http",
  "refused",
  "blocked",
  "assertion",
  "other",
] as const;

/** What an agent reports for one check. It never decides whether the monitor is down: the server does. */
export const AgentResultSchema = z.object({
  status: z.enum(["up", "down"]),
  responseMs: z.number().int().min(0).max(600_000).nullable(),
  statusCode: z.number().int().min(100).max(599).optional(),
  ttfbMs: z.number().int().min(0).max(600_000).optional(),
  tlsDaysLeft: z.number().int().min(-3650).max(36500).optional(),
  error: z.string().max(500).optional(),
  errorKind: z.enum(AGENT_ERROR_KINDS).optional(),
});

export type AgentHello = z.infer<typeof AgentHelloSchema>;
export type AgentJob = z.infer<typeof AgentJobSchema>;
export type AgentResult = z.infer<typeof AgentResultSchema>;
