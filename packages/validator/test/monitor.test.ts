import { describe, expect, test } from "bun:test";

import {
  CreateMonitorSchema,
  JSON_PATH,
  referencesProblem,
  stepUrlProblem,
  UpdateMonitorSchema,
} from "../src";

const WS = "01a14866-ba55-7faf-a7ed-5dd76102aaac";
const base = { workspaceId: WS, name: "m", interval: 300 };
const parse = (o: object) => CreateMonitorSchema.safeParse({ ...base, ...o });

describe("JSON paths", () => {
  test("accepts dotted keys and indexes, refuses anything else", () => {
    for (const p of [
      "status",
      "data.status",
      "data.items[0].name",
      "[0].id",
      "a_b.c-d",
      "items[12]",
    ])
      expect(JSON_PATH.test(p)).toBe(true);
    for (const p of [
      "",
      "a..b",
      "a.",
      ".a",
      "a[x]",
      "a[0",
      "$..x",
      "a b",
      "a[1][2][",
      "__proto__[",
      "a;b",
    ])
      expect(JSON_PATH.test(p)).toBe(false);
  });
});

describe("step addresses", () => {
  test("public web addresses pass, variables are allowed after the host only", () => {
    expect(stepUrlProblem("https://api.example.com/users/{{uid}}?k={{secret.K}}")).toBeNull();
    expect(stepUrlProblem("http://example.com")).toBeNull();
    expect(stepUrlProblem("https://{{host}}.example.com/")).toContain("not in the host");
    expect(stepUrlProblem("https://api.example.com{{path}}")).toContain("not in the host");
  });
  test("private, credentialed and non-web addresses are refused", () => {
    for (const u of [
      "http://localhost/",
      "http://127.0.0.1/",
      "http://10.1.2.3/",
      "http://169.254.169.254/latest",
      "ftp://example.com/",
      "https://u:p@example.com/",
      "not a url",
      "http://metadata.google.internal/",
    ])
      expect(stepUrlProblem(u)).not.toBeNull();
  });
});

describe("references", () => {
  test("secrets must exist and variables must come from an earlier step", () => {
    const cfg = { headers: { A: "{{secret.TOKEN}}" } };
    expect(referencesProblem(cfg, ["TOKEN"])).toBeNull();
    expect(referencesProblem(cfg, [])).toContain("no secret named TOKEN");
    expect(referencesProblem({ headers: { A: "{{x}}" } }, [])).toContain("no earlier step");
    expect(referencesProblem({ body: "{{secret.B}}" }, ["B"])).toBeNull();
    expect(referencesProblem({}, [], "https://a.example.com/?k={{secret.Z}}")).toContain("Z");
  });
});

describe("creating monitors", () => {
  test("an HTTP monitor with headers, secrets and checks is accepted; defaults apply", () => {
    const r = parse({
      type: "http",
      target: "https://api.example.com/health",
      config: {
        method: "POST",
        headers: { Authorization: "Bearer {{secret.T}}" },
        body: "{}",
        assertions: [{ path: "ok", op: "equals", value: "true" }],
      },
      secrets: { T: "abc" },
    });
    expect(r.success).toBe(true);
    expect(parse({ type: "http", target: "https://a.example.com/" }).success).toBe(true);
  });

  test("the rules that stop a monitor from being useless or unsafe", () => {
    const bad = (o: object) =>
      expect(parse({ type: "http", target: "https://a.example.com/", ...o }).success).toBe(false);
    bad({ config: { body: "x" } }); // GET has no body
    bad({ config: { method: "HEAD", keyword: "x" } });
    bad({ config: { headers: { "User-Agent": "x" } } }); // Upzy identifies itself
    bad({ config: { headers: { "Proxy-Authorization": "x" } } });
    bad({
      config: { headers: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`H${i}`, "v"])) },
    });
    bad({ config: { assertions: [{ path: "a", op: "equals" }] } }); // needs a value
    bad({ config: { assertions: [{ path: "a", op: "gt", value: "" }] } });
    bad({ secrets: { api_token: "x" } });
    bad({ secrets: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`S${i}`, "v"])) });
    expect(
      parse({ type: "tcp", target: "db.example.com:5432", config: { headers: { A: "b" } } })
        .success,
    ).toBe(false);
  });

  test("heartbeats need an expected period and take no address", () => {
    expect(parse({ type: "heartbeat", config: { expectEvery: 3600 } }).success).toBe(true);
    expect(parse({ type: "heartbeat", config: { expectEvery: 3600, grace: 600 } }).success).toBe(
      true,
    );
    expect(parse({ type: "heartbeat", config: {} }).success).toBe(false);
    expect(parse({ type: "heartbeat", config: { expectEvery: 5 } }).success).toBe(false);
    expect(parse({ type: "heartbeat", config: { expectEvery: 10 ** 7 } }).success).toBe(false);
    expect(
      parse({ type: "http", target: "https://a.example.com/", config: { expectEvery: 3600 } })
        .success,
    ).toBe(false);
  });

  test("flows need steps, each with a public address, and variables must be defined earlier", () => {
    const step = (o: object = {}) => ({ name: "s", url: "https://a.example.com/x", ...o });
    expect(parse({ type: "flow", config: { steps: [step()] } }).success).toBe(true);
    expect(
      parse({
        type: "flow",
        config: { steps: [step({ extract: { t: "a.b" } }), step({ headers: { A: "{{t}}" } })] },
      }).success,
    ).toBe(true);
    expect(
      parse({ type: "flow", config: { steps: [step({ headers: { A: "{{t}}" } })] } }).success,
    ).toBe(false);
    expect(
      parse({ type: "flow", config: { steps: [step({ url: "http://localhost/" })] } }).success,
    ).toBe(false);
    expect(parse({ type: "flow", config: {} }).success).toBe(false);
    expect(parse({ type: "flow", config: { steps: [step({ method: "DELETE" })] } }).success).toBe(
      false,
    );
    expect(
      parse({ type: "flow", config: { steps: [step({ method: "GET", body: "x" })] } }).success,
    ).toBe(false);
  });

  test("updates change only what is sent, and secrets may use null to keep a stored value", () => {
    expect(UpdateMonitorSchema.parse({ name: "x", latencyThresholdMs: null })).toEqual({
      name: "x",
      latencyThresholdMs: null,
    });
    expect(UpdateMonitorSchema.parse({ secrets: { A: null, B: "new" } }).secrets).toEqual({
      A: null,
      B: "new",
    });
  });
});
