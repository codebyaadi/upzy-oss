import z from "zod";

/**
 * A security finding as a scanner reports it, before the server stores it. TypeScript checks (`@upzy/security`) and the
 * Go scanner planned for later both produce this shape, so it is defined once here. Keep it in step with
 * `FindingDraft` in packages/security/src/types.ts (a test fails if they drift).
 */
export const FINDING_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;

export const FindingDraftSchema = z.object({
  /** `<family>.<slug>`, for example "headers.hsts_missing". The family says which check produced it. */
  checkKey: z.string().regex(/^[a-z0-9_]+\.[a-z0-9_]+$/),
  severity: z.enum(FINDING_SEVERITIES),
  title: z.string().min(1).max(300),
  description: z.string().max(5000),
  remediation: z.string().max(5000),
  /** Distinguishes several findings of one checkKey on an asset (for example a cookie name). */
  subject: z.string().max(300).optional(),
  /** Observable facts only. Never secrets such as cookie values. */
  evidence: z.record(z.string(), z.unknown()).optional(),
  /** Exploitation signals that raise the risk score above what severity alone gives. */
  risk: z
    .object({
      kev: z.boolean().optional(),
      epss: z.number().min(0).max(1).optional(),
    })
    .optional(),
});

export type FindingDraftInput = z.infer<typeof FindingDraftSchema>;
