import z from "zod";

/**
 * The contract between the API and a probe agent (`upzy-agent`, written in Go). Everything an agent receives or sends
 * is defined here, so the two sides cannot drift apart. Bump `AGENT_PROTOCOL` for a change an old agent cannot read.
 */
export const AGENT_PROTOCOL = 2;

export const AgentHelloSchema = z.object({
  /** The agent's own version, for the operator's eyes. */
  version: z.string().trim().min(1).max(40),
  os: z.string().trim().max(40).optional(),
  arch: z.string().trim().max(40).optional(),
  protocol: z.number().int().min(1).default(AGENT_PROTOCOL),
});

/** A 32-byte X25519 public key, base64 (44 characters). */
const PublicKey = z.string().regex(/^[A-Za-z0-9+/]{43}=$/, "A 32-byte key, base64");

export const AgentPullSchema = z.object({
  /** How many checks it can run right now. */
  max: z.number().int().min(1).max(50).default(10),
  /**
   * The agent's own X25519 public key, made when it started. Monitor secrets are encrypted to it; without it, checks
   * that need secrets are not handed out.
   */
  publicKey: PublicKey.optional(),
});

/** Secrets sealed to one agent for one job (see apps/api/src/lib/agent-seal.ts for the scheme). All base64. */
export const AgentSealedSchema = z.object({
  /** The server's ephemeral X25519 public key for this job. */
  epk: PublicKey,
  nonce: z.string().regex(/^[A-Za-z0-9+/]{16}$/),
  /** AES-256-GCM ciphertext of the JSON secrets, with the 16-byte tag at the end. */
  ciphertext: z.string().min(24),
});

export const AGENT_MONITOR_TYPES = ["http", "tcp", "dns", "ssl", "flow"] as const;

/** One check to run, with everything it needs. Secrets, if the monitor has any, arrive sealed to the agent. */
export const AgentJobSchema = z.object({
  jobId: z.uuid(),
  monitorId: z.uuid(),
  type: z.enum(AGENT_MONITOR_TYPES),
  target: z.string(),
  /** The monitor's per-type options (method, headers, assertions, steps...). */
  config: z.record(z.string(), z.unknown()),
  sealedSecrets: AgentSealedSchema.optional(),
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
export type AgentSealed = z.infer<typeof AgentSealedSchema>;
