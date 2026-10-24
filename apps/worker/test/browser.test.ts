import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";

import type { BrowserStep } from "@upzy/validator";

import { runBrowserCheck } from "../src/browser/run";

// These drive a real browser, so they run only when a Playwright server is available:
//   BROWSER_TEST_ENDPOINT=ws://127.0.0.1:3999/token bun test test/browser.test.ts
// For the container, add BROWSER_TEST_PROXY_HOST=host.docker.internal.
// (start one with chromium.launchServer from playwright-core, or the browser container).
const endpoint = process.env.BROWSER_TEST_ENDPOINT;
const run = endpoint ? describe : describe.skip;
// A failing step waits up to 10 seconds before it gives up.
setDefaultTimeout(40_000);

const LOGIN = `<!doctype html><title>Sign in</title>
<form onsubmit="return false">
  <input id="email" type="email"><input id="password" type="password">
  <button id="go" type="button" onclick="
    if (document.getElementById('password').value === 's3cret') location.href = '/dashboard';
    else document.getElementById('err').textContent = 'Wrong password';">Sign in</button>
  <p id="err"></p>
</form>`;

run("browser monitors (real browser)", () => {
  let server: ReturnType<typeof Bun.serve>;
  let base = "";
  const seen: string[] = [];

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const { pathname } = new URL(req.url);
        seen.push(pathname);
        if (pathname === "/login")
          return new Response(LOGIN, { headers: { "content-type": "text/html" } });
        if (pathname === "/dashboard")
          return new Response("<!doctype html><h1>Welcome back</h1>", {
            headers: { "content-type": "text/html" },
          });
        if (pathname === "/down") return new Response("down", { status: 503 });
        if (pathname === "/to-loopback")
          return new Response(null, {
            status: 302,
            headers: { location: "http://localhost:3000/" },
          });
        if (pathname === "/to-private")
          return new Response(null, {
            status: 302,
            headers: { location: "http://10.255.255.1/secret" },
          });
        return new Response("<!doctype html><h1>Home</h1>", {
          headers: { "content-type": "text/html" },
        });
      },
    });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => server.stop(true));

  const check = (
    path: string,
    steps: BrowserStep[],
    over: Partial<Parameters<typeof runBrowserCheck>[0]> = {},
  ) =>
    runBrowserCheck({
      target: base + path,
      steps,
      endpoint: endpoint!,
      // When the browser runs in a container, how it reaches this machine (host.docker.internal).
      proxyHost: process.env.BROWSER_TEST_PROXY_HOST,
      // The test server is on loopback, which the real guard refuses; everything else stays refused.
      resolveHost: async (h) => (h === "127.0.0.1" ? "127.0.0.1" : null),
      ...over,
    });

  test("a login that works passes", async () => {
    const r = await check(
      "/login",
      [
        { do: "fill", selector: "#email", value: "monitor@example.com" },
        { do: "fill", selector: "#password", value: "{{secret.PW}}" },
        { do: "click", selector: "#go" },
        { do: "expect_url", contains: "/dashboard" },
        { do: "expect_text", text: "Welcome back", selector: "h1" },
      ],
      { secrets: { PW: "s3cret" } },
    );
    expect(r).toMatchObject({ status: "up", statusCode: 200 });
    expect(r.responseMs).toBeGreaterThan(0);
  });

  test("a wrong password fails on the step that expected the dashboard, and the secret never appears", async () => {
    const r = await check(
      "/login",
      [
        { do: "fill", selector: "#password", value: "{{secret.PW}}" },
        { do: "click", selector: "#go" },
        { do: "expect_url", contains: "/dashboard" },
      ],
      { secrets: { PW: "wrong-password-value" } },
    );
    expect(r.status).toBe("down");
    expect(r.errorKind).toBe("assertion");
    expect(r.error).toContain("Step 3");
    expect(r.error).toContain("expect the address to contain");
    expect(r.error).not.toContain("wrong-password-value");
  });

  test("text that never appears is reported with the text", async () => {
    const r = await check("/", [{ do: "expect_text", text: "Add to cart" }]);
    expect(r).toMatchObject({ status: "down", errorKind: "assertion" });
    expect(r.error).toContain('"Add to cart"');
  });

  test("an element that is missing times out on its step", async () => {
    const r = await check("/", [{ do: "click", selector: "#nope" }]);
    expect(r).toMatchObject({ status: "down", errorKind: "timeout" });
    expect(r.error).toContain("Step 1");
  }, 30_000);

  test("an error page fails the check before any step", async () => {
    const r = await check("/down", [{ do: "expect_text", text: "anything" }]);
    expect(r).toMatchObject({ status: "down", errorKind: "http", statusCode: 503 });
    expect(r.error).toContain("HTTP 503");
    expect(r.error).toContain("Opening the page");
  });

  test("a secret that was never set is a clear error, not an empty field", async () => {
    const r = await check("/login", [
      { do: "fill", selector: "#email", value: "{{secret.MISSING}}" },
    ]);
    expect(r.status).toBe("down");
    expect(r.error).toContain("{{secret.MISSING}}");
  });

  test("a page can't send the browser to a private address", async () => {
    const r = await check("/to-private", []);
    expect(r).toMatchObject({ status: "down", errorKind: "blocked" });
    expect(r.error).toContain("10.255.255.1");
  });

  test("nor to the browser's own loopback, which browsers normally reach without a proxy", async () => {
    const r = await check("/to-loopback", []);
    expect(r).toMatchObject({ status: "down", errorKind: "blocked" });
    expect(r.error).toContain("localhost");
  });

  test("with the real guard, a loopback target is refused outright", async () => {
    const before = seen.length;
    const r = await runBrowserCheck({
      target: base + "/",
      steps: [],
      endpoint: endpoint!,
      proxyHost: process.env.BROWSER_TEST_PROXY_HOST,
    });
    expect(r).toMatchObject({ status: "down", errorKind: "blocked" });
    expect(seen.length).toBe(before);
  });

  test("the browser server being unreachable is reported, not thrown", async () => {
    const r = await runBrowserCheck({
      target: base + "/",
      steps: [],
      endpoint: "ws://127.0.0.1:1/none",
      resolveHost: async () => "127.0.0.1",
    });
    expect(r.status).toBe("down");
    expect(r.error).toBeTruthy();
  }, 30_000);
});
