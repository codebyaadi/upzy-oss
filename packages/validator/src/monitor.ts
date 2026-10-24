import z from "zod";

import { BrowserStepSchema, MAX_BROWSER_STEPS } from "./browser";
import {
  AssertionSchema,
  HeadersSchema,
  HttpOptions,
  SecretsSchema,
  SecretsUpdateSchema,
  StepSchema,
  referencesProblem,
  stepUrlProblem,
} from "./monitor-checks";
import { hostOfTarget, isBlockedHost } from "./ssrf";

export const MonitorType = z.enum(["http", "tcp", "dns", "ssl", "synthetic", "flow", "heartbeat"]);

/** How often a heartbeat is expected, and how late it may be before it counts as missed. */
const HEARTBEAT_EVERY = z.number().int().min(60).max(604_800);
const HEARTBEAT_GRACE = z.number().int().min(0).max(86_400);

export const MonitorConfigSchema = z
  .object({
    method: HttpOptions.Method,
    expectedStatus: HttpOptions.Status,
    keyword: z.string().min(1).max(200),
    timeoutMs: z.number().int().min(1000).max(30_000),
    /** Extra request headers. Put anything secret in `secrets` and refer to it as {{secret.NAME}}. */
    headers: HeadersSchema,
    body: HttpOptions.Body,
    /** Checks on the JSON the endpoint returns. */
    assertions: z.array(AssertionSchema).max(10),
    /** A flow: several requests in order, each able to use values from the one before. */
    steps: z.array(StepSchema).min(1).max(5),
    /** A browser monitor: what to do on the page after opening the target, and what to expect. */
    browser: z.array(BrowserStepSchema).max(MAX_BROWSER_STEPS),
    expectEvery: HEARTBEAT_EVERY,
    grace: HEARTBEAT_GRACE,
  })
  .partial()
  .strict()
  .superRefine((c, ctx) => {
    if (c.body !== undefined && c.method !== "POST")
      ctx.addIssue({ code: "custom", path: ["body"], message: "Only POST requests have a body" });
    if (c.method === "HEAD" && (c.keyword || c.assertions?.length))
      ctx.addIssue({
        code: "custom",
        path: ["method"],
        message:
          "A HEAD request has no body to search, so keyword and JSON checks need GET or POST",
      });
    for (const [i, s] of (c.steps ?? []).entries()) {
      const problem = stepUrlProblem(s.url);
      if (problem) ctx.addIssue({ code: "custom", path: ["steps", i, "url"], message: problem });
    }
    for (const [i, b] of (c.browser ?? []).entries()) {
      const problem = b.do === "goto" ? stepUrlProblem(b.url) : null;
      if (problem) ctx.addIssue({ code: "custom", path: ["browser", i, "url"], message: problem });
    }
  });

const RegionsSchema = z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{1,23}$/)).max(8);

const BaseMonitorSchema = {
  config: MonitorConfigSchema.default({}),
  /** Write-only values used as {{secret.NAME}} in headers, body and addresses. Stored encrypted. */
  secrets: SecretsSchema.default({}),
  failureThreshold: z.number().int().min(1).max(10).default(2),
  /** Where to check from, by name. Empty means the main server only. */
  regions: RegionsSchema.default([]),
  latencyThresholdMs: z.number().int().min(50).max(60_000).optional(),
  workspaceId: z.uuid(),
  name: z
    .string()
    .trim()
    .min(1, { error: "Name is required" })
    .max(100, { error: "Name must be at most 100 characters" }),
  interval: z.coerce
    .number()
    .int({ error: "Interval must be an integer" })
    .positive({ error: "Interval must be greater than 0" })
    .refine((v) => [60, 300, 600, 1800, 3600].includes(v), {
      error: "Interval must be one of 60, 300, 600, 1800, 3600",
    }),
  active: z.boolean().default(true),
};

const publicTarget = (message = "Target must be a public host") => ({
  check: (value: string) => !isBlockedHost(hostOfTarget(value)),
  message,
});

