/** The monitor form's state, and how it becomes what the API accepts (and back, when editing). */

export interface Pair {
  name: string;
  value: string;
}
export interface SecretRow {
  name: string;
  value: string;
  /** Stored already: leave the value blank to keep it. */
  stored: boolean;
}
export interface AssertionRow {
  path: string;
  op: "equals" | "not_equals" | "contains" | "exists" | "not_exists" | "gt" | "lt";
  value: string;
}
export interface StepDraft {
  name: string;
  method: "GET" | "POST";
  url: string;
  headers: Pair[];
  body: string;
  /** variable = JSON path */
  extract: Pair[];
  assertions: AssertionRow[];
}

export type MonitorKind = "http" | "tcp" | "dns" | "ssl" | "flow" | "heartbeat";

export interface Draft {
  name: string;
  type: MonitorKind;
  target: string;
  every: string;
  threshold: string;
  /** Milliseconds above which a successful check counts as slow. Empty: never degraded. */
  slowMs: string;
  keyword: string;
  method: "GET" | "POST" | "HEAD";
  headers: Pair[];
  body: string;
  assertions: AssertionRow[];
  secrets: SecretRow[];
  steps: StepDraft[];
  expectEvery: string;
  /** "auto" lets the server pick a sensible grace. */
  grace: string;
}

export const emptyStep = (): StepDraft => ({
  name: "",
  method: "GET",
  url: "",
  headers: [],
  body: "",
  extract: [],
  assertions: [],
});

export const emptyDraft = (): Draft => ({
  name: "",
  type: "http",
  target: "",
  every: "60",
  threshold: "2",
  slowMs: "",
  keyword: "",
  method: "GET",
  headers: [],
  body: "",
  assertions: [],
  secrets: [],
  steps: [emptyStep()],
  expectEvery: "3600",
  grace: "auto",
});

const pairs = (rows: Pair[]) =>
  Object.fromEntries(rows.filter((r) => r.name.trim()).map((r) => [r.name.trim(), r.value]));
const checks = (rows: AssertionRow[]) =>
  rows
    .filter((r) => r.path.trim())
    .map((r) => ({
      path: r.path.trim(),
      op: r.op,
      ...(r.op === "exists" || r.op === "not_exists" ? {} : { value: r.value }),
    }));

/** The `config` the API expects for this draft. Only what applies to the type is included. */
export function configOf(d: Draft) {
  if (d.type === "heartbeat")
    return {
      expectEvery: Number(d.expectEvery),
      ...(d.grace === "auto" ? {} : { grace: Number(d.grace) }),
    };
  if (d.type === "flow")
    return {
      steps: d.steps.map((s) => ({
        name: s.name.trim(),
        method: s.method,
        url: s.url.trim(),
        headers: pairs(s.headers),
        ...(s.method === "POST" && s.body.trim() ? { body: s.body } : {}),
        assertions: checks(s.assertions),
        extract: pairs(s.extract),
      })),
    };
  if (d.type !== "http") return {};
  const headers = pairs(d.headers);
  const assertions = checks(d.assertions);
  return {
    ...(d.method !== "GET" ? { method: d.method } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(d.method === "POST" && d.body.trim() ? { body: d.body } : {}),
    ...(assertions.length ? { assertions } : {}),
    ...(d.keyword.trim() ? { keyword: d.keyword.trim() } : {}),
  };
}

/** New monitors: every secret needs a value. */
export const secretsForCreate = (rows: SecretRow[]) =>
  Object.fromEntries(
    rows.filter((r) => r.name.trim() && r.value).map((r) => [r.name.trim(), r.value]),
  );

/** Editing: a stored secret left blank is kept (null), a typed value replaces it, and removed rows are dropped. */
export const secretsForUpdate = (rows: SecretRow[]) =>
  Object.fromEntries(
    rows
      .filter((r) => r.name.trim() && (r.value || r.stored))
      .map((r) => [r.name.trim(), r.value ? r.value : null]),
  );

type Stored = {
  name: string;
  type: string;
  target: string;
  interval: number;
  failureThreshold: number;
  latencyThresholdMs?: number | null;
  secretNames: string[];
  config: {
    method?: "GET" | "HEAD" | "POST";
    headers?: Record<string, string>;
    body?: string;
    assertions?: AssertionRow[];
    keyword?: string;
    expectEvery?: number;
    grace?: number;
    steps?: {
      name: string;
      method: "GET" | "POST" | "HEAD";
      url: string;
      headers?: Record<string, string>;
      body?: string;
      assertions?: AssertionRow[];
      extract?: Record<string, string>;
    }[];
  };
};

const toPairs = (o: Record<string, string> | undefined): Pair[] =>
  Object.entries(o ?? {}).map(([name, value]) => ({ name, value }));
const toChecks = (a: AssertionRow[] | undefined): AssertionRow[] =>
  (a ?? []).map((x) => ({ path: x.path, op: x.op, value: x.value ?? "" }));

/** A saved monitor as form state, for the edit page. */
export function draftOf(m: Stored): Draft {
  const c = m.config;
  return {
    ...emptyDraft(),
    name: m.name,
    type: m.type as MonitorKind,
    target: m.target,
    every: String(m.interval),
    threshold: String(m.failureThreshold),
    slowMs: m.latencyThresholdMs ? String(m.latencyThresholdMs) : "",
    keyword: c.keyword ?? "",
    method: c.method ?? "GET",
    headers: toPairs(c.headers),
    body: c.body ?? "",
    assertions: toChecks(c.assertions),
    secrets: m.secretNames.map((name) => ({ name, value: "", stored: true })),
    steps: c.steps?.length
      ? c.steps.map((s) => ({
          name: s.name,
          method: s.method === "POST" ? "POST" : "GET",
          url: s.url,
          headers: toPairs(s.headers),
          body: s.body ?? "",
          extract: toPairs(s.extract),
          assertions: toChecks(s.assertions),
        }))
      : [emptyStep()],
    expectEvery: String(c.expectEvery ?? 3600),
    grace: c.grace === undefined ? "auto" : String(c.grace),
  };
}
