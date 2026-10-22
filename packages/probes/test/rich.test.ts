import { describe, expect, test } from "bun:test";

import { evalAssertions, readPath, redactValues, render, runProbe, TemplateError } from "../src";
import type { ProbeTarget } from "../src";

type Req = { url: string; method?: string; headers?: Record<string, string>; body?: string };

/** A fake web: answers by URL and records what it was sent. */
function web(routes: Record<string, { status?: number; body?: unknown }>) {
  const seen: Req[] = [];
  const fetch = (async (url: string, opts: Record<string, unknown> = {}) => {
    seen.push({ url, ...(opts as object) } as Req);
    const r = routes[new URL(url).pathname];
    if (!r) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    return {
      status: r.status ?? 200,
      headers: {},
      setCookies: [],
      finalUrl: url,
      body: typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {}),
      ttfbMs: 5,
      totalMs: 12,
    };
  }) as unknown as ProbeTarget["fetch"];
  return { fetch, seen };
}

describe("JSON paths and assertions", () => {
  const doc = {
    data: { status: "ok", count: 7, items: [{ name: "a" }, { name: "b" }], tags: ["x", "y"] },
    nothing: null,
  };

  test("paths read nested keys and array indexes", () => {
    expect(readPath(doc, "data.status")).toBe("ok");
    expect(readPath(doc, "data.items[1].name")).toBe("b");
    expect(readPath(doc, "data.missing.deeper")).toBeUndefined();
    expect(readPath(doc, "data.status.length")).toBeUndefined(); // no reaching into strings
  });

  test("each operator", () => {
    const ok = (path: string, op: string, value?: string) =>
      evalAssertions(JSON.stringify(doc), [{ path, op: op as never, value }]).ok;
    expect(ok("data.status", "equals", "ok")).toBe(true);
    expect(ok("data.count", "equals", "7")).toBe(true);
    expect(ok("data.status", "not_equals", "down")).toBe(true);
    expect(ok("data.status", "not_equals", "ok")).toBe(false);
    expect(ok("data.tags", "contains", "y")).toBe(true);
    expect(ok("data.status", "contains", "k")).toBe(true);
    expect(ok("data.count", "gt", "5")).toBe(true);
    expect(ok("data.count", "lt", "5")).toBe(false);
    expect(ok("data.status", "gt", "5")).toBe(false);
    expect(ok("data.status", "exists")).toBe(true);
    expect(ok("nothing", "exists")).toBe(false);
    expect(ok("nothing", "not_exists")).toBe(true);
    expect(ok("data.nope", "not_exists")).toBe(true);
  });

  test("a failure names the path and what was expected; objects and invalid JSON are handled", () => {
    const r = evalAssertions('{"data":{"status":"degraded"}}', [
      { path: "data.status", op: "equals", value: "ok" },
    ]);
    expect(r).toEqual({
      ok: false,
      message: "Expected data.status to equal ok, but it is degraded",
    });
    const o = evalAssertions('{"data":{"a":1}}', [{ path: "data", op: "equals", value: "x" }]);
    expect(o.ok === false && o.message).toBe(
      "Expected data to equal x, but it has a different value",
    );
    expect(evalAssertions("<html>", [{ path: "a", op: "exists" }])).toEqual({
      ok: false,
      message: "The response isn't valid JSON",
    });
  });
});

describe("templates and redaction", () => {
  test("variables and secrets are filled in; an unknown one fails loudly", () => {
    expect(
      render("Bearer {{secret.TOKEN}} for {{ user }}", { user: "ada" }, { TOKEN: "s3cret" }),
    ).toBe("Bearer s3cret for ada");
    expect(() => render("{{secret.MISSING}}", {}, {})).toThrow(TemplateError);
    expect(() => render("{{nope}}", {}, {})).toThrow("{{nope}} has no value");
  });

  test("secret values never survive redaction", () => {
    expect(redactValues("401 for key abcd1234 and again abcd1234", ["abcd1234"])).toBe(
      "401 for key *** and again ***",
    );
    expect(redactValues("short ab", ["ab"])).toBe("short ab"); // too short to be worth masking
  });
});

describe("rich HTTP monitor", () => {
  test("sends headers (with secrets filled in), a JSON body and the POST method", async () => {
    const w = web({ "/health": { body: { status: "ok" } } });
    const r = await runProbe({
      type: "http",
      target: "https://api.example.com/health",
      config: {
        method: "POST",
        headers: { Authorization: "Bearer {{secret.API_TOKEN}}", "X-App": "ios" },
        body: '{"ping":true}',
        assertions: [{ path: "status", op: "equals", value: "ok" }],
      },
      secrets: { API_TOKEN: "tok_123456" },
      fetch: w.fetch,
    });
    expect(r.status).toBe("up");
    expect(w.seen[0]).toMatchObject({
      method: "POST",
      body: '{"ping":true}',
      headers: {
        Authorization: "Bearer tok_123456",
        "X-App": "ios",
        "content-type": "application/json",
      },
    });
  });

  test("a failed assertion makes it down with a readable reason and its own error kind", async () => {
    const w = web({ "/h": { body: { status: "degraded" } } });
    const r = await runProbe({
      type: "http",
      target: "https://api.example.com/h",
      config: { assertions: [{ path: "status", op: "equals", value: "ok" }] },
      fetch: w.fetch,
    });
    expect(r).toMatchObject({
      status: "down",
      errorKind: "assertion",
      error: "Expected status to equal ok, but it is degraded",
    });
  });

  test("a missing secret is an error that never sends the request, and a leaked secret is scrubbed from errors", async () => {
    const w = web({});
    const r = await runProbe({
      type: "http",
      target: "https://api.example.com/x",
      config: { headers: { Authorization: "{{secret.NOPE}}" } },
      fetch: w.fetch,
    });
    expect(r).toMatchObject({ status: "down", error: "{{secret.NOPE}} has no value" });
    expect(w.seen).toHaveLength(0);

    const leaky = (async () => {
      throw new Error("failed calling https://api.example.com/x?key=tok_999999");
    }) as unknown as ProbeTarget["fetch"];
    const r2 = await runProbe({
      type: "http",
      target: "https://api.example.com/x?key={{secret.K}}",
      config: {},
      secrets: { K: "tok_999999" },
      fetch: leaky,
    });
    expect(r2.error).not.toContain("tok_999999");
    expect(r2.error).toContain("***");
  });
});

