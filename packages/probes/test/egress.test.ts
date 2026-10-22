import { describe, expect, test } from "bun:test";

import { BlockedTargetError, isBlockedIp, resolvePublic, safeFetch } from "../src/egress";
import { runProbe } from "../src/probes";

describe("isBlockedIp", () => {
  const blocked = [
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "127.255.255.254",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "::ffff:169.254.169.254",
    "64:ff9b::7f00:1",
    "2002:7f00:1::1",
    "not-an-ip",
    "",
  ];
  for (const ip of blocked)
    test(`blocks ${JSON.stringify(ip)}`, () => expect(isBlockedIp(ip)).toBe(true));

  const allowed = [
    "1.1.1.1",
    "8.8.8.8",
    "93.184.216.34",
    "172.32.0.1",
    "100.63.255.255",
    "2606:4700:4700::1111",
    "::ffff:8.8.8.8",
  ];
  for (const ip of allowed) test(`allows ${ip}`, () => expect(isBlockedIp(ip)).toBe(false));
});

describe("resolvePublic", () => {
  for (const host of ["localhost", "foo.localhost", "127.0.0.1", "[::1]", "169.254.169.254"]) {
    test(`rejects ${host}`, async () => {
      await expect(resolvePublic(host)).rejects.toBeInstanceOf(BlockedTargetError);
    });
  }
});

describe("safeFetch", () => {
  test("refuses a local server even though it is reachable", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("secret") });
    try {
      await expect(safeFetch(`http://127.0.0.1:${server.port}/`)).rejects.toBeInstanceOf(
        BlockedTargetError,
      );
    } finally {
      server.stop(true);
    }
  });

  test("rejects non-http schemes", async () => {
    await expect(safeFetch("file:///etc/passwd")).rejects.toBeInstanceOf(BlockedTargetError);
  });
});

describe("runProbe", () => {
  test("reports blocked targets as down/blocked without throwing", async () => {
    const r = await runProbe({
      type: "http",
      target: "http://169.254.169.254/latest/meta-data",
      config: {},
    });
    expect(r.status).toBe("down");
    expect(r.errorKind).toBe("blocked");
  });

  test("tcp probe to a private address is blocked", async () => {
    const r = await runProbe({ type: "tcp", target: "127.0.0.1:5432", config: {} });
    expect(r.errorKind).toBe("blocked");
  });
});
