import { resolve4, resolve6 } from "node:dns/promises";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";

import type { schema } from "@upzy/db";

import { evalAssertions, readPath, redactValues, render, TemplateError } from "./assert";
import { BlockedTargetError, resolvePublic, safeFetch } from "./egress";

type MonitorConfig = typeof schema.monitors.$inferSelect.config;
type ErrorKind = NonNullable<typeof schema.monitorChecks.$inferInsert.errorKind>;

export interface ProbeTarget {
  type: "http" | "tcp" | "dns" | "ssl" | "synthetic" | "flow" | "heartbeat";
  target: string;
  config: MonitorConfig;
  /** Decrypted secrets, available to the monitor as {{secret.NAME}}. Never stored or logged. */
  secrets?: Record<string, string>;
  /** Replaceable in tests. Production uses the SSRF-guarded client. */
  fetch?: typeof safeFetch;
}

export interface CheckResult {
  status: "up" | "down";
  responseMs: number | null;
  statusCode?: number;
  ttfbMs?: number;
  tlsDaysLeft?: number;
  error?: string;
  errorKind?: ErrorKind;
}

const DEFAULT_TIMEOUT = 10_000;

export function classifyError(e: unknown): { error: string; errorKind: ErrorKind } {
  const err = e as { name?: string; code?: string; message?: string };
  const code = err?.code ?? "";
  const message = err?.message ?? String(e);
  if (e instanceof BlockedTargetError) return { error: message, errorKind: "blocked" };
  if (
    err?.name === "TimeoutError" ||
    err?.name === "AbortError" ||
    code === "ETIMEDOUT" ||
    /timed? ?out/i.test(message)
  ) {
    return { error: "Request timed out", errorKind: "timeout" };
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ENODATA" || code === "ESERVFAIL")
    return { error: `DNS lookup failed (${code})`, errorKind: "dns" };
  if (code === "ECONNREFUSED") return { error: "Connection refused", errorKind: "refused" };
  if (/^ERR_TLS|CERT|SSL|certificate/i.test(code) || /certificate|tls|ssl/i.test(message))
    return { error: message, errorKind: "tls" };
  return { error: message.slice(0, 500), errorKind: "other" };
}

const looksJson = (b: string) => /^\s*[[{]/.test(b);

/** Headers for one request: the monitor's own, a content type if there is a body, with {{...}} filled in. */
function requestOf(
  step: { method?: string; headers?: Record<string, string>; body?: string },
  vars: Record<string, string>,
  secrets: Record<string, string>,
) {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(step.headers ?? {})) headers[k] = render(v, vars, secrets);
  const body = step.body === undefined ? undefined : render(step.body, vars, secrets);
  if (body !== undefined && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type"))
    headers["content-type"] = looksJson(body) ? "application/json" : "text/plain";
  return { headers, body };
}

async function http(t: ProbeTarget): Promise<CheckResult> {
  const { method = "GET", expectedStatus, keyword, timeoutMs = DEFAULT_TIMEOUT } = t.config;
  const secrets = t.secrets ?? {};
  const fetchIt = t.fetch ?? safeFetch;
  const url = render(t.target, {}, secrets);
  const { headers, body } = requestOf(t.config, {}, secrets);
  const res = await fetchIt(url, {
    method: keyword && method === "HEAD" ? "GET" : method,
    timeoutMs,
    headers,
    ...(body !== undefined ? { body } : {}),
  });
  const okStatus = expectedStatus?.length
    ? expectedStatus.includes(res.status)
    : res.status >= 200 && res.status < 400;
  const base = { responseMs: res.totalMs, statusCode: res.status, ttfbMs: res.ttfbMs };
  if (!okStatus)
    return { ...base, status: "down", error: `Unexpected status ${res.status}`, errorKind: "http" };
  if (keyword && !res.body.includes(keyword))
    return { ...base, status: "down", error: "Expected keyword not found", errorKind: "http" };
  if (t.config.assertions?.length) {
    const r = evalAssertions(res.body, t.config.assertions);
    if (!r.ok) return { ...base, status: "down", error: r.message, errorKind: "assertion" };
  }
  return { ...base, status: "up" };
}

const FLOW_BUDGET_MS = 30_000;

/**
 * A sequence of requests, each able to use values read from an earlier response (a login token, an id). The first
 * step that fails ends the run and names itself. The total time is capped, and every message is scrubbed of the
 * secrets and extracted values before it can be stored.
 */
async function flow(t: ProbeTarget): Promise<CheckResult> {
  const steps = t.config.steps ?? [];
  const secrets = t.secrets ?? {};
  const fetchIt = t.fetch ?? safeFetch;
  const vars: Record<string, string> = {};
  const started = performance.now();
  const deadline = started + FLOW_BUDGET_MS;
  let last: { status: number; ttfb: number } | undefined;
  const scrub = (msg: string) =>
    redactValues(msg, [...Object.values(secrets), ...Object.values(vars)]);
  const fail = (n: number, error: string, errorKind: ErrorKind): CheckResult => ({
    status: "down",
    responseMs: Math.round(performance.now() - started),
    ...(last ? { statusCode: last.status } : {}),
    error: scrub(`Step ${n} (${steps[n - 1]?.name}): ${error}`).slice(0, 500),
    errorKind,
  });

  for (const [i, step] of steps.entries()) {
    const n = i + 1;
    const left = deadline - performance.now();
    if (left <= 0) return fail(n, "the flow ran out of time", "timeout");
    try {
      const { headers, body } = requestOf(step, vars, secrets);
      const res = await fetchIt(render(step.url, vars, secrets), {
        method: step.method,
        timeoutMs: Math.min(t.config.timeoutMs ?? DEFAULT_TIMEOUT, left),
        headers,
        ...(body !== undefined ? { body } : {}),
      });
      last = { status: res.status, ttfb: res.ttfbMs };
      const ok = step.expectedStatus?.length
        ? step.expectedStatus.includes(res.status)
        : res.status >= 200 && res.status < 400;
      if (!ok) return fail(n, `unexpected status ${res.status}`, "http");
      if (step.assertions.length) {
        const r = evalAssertions(res.body, step.assertions);
        if (!r.ok) return fail(n, r.message, "assertion");
      }
      const wanted = Object.entries(step.extract);
      if (wanted.length) {
        let json: unknown;
        try {
          json = JSON.parse(res.body);
        } catch {
          return fail(n, "the response isn't JSON, so values can't be read from it", "assertion");
        }
        for (const [name, path] of wanted) {
          const v = readPath(json, path);
          if (v === undefined || v === null || typeof v === "object")
            return fail(
              n,
              `couldn't read ${path} from the response (needed for {{${name}}})`,
              "assertion",
            );
          vars[name] = String(v);
        }
      }
    } catch (e) {
      if (e instanceof TemplateError) return fail(n, e.message, "other");
      const c = classifyError(e);
      return fail(n, c.error, c.errorKind);
    }
  }
  return {
    status: "up",
    responseMs: Math.round(performance.now() - started),
    ...(last ? { statusCode: last.status, ttfbMs: last.ttfb } : {}),
  };
}

async function tcp(t: ProbeTarget): Promise<CheckResult> {
  const idx = t.target.lastIndexOf(":");
  const host = t.target.slice(0, idx);
  const port = Number(t.target.slice(idx + 1));
  const { address } = await resolvePublic(host);
  const started = performance.now();
  await new Promise<void>((ok, bad) => {
    const socket = netConnect({
      host: address,
      port,
      timeout: t.config.timeoutMs ?? DEFAULT_TIMEOUT,
    });
    socket.once("connect", () => (socket.destroy(), ok()));
    socket.once(
      "timeout",
      () => (socket.destroy(), bad(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }))),
    );
    socket.once("error", bad);
  });
  return { status: "up", responseMs: Math.round(performance.now() - started) };
}

async function dns(t: ProbeTarget): Promise<CheckResult> {
  const started = performance.now();
  const [a, aaaa] = await Promise.allSettled([resolve4(t.target), resolve6(t.target)]);
  const found = [a, aaaa].some((r) => r.status === "fulfilled" && r.value.length > 0);
  const responseMs = Math.round(performance.now() - started);
  if (!found) return { status: "down", responseMs, error: "No A/AAAA records", errorKind: "dns" };
  return { status: "up", responseMs };
}

async function ssl(t: ProbeTarget): Promise<CheckResult> {
  const { address } = await resolvePublic(t.target);
  const started = performance.now();
  const cert = await new Promise<{ valid_to?: string }>((ok, bad) => {
    const socket = tlsConnect(
      {
        host: address,
        port: 443,
        servername: t.target,
        timeout: t.config.timeoutMs ?? DEFAULT_TIMEOUT,
      },
      () => {
        const c = socket.getPeerCertificate();
        socket.destroy();
        if (!socket.authorized && socket.authorizationError)
          return bad(
            Object.assign(new Error(String(socket.authorizationError)), { code: "ERR_TLS_CERT" }),
          );
        ok(c as { valid_to?: string });
      },
    );
    socket.once(
      "timeout",
      () => (socket.destroy(), bad(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }))),
    );
    socket.once("error", bad);
  });
  const responseMs = Math.round(performance.now() - started);
  const expiresAt = cert.valid_to ? new Date(cert.valid_to).getTime() : NaN;
  if (Number.isNaN(expiresAt))
    return {
      status: "down",
      responseMs,
      error: "Could not read certificate expiry",
      errorKind: "tls",
    };
  const tlsDaysLeft = Math.floor((expiresAt - Date.now()) / 86_400_000);
  if (tlsDaysLeft < 0)
    return {
      status: "down",
      responseMs,
      tlsDaysLeft,
      error: "Certificate has expired",
      errorKind: "tls",
    };
  return { status: "up", responseMs, tlsDaysLeft };
}

/** Runs one check. Never throws: failures become `status: "down"` with a classified error. */
export async function runProbe(t: ProbeTarget): Promise<CheckResult> {
  const started = performance.now();
  try {
    switch (t.type) {
      case "http":
        return await http(t);
      case "flow":
        return await flow(t);
      case "tcp":
        return await tcp(t);
      case "dns":
        return await dns(t);
      case "ssl":
        return await ssl(t);
      default:
        return {
          status: "down",
          responseMs: null,
          error: `${t.type} monitors are not supported yet`,
          errorKind: "other",
        };
    }
  } catch (e) {
    const c =
      e instanceof TemplateError
        ? { error: e.message, errorKind: "other" as const }
        : classifyError(e);
    return {
      status: "down",
      responseMs: Math.round(performance.now() - started),
      error: redactValues(c.error, Object.values(t.secrets ?? {})),
      errorKind: c.errorKind,
    };
  }
}
