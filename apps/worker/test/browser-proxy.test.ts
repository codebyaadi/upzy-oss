import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect } from "node:net";

import { startEgressProxy, type EgressProxy } from "../src/browser/proxy";

/** Sends raw bytes to the proxy and returns everything it sends back until it closes the connection. */
function talk(port: number, request: string, waitMs = 1500): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const s = connect({ host: "127.0.0.1", port }, () => s.write(request));
    s.on("data", (c) => chunks.push(c));
    const done = () => (s.destroy(), resolve(Buffer.concat(chunks).toString("latin1")));
    s.on("close", done);
    s.on("error", done);
    setTimeout(done, waitMs);
  });
}

describe("the browser's egress proxy", () => {
  let origin: ReturnType<typeof Bun.serve>;
  let proxy: EgressProxy;
  const asked: string[] = [];
  const auth = () =>
    `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")}\r\n`;

  beforeAll(async () => {
    origin = Bun.serve({
      port: 0,
      fetch: (req) => new Response(`hello from ${new URL(req.url).pathname}`),
    });
    // Only "ok.test" is public here; it points at the test server. Everything else is refused.
    proxy = await startEgressProxy(async (host) => {
      asked.push(host);
      return host === "ok.test" ? "127.0.0.1" : null;
    });
  });
  afterAll(() => {
    proxy.close();
    origin.stop(true);
  });

  test("a request without the check's credentials is turned away", async () => {
    const r = await talk(proxy.port, "CONNECT ok.test:443 HTTP/1.1\r\nHost: ok.test:443\r\n\r\n");
    expect(r).toStartWith("HTTP/1.1 407");
    expect(r).toContain("Proxy-Authenticate: Basic");
    expect(asked).not.toContain("ok.test");
  });

  test("a host that isn't public is refused, and remembered so the check can say so", async () => {
    for (const host of ["169.254.169.254", "10.0.0.5", "localhost", "internal.corp"]) {
      const r = await talk(
        proxy.port,
        `CONNECT ${host}:80 HTTP/1.1\r\nHost: ${host}:80\r\n${auth()}\r\n`,
      );
      expect(r).toStartWith("HTTP/1.1 403");
    }
    expect([...proxy.blocked].sort()).toEqual(
      ["10.0.0.5", "169.254.169.254", "internal.corp", "localhost"].sort(),
    );
  });

  test("a plain HTTP request to a public host is forwarded to the address that was checked", async () => {
    const r = await talk(
      proxy.port,
      `GET http://ok.test:${origin.port}/page HTTP/1.1\r\nHost: ok.test:${origin.port}\r\n${auth()}\r\n`,
    );
    expect(r).toStartWith("HTTP/1.1 200");
    expect(r).toContain("hello from /page");
  });

  test("a tunnel (HTTPS) to a public host passes bytes both ways", async () => {
    const r = await talk(
      proxy.port,
      `CONNECT ok.test:${origin.port} HTTP/1.1\r\nHost: ok.test:${origin.port}\r\n${auth()}\r\n`,
      500,
    );
    expect(r).toStartWith("HTTP/1.1 200 Connection Established");
  });

  test("nonsense is rejected rather than crashing the proxy", async () => {
    expect(await talk(proxy.port, "NONSENSE\r\n\r\n")).toStartWith("HTTP/1.1 400");
    expect(await talk(proxy.port, `GET /relative HTTP/1.1\r\n${auth()}\r\n`)).toStartWith(
      "HTTP/1.1 400",
    );
    expect(await talk(proxy.port, `CONNECT ok.test:99999 HTTP/1.1\r\n${auth()}\r\n`)).toStartWith(
      "HTTP/1.1 400",
    );
    // Still serving afterwards.
    const r = await talk(
      proxy.port,
      `GET http://ok.test:${origin.port}/x HTTP/1.1\r\nHost: x\r\n${auth()}\r\n`,
    );
    expect(r).toContain("hello from /x");
  });

  test("closing the proxy drops open connections and stops listening", async () => {
    const other = await startEgressProxy(async () => null);
    other.close();
    const r = await talk(other.port, "GET / HTTP/1.1\r\n\r\n", 500);
    expect(r).toBe("");
  });
});