const CreateMonitorBase = z.discriminatedUnion("type", [
  // A flow: the address is the first step's, filled in by the server.
  z.object({
    ...BaseMonitorSchema,
    type: z.literal("flow"),
    target: z.string().optional(),
  }),
  // A heartbeat is pinged by the job, so there is nothing to call.
  z.object({
    ...BaseMonitorSchema,
    type: z.literal("heartbeat"),
    target: z.string().optional(),
  }),
  z.object({
    ...BaseMonitorSchema,
    type: z.literal("http"),
    target: z.httpUrl({
      error: "Target must be a valid http/https URL",
    }),
  }),

  z.object({
    ...BaseMonitorSchema,
    type: z.literal("ssl"),
    target: z.hostname({
      error: "Target must be a valid hostname/domain",
    }),
  }),

  z.object({
    ...BaseMonitorSchema,
    type: z.literal("synthetic"),
    target: z.httpUrl({
      error: "Target must be a valid http/https URL",
    }),
  }),

  z.object({
    ...BaseMonitorSchema,
    type: z.literal("dns"),
    target: z.hostname({
      error: "Target must be a valid hostname/domain",
    }),
  }),

  z.object({
    ...BaseMonitorSchema,
    type: z.literal("tcp"),
    target: z
      .string()
      .regex(/^(?!-)[a-zA-Z0-9.-]+(?<!-):([1-9][0-9]{0,4})$/, {
        error: 'Target must be in "host:port" format',
      })
      .refine(
        (value) => {
          const port = Number(value.split(":").pop());
          return port >= 1 && port <= 65535;
        },
        { error: "Port must be between 1 and 65535" },
      ),
  }),
]);

export const CreateMonitorSchema = CreateMonitorBase.superRefine((m, ctx) => {
  if (m.target && !publicTarget().check(m.target))
    ctx.addIssue({ code: "custom", path: ["target"], message: publicTarget().message });
  if (m.type === "flow" && !m.config.steps?.length)
    ctx.addIssue({ code: "custom", path: ["config", "steps"], message: "Add at least one step" });
  if (m.type !== "synthetic" && m.config.browser)
    ctx.addIssue({
      code: "custom",
      path: ["config", "browser"],
      message: "Browser steps are only for browser monitors",
    });
  if (m.type !== "flow" && m.config.steps)
    ctx.addIssue({
      code: "custom",
      path: ["config", "steps"],
      message: "Steps are only for flows",
    });
  if (m.type === "heartbeat") {
    if (!m.config.expectEvery)
      ctx.addIssue({
        code: "custom",
        path: ["config", "expectEvery"],
        message: "Say how often it should check in",
      });
  } else if (m.config.expectEvery !== undefined || m.config.grace !== undefined)
    ctx.addIssue({
      code: "custom",
      path: ["config"],
      message: "expectEvery and grace are only for heartbeats",
    });
  if (
    m.type !== "http" &&
    m.type !== "flow" &&
    (m.config.headers || m.config.body !== undefined || m.config.assertions)
  )
    ctx.addIssue({
      code: "custom",
      path: ["config"],
      message: "Headers, body and JSON checks are for HTTP monitors and flows",
    });
  const problem = referencesProblem(
    m.config,
    Object.keys(m.secrets),
    m.type === "http" ? m.target : undefined,
  );
  if (problem) ctx.addIssue({ code: "custom", path: ["config"], message: problem });
});

export const UpdateMonitorSchema = z.object({
  name: BaseMonitorSchema.name.optional(),
  interval: BaseMonitorSchema.interval.optional(),
  active: z.boolean().optional(),
  config: MonitorConfigSchema.optional(),
  /** Omit to leave secrets alone. Names missing from the object are removed; null keeps the stored value. */
  secrets: SecretsUpdateSchema.optional(),
  failureThreshold: z.number().int().min(1).max(10).optional(),
  // No default here: leaving it out must leave the regions alone.
  regions: RegionsSchema.optional(),
  latencyThresholdMs: BaseMonitorSchema.latencyThresholdMs.nullable(),
});

export type UpdateMonitorInput = z.infer<typeof UpdateMonitorSchema>;

export type CreateMonitorInput = z.infer<typeof CreateMonitorSchema>;
