import { describe, expect, test } from "bun:test";

import { ToolInputError, ToolUnreachableError, type ToolResult } from "@upzy/security";
import { Elysia } from "elysia";

import { toolsModule } from "../src/modules/tools";
import { errors } from "../src/plugins/errors";
import { DEFAULT_RULES, rateLimit } from "../src/plugins/rate-limit";

const result = (host: string, tool = "headers"): ToolResult => ({
  tool: tool as ToolResult["tool"],
  host,
  score: 100,
  grade: "A",
  findings: [],
  facts: [],
  detected: null,
  checkedAt: "2026-11-01T00:00:00.000Z",
});

function setup(over: { run?: (tool: any, host: string) => Promise<ToolResult> } = {}) {
  const calls: string[] = [];
  let clock = 1_000_000;
  const run =
    over.run ??
    (async (tool: string, host: string) => {
      calls.push(`${tool}:${host}`);
      return result(host, tool);
    });
  const app = new Elysia().use(errors).use(toolsModule({ run: run as never, now: () => clock }));
  const get = (path: string) => app.handle(new Request(`http://localhost${path}`));
  return { get, calls, tick: (ms: number) => (clock += ms) };
}

describe("free checker API", () => {
  test("is public: no session needed, and the result is not cached by browsers", async () => {
    const { get } = setup();
    const r = await get("/tools/headers?host=example.com");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(((await r.json()) as ToolResult).host).toBe("example.com");
  });

  test("an unknown tool is a 404, and a bad host is a 422 that never reaches the checks", async () => {
    const { get, calls } = setup();
    expect((await get("/tools/ports?host=example.com")).status).toBe(404);
    expect((await get("/tools/__proto__?host=example.com")).status).toBe(404);
    for (const host of ["", "localhost", "127.0.0.1", "10.0.0.1", "http://169.254.169.254/"]) {
      const r = await get(`/tools/headers?host=${encodeURIComponent(host)}`);
      expect(r.status, host).toBe(422);
    }
    expect((await get("/tools/headers")).status).toBeGreaterThanOrEqual(400);
    expect(calls).toHaveLength(0);
  });

  test("the same site is checked once per ten minutes, however it is typed", async () => {
    const { get, calls, tick } = setup();
    await get("/tools/headers?host=example.com");
    await get("/tools/headers?host=Example.COM");
    await get(`/tools/headers?host=${encodeURIComponent("https://example.com/path?x=1")}`);
    expect(calls).toEqual(["headers:example.com"]);

    // A different tool or site is its own check.
    await get("/tools/ssl?host=example.com");
    await get("/tools/headers?host=other.org");
    expect(calls).toEqual(["headers:example.com", "ssl:example.com", "headers:other.org"]);

    tick(10 * 60_000 + 1);
    await get("/tools/headers?host=example.com");
    expect(calls.filter((c) => c === "headers:example.com")).toHaveLength(2);
  });

  test("simultaneous requests for one site share a single check", async () => {
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { get } = setup({
      run: async (_t, host) => {
        started++;
        await gate;
        return result(host);
      },
    });
    const all = Promise.all([1, 2, 3].map(() => get("/tools/headers?host=example.com")));
    await Bun.sleep(20);
    release();
    const rs = await all;
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(started).toBe(1);
  });

  test("a site that can't be checked is a 422 with the reason, and failures are not cached", async () => {
    let attempt = 0;
    const { get } = setup({
      run: async (_t, host) => {
        attempt++;
        if (attempt === 1) throw new ToolUnreachableError(`Couldn't load https://${host}/.`);
        return result(host);
      },
    });
    const bad = await get("/tools/headers?host=down.example.org");
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { message: string }).message).toContain("Couldn't load");
    expect((await get("/tools/headers?host=down.example.org")).status).toBe(200);
  });

  test("an unexpected failure is a generic 502 that leaks nothing", async () => {
    const quiet = console.error;
    console.error = () => {};
    try {
      const { get } = setup({
        run: async () => {
          throw new Error("connect ECONNREFUSED 10.1.2.3:5432 password=hunter2");
        },
      });
      const r = await get("/tools/headers?host=example.com");
      expect(r.status).toBe(502);
      const text = await r.text();
      expect(text).not.toContain("hunter2");
      expect(text).not.toContain("10.1.2.3");
    } finally {
      console.error = quiet;
    }
  });

  test("input errors raised inside the check are also a 422", async () => {
    const { get } = setup({
      run: async () => {
        throw new ToolInputError("Enter a public domain name.");
      },
    });
    expect((await get("/tools/headers?host=example.com")).status).toBe(422);
  });

  test("only ten checks a minute per address", async () => {
    const app = new Elysia()
      .use(
        rateLimit({
          webOrigin: "http://localhost:3001",
          rules: [
            { match: (p) => p.startsWith("/tools/"), bucket: "tools", max: 3, windowMs: 60_000 },
          ],
        }),
      )
      .use(errors)
      .use(toolsModule({ run: (async (_t: string, h: string) => result(h)) as never }));
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++)
      statuses.push(
        (await app.handle(new Request(`http://localhost/tools/headers?host=site${i}.example.org`)))
          .status,
      );
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });

  test("the real rate-limit rules put the checkers in their own strict bucket", () => {
    const rule = DEFAULT_RULES.find((r) => r.match("/tools/headers"))!;
    expect(rule.bucket).toBe("tools");
    expect(rule.max).toBe(10);
    expect(rule.windowMs).toBe(60_000);
  });
});