describe("flow monitor", () => {
  const steps = (over: Partial<Record<string, unknown>>[] = []) =>
    [
      {
        name: "Log in",
        method: "POST",
        url: "https://api.example.com/login",
        headers: {},
        body: '{"user":"probe","password":"{{secret.PASSWORD}}"}',
        assertions: [],
        extract: { token: "data.token", uid: "data.id" },
      },
      {
        name: "Fetch profile",
        method: "GET",
        url: "https://api.example.com/users/{{uid}}",
        headers: { Authorization: "Bearer {{token}}" },
        assertions: [{ path: "email", op: "exists" }],
        extract: {},
      },
      ...over,
    ] as never;

  test("passes values from one step to the next and finishes up", async () => {
    const w = web({
      "/login": { body: { data: { token: "jwt-abcdef", id: 42 } } },
      "/users/42": { body: { email: "a@b.co" } },
    });
    const r = await runProbe({
      type: "flow",
      target: "",
      config: { steps: steps() },
      secrets: { PASSWORD: "pw-secret-1" },
      fetch: w.fetch,
    });
    expect(r).toMatchObject({ status: "up", statusCode: 200 });
    expect(w.seen.map((s) => s.url)).toEqual([
      "https://api.example.com/login",
      "https://api.example.com/users/42",
    ]);
    expect(w.seen[0]!.body).toBe('{"user":"probe","password":"pw-secret-1"}');
    expect(w.seen[1]!.headers).toMatchObject({ Authorization: "Bearer jwt-abcdef" });
  });

  test("the first failing step ends the run and names itself", async () => {
    const w = web({ "/login": { status: 500, body: {} } });
    const r = await runProbe({
      type: "flow",
      target: "",
      config: { steps: steps() },
      secrets: { PASSWORD: "pw-secret-1" },
      fetch: w.fetch,
    });
    expect(r).toMatchObject({
      status: "down",
      errorKind: "http",
      error: "Step 1 (Log in): unexpected status 500",
    });
    expect(w.seen).toHaveLength(1);
  });

  test("a value that can't be read, or a failed check in a later step, says which step", async () => {
    const noToken = web({ "/login": { body: { data: {} } } });
    const a = await runProbe({
      type: "flow",
      target: "",
      config: { steps: steps() },
      secrets: { PASSWORD: "pw-secret-1" },
      fetch: noToken.fetch,
    });
    expect(a.error).toBe(
      "Step 1 (Log in): couldn't read data.token from the response (needed for {{token}})",
    );

    const noEmail = web({
      "/login": { body: { data: { token: "t-1234567", id: 1 } } },
      "/users/1": { body: {} },
    });
    const b = await runProbe({
      type: "flow",
      target: "",
      config: { steps: steps() },
      secrets: { PASSWORD: "pw-secret-1" },
      fetch: noEmail.fetch,
    });
    expect(b).toMatchObject({
      status: "down",
      errorKind: "assertion",
      error: "Step 2 (Fetch profile): Expected email to exist, but it is missing",
    });
  });

  test("extracted values and secrets never appear in the stored error", async () => {
    const w = web({
      "/login": { body: { data: { token: "jwt-abcdef-LEAK", id: 7 } } },
      "/users/7": { body: { email: "jwt-abcdef-LEAK" } },
    });
    const bad = steps();
    (bad as never as { assertions: unknown[] }[])[1]!.assertions = [
      { path: "email", op: "equals", value: "someone@else.co" },
    ];
    const r = await runProbe({
      type: "flow",
      target: "",
      config: { steps: bad },
      secrets: { PASSWORD: "pw-secret-1" },
      fetch: w.fetch,
    });
    expect(r.status).toBe("down");
    expect(r.error).not.toContain("jwt-abcdef-LEAK");
    expect(r.error).toContain("***");
  });

  test("a connection error in a step is classified and attributed", async () => {
    const w = web({});
    const r = await runProbe({
      type: "flow",
      target: "",
      config: { steps: steps() },
      secrets: { PASSWORD: "pw-secret-1" },
      fetch: w.fetch,
    });
    expect(r).toMatchObject({ status: "down", errorKind: "refused" });
    expect(r.error).toStartWith("Step 1 (Log in): ");
  });
});
