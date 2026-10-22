import z from "zod";

import { hostOfTarget, isBlockedHost } from "./ssrf";

/** Headers Upzy sets itself or that would let a monitor misbehave on the connection. */
const FORBIDDEN_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "expect",
  "keep-alive",
  "user-agent",
]);

export const HeaderName = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,40}$/, "Header names use letters, digits and hyphens")
  .refine(
    (n) => !FORBIDDEN_HEADERS.has(n.toLowerCase()) && !n.toLowerCase().startsWith("proxy-"),
    "That header is set by Upzy",
  );
const HeaderValue = z
  .string()
  .min(1)
  .max(2000)
  // eslint-disable-next-line no-control-regex
  .refine((v) => !/[\r\n\u0000]/.test(v), "Header values are a single line");
export const HeadersSchema = z
  .record(HeaderName, HeaderValue)
  .refine((h) => Object.keys(h).length <= 10, "At most 10 headers");

const ASSERT_OPS = [
  "equals",
  "not_equals",
  "contains",
  "exists",
  "not_exists",
  "gt",
  "lt",
] as const;
export type AssertOp = (typeof ASSERT_OPS)[number];
/** `data.items[0].status`: dot-separated keys with optional [index]. */
export const JSON_PATH =
  /^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+|\[\d{1,4}\])*$|^\[\d{1,4}\](\.[A-Za-z0-9_$-]+|\[\d{1,4}\])*$/;

export const AssertionSchema = z
  .object({
    path: z.string().max(120).regex(JSON_PATH, "Use a path like data.status or items[0].name"),
    op: z.enum(ASSERT_OPS),
    value: z.string().max(300).optional(),
  })
  .refine((a) => a.op === "exists" || a.op === "not_exists" || a.value !== undefined, {
    message: "This check needs a value to compare with",
    path: ["value"],
  })
  .refine(
    (a) =>
      a.op !== "gt" && a.op !== "lt"
        ? true
        : a.value !== undefined && a.value.trim() !== "" && Number.isFinite(Number(a.value)),
    {
      message: "Greater/less than needs a number",
      path: ["value"],
    },
  );
export type Assertion = z.infer<typeof AssertionSchema>;

const Method = z.enum(["GET", "HEAD", "POST"]);
const Body = z.string().max(10_000);
const Status = z.array(z.number().int().min(100).max(599)).min(1).max(20);

/** The name of a variable a step reads from an earlier response. */
export const VarName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,29}$/, "Letters, digits and underscores");

export const StepSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    method: Method.default("GET"),
    url: z.string().max(2000),
    headers: HeadersSchema.default({}),
    body: Body.optional(),
    expectedStatus: Status.optional(),
    assertions: z.array(AssertionSchema).max(10).default([]),
    /** variable name -> JSON path in this step's response body. */
    extract: z.record(VarName, z.string().regex(JSON_PATH)).default({}),
  })
  .refine((s) => s.body === undefined || s.method === "POST", {
    message: "Only POST requests have a body",
    path: ["body"],
  });
export type Step = z.infer<typeof StepSchema>;

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,39}$/;
/** Write-only values the monitor may use as {{secret.NAME}}. Stored encrypted; never shown again. */
export const SecretsSchema = z
  .record(
    z.string().regex(SECRET_NAME, "Use UPPER_CASE names like API_TOKEN"),
    z.string().min(1).max(2000),
  )
  .refine((s) => Object.keys(s).length <= 10, "At most 10 secrets");
/** On update a null value means "keep what is stored". Names left out are deleted. */
export const SecretsUpdateSchema = z
  .record(
    z.string().regex(SECRET_NAME, "Use UPPER_CASE names like API_TOKEN"),
    z.string().min(1).max(2000).nullable(),
  )
  .refine((s) => Object.keys(s).length <= 10, "At most 10 secrets");

export const TEMPLATE = /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g;
const templatesIn = (s: string | undefined) =>
  s ? [...s.matchAll(TEMPLATE)].map((m) => m[1]!) : [];

/** Every {{name}} used in a monitor's headers, body and URLs. */
function used(parts: { url?: string; headers?: Record<string, string>; body?: string }) {
  return [
    ...templatesIn(parts.url),
    ...Object.values(parts.headers ?? {}).flatMap(templatesIn),
    ...templatesIn(parts.body),
  ];
}

/**
 * Catches typos before a monitor ever runs: a {{secret.X}} that isn't defined, or a {{variable}} no earlier step
 * extracts. Returns the problem in words, or null.
 */
export function referencesProblem(
  config: { headers?: Record<string, string>; body?: string; steps?: Step[] },
  secretNames: Iterable<string>,
  target?: string,
): string | null {
  const secrets = new Set(secretNames);
  const known = new Set<string>();
  const check = (names: string[], where: string) => {
    for (const n of names) {
      if (n.startsWith("secret.")) {
        if (!secrets.has(n.slice(7)))
          return `${where} uses {{${n}}} but no secret named ${n.slice(7)} is set`;
      } else if (!known.has(n)) return `${where} uses {{${n}}} but no earlier step provides it`;
    }
    return null;
  };
  if (config.steps?.length) {
    for (const [i, s] of config.steps.entries()) {
      const p = check(used(s), `Step ${i + 1}`);
      if (p) return p;
      for (const v of Object.keys(s.extract)) known.add(v);
    }
    return null;
  }
  return check(used({ url: target, headers: config.headers, body: config.body }), "This monitor");
}

/** The address a step will call must be a public web address; variables may only appear after the host. */
export function stepUrlProblem(url: string): string | null {
  const probe = url.replace(TEMPLATE, "x");
  let u: URL;
  try {
    u = new URL(probe);
  } catch {
    return "Enter a full address like https://api.example.com/login";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "Use an http or https address";
  if (u.username || u.password)
    return "Don't put credentials in the address; use a header with a secret";
  if (isBlockedHost(hostOfTarget(probe))) return "That address isn't public";
  const beforePath = url.slice(
    0,
    url.indexOf("/", url.indexOf("//") + 2) === -1
      ? url.length
      : url.indexOf("/", url.indexOf("//") + 2),
  );
  if (TEMPLATE.test(beforePath)) {
    TEMPLATE.lastIndex = 0;
    return "Variables can be used in the path and query, not in the host";
  }
  TEMPLATE.lastIndex = 0;
  return null;
}

export const HttpOptions = { Method, Body, Status };
