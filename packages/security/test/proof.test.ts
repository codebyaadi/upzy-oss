import { describe, expect, test } from "bun:test";

import { cookieShape, runChecks, type Deps, type Proof } from "../src";
import { headersCheck } from "../src/checks/headers";
import { tlsLegacyCheck } from "../src/checks/tls";
import { memoryCache } from "../src/vuln/http";

const page = (over: Partial<{ headers: Record<string, string>; setCookies: string[] }> = {}) => ({
  status: 200,
  headers: { server: "nginx", "content-type": "text/html", ...over.headers },
  setCookies: over.setCookies ?? [],
  finalUrl: "https://example.com/",
  body: "<html>secret page body</html>",
  ttfbMs: 1,
  totalMs: 1,
});

const deps = (over: Partial<Deps> = {}): Deps => ({
  fetch: async () => page(),
  resolveTxt: async () => [],
  resolveMx: async () => [],
  resolveCname: async () => [],
  resolveAddresses: async () => ["93.184.216.34"],
  resolveCaa: async () => [{}],
  tls: async () => {
    throw new Error("unused");
  },
  tlsLegacy: async () => false,
  tcpOpen: async () => false,
  grabBanner: async () => null,
  vuln: { http: async () => ({}), cache: memoryCache() },
  ...over,
});

const domain = { kind: "domain", value: "example.com" } as const;
const proofOf = (f: { evidence?: Record<string, unknown> }) => f.evidence?.proof as Proof;

describe("proof attached to findings", () => {
  test("a header finding carries the request, status and headers behind it, and no page content", async () => {
    const r = await runChecks(domain, { deps: deps(), checks: [headersCheck] });
    expect(r.findings.length).toBeGreaterThan(0);
    for (const f of r.findings) {
      const p = proofOf(f);
      expect(p.checkedAt).toBeTruthy();
      expect(p.requests?.[0]).toMatchObject({
        method: "GET",
        status: 200,
        headers: { server: "nginx", "content-type": "text/html" },
      });
    }
    expect(JSON.stringify(r.findings)).not.toContain("secret page body");
  });

  test("cookie values never reach the proof, only the name and attributes", async () => {
    expect(cookieShape("sid=SUPERSECRET; Path=/; Secure; HttpOnly; SameSite=Lax")).toBe(
      "sid; Secure; HttpOnly; SameSite=Lax",
    );
    const r = await runChecks(domain, {
      deps: deps({ fetch: async () => page({ setCookies: ["sid=SUPERSECRET; Path=/"] }) }),
      checks: [headersCheck],
    });
    expect(JSON.stringify(r.findings)).not.toContain("SUPERSECRET");
    expect(JSON.stringify(r.findings)).toContain('"sid"');
  });
});

describe("validate before reporting", () => {
  /** Accepts the old protocol on the first handshake only: a one-off, not a real exposure. */
  const flaky = () => {
    let calls = 0;
    return deps({ tlsLegacy: async (_h, v) => v === "TLSv1" && ++calls === 1 });
  };
  const options = { checks: [tlsLegacyCheck], recheckDelayMs: 0 };

  test("a new finding the second run does not see is dropped", async () => {
    const r = await runChecks(domain, { ...options, deps: flaky(), isNew: () => true });
    expect(r.findings).toEqual([]);
    expect(r.unconfirmed).toEqual(["tls.legacy_protocol_enabled"]);
    // The check itself ran fine, so the family can still resolve what it no longer sees.
    expect(r.outcomes.tls).toBe("ok");
  });

  test("a new finding the second run also sees is reported, marked confirmed", async () => {
    const r = await runChecks(domain, {
      ...options,
      deps: deps({ tlsLegacy: async (_h, v) => v === "TLSv1" }),
      isNew: () => true,
    });
    expect(r.findings).toHaveLength(1);
    expect(proofOf(r.findings[0]!).confirmedAt).toBeTruthy();
    expect(r.unconfirmed).toBeUndefined();
  });

  test("a finding that is already known is not re-run, so it only refreshes", async () => {
    let calls = 0;
    const d = deps({ tlsLegacy: async (_h, v) => (calls++, v === "TLSv1") });
    const r = await runChecks(domain, { ...options, deps: d, isNew: () => false });
    expect(r.findings).toHaveLength(1);
    expect(proofOf(r.findings[0]!).confirmedAt).toBeUndefined();
    expect(calls).toBe(2); // TLSv1 and TLSv1.1 once each
  });

  test("a second run that errors is not a confirmation", async () => {
    let n = 0;
    const d = deps({
      tlsLegacy: async (_h, v) => {
        if (++n > 2) throw new Error("timeout");
        return v === "TLSv1";
      },
    });
    const r = await runChecks(domain, { ...options, deps: d, isNew: () => true });
    expect(r.findings).toEqual([]);
    expect(r.unconfirmed).toEqual(["tls.legacy_protocol_enabled"]);
  });
});
