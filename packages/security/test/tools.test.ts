import { describe, expect, test } from "bun:test";

import { BlockedTargetError } from "@upzy/probes";

import {
  ToolInputError,
  ToolUnreachableError,
  isToolId,
  memoryCache,
  normalizeHost,
  runTool,
  scoreOf,
  type Deps,
  type TlsInfo,
} from "../src";

const res = (headers: Record<string, string> = {}) => ({
  status: 200,
  headers,
  setCookies: [] as string[],
  finalUrl: "https://example.com/",
  body: "",
  ttfbMs: 1,
  totalMs: 1,
});
const goodTls: TlsInfo = {
  protocol: "TLSv1.3",
  authorized: true,
  authorizationError: null,
  validTo: new Date(Date.now() + 90 * 86_400_000),
  keyBits: 2048,
  keyType: "RSA",
};
const deps = (over: Partial<Deps> = {}): Deps => ({
  fetch: async () => res(),
  resolveTxt: async () => [],
  resolveMx: async () => [],
  resolveCname: async () => [],
  resolveAddresses: async () => ["93.184.216.34"],
  resolveCaa: async () => [],
  tls: async () => goodTls,
  tlsLegacy: async () => false,
  tcpOpen: async () => false,
  grabBanner: async () => null,
  vuln: { http: async () => ({}), cache: memoryCache() },
  ...over,
});
const HARDENED = {
  "strict-transport-security": "max-age=31536000",
  "content-security-policy": "default-src 'self'; frame-ancestors 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=()",
};

describe("normalizeHost", () => {
  test("accepts a domain however it was pasted", () => {
    expect(normalizeHost("example.com")).toBe("example.com");
    expect(normalizeHost("  Example.COM ")).toBe("example.com");
    expect(normalizeHost("https://www.Example.com/path?x=1#frag")).toBe("www.example.com");
    expect(normalizeHost("example.com:8443")).toBe("example.com");
    expect(normalizeHost("user:pw@example.com")).toBe("example.com");
    expect(normalizeHost("example.com.")).toBe("example.com");
    expect(normalizeHost("sub.domain.example.co.uk")).toBe("sub.domain.example.co.uk");
  });

  test("refuses what isn't a public domain name", () => {
    for (const bad of [
      "",
      "   ",
      "localhost",
      "intranet",
      "127.0.0.1",
      "10.0.0.5",
      "192.168.1.1",
      "[::1]",
      "::1",
      "http://169.254.169.254/latest",
      "foo.local",
      "foo.internal",
      "foo.test",
      "a b.com",
      "exa_mple.com",
      "-bad.com",
      "bad-.com",
      "x".repeat(64) + ".com",
      "a.".repeat(130) + "com",
      "example.123",
      "file:///etc/passwd",
    ])
      expect(() => normalizeHost(bad), bad).toThrow(ToolInputError);
  });
});

describe("scoring", () => {
  test("no findings is 100, and severities cap the score like a monitored site's grade", () => {
    expect(scoreOf([])).toBe(100);
    expect(scoreOf([{ severity: "info" }])).toBe(100);
    expect(scoreOf([{ severity: "low" }])).toBe(95);
    expect(scoreOf([{ severity: "medium" }])).toBe(88);
    expect(scoreOf([{ severity: "high" }])).toBe(75);
    expect(scoreOf([{ severity: "critical" }])).toBe(59);
    expect(scoreOf(Array(10).fill({ severity: "critical" }))).toBe(0);
  });
});

describe("tool ids", () => {
  test("only the known tools are accepted", () => {
    expect(["headers", "ssl", "email"].every(isToolId)).toBe(true);
    expect(isToolId("ports")).toBe(false);
    expect(isToolId("__proto__")).toBe(false);
  });
});

describe("headers tool", () => {
  test("a hardened site gets an A and lists the headers it found", async () => {
    const r = await runTool("headers", "example.com", {
      deps: deps({ fetch: async () => res(HARDENED) }),
    });
    expect(r.grade).toBe("A");
    expect(r.findings).toEqual([]);
    expect(r.facts.find((f) => f.label === "Strict-Transport-Security")?.value).toBe(
      "max-age=31536000",
    );
    expect(r.host).toBe("example.com");
  });

  test("a bare site is graded down, worst first, with a fix for each finding where we have one", async () => {
    const r = await runTool("headers", "https://Example.com/x", { deps: deps() });
    expect(r.host).toBe("example.com");
    expect(["C", "D", "F", "B"]).toContain(r.grade);
    expect(r.findings.length).toBeGreaterThan(2);
    const sev = r.findings.map((f) => f.severity);
    const rank = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const;
    expect(sev.map((s) => rank[s])).toEqual([...sev.map((s) => rank[s])].sort((a, b) => a - b));
    const hsts = r.findings.find((f) => f.checkKey === "headers.hsts_missing")!;
    expect(hsts.remediation).toContain("Strict-Transport-Security");
    expect(hsts.fix?.snippets.length).toBeGreaterThan(0);
    expect(r.facts.find((f) => f.label === "Content-Security-Policy")?.value).toBeNull();
  });

  test("only header findings come back, never another family's", async () => {
    const r = await runTool("headers", "example.com", { deps: deps() });
    expect(r.findings.every((f) => f.checkKey.startsWith("headers."))).toBe(true);
  });

  test("a site that can't be loaded is reported plainly, not as a clean bill of health", async () => {
    await expect(
      runTool("headers", "example.com", {
        deps: deps({
          fetch: async () => {
            throw new Error("connect ECONNREFUSED");
          },
        }),
      }),
    ).rejects.toThrow(ToolUnreachableError);
  });

  test("a private address is refused with a message that doesn't leak the network", async () => {
    const err = (await runTool("headers", "example.com", {
      deps: deps({
        fetch: async () => {
          throw new BlockedTargetError("example.com resolves to 10.0.0.1");
        },
      }),
    }).catch((e) => e as Error)) as Error;
    expect(err).toBeInstanceOf(ToolUnreachableError);
    expect(err.message).toBe("That address isn't publicly reachable, so it can't be checked.");
    expect(err.message).not.toContain("10.0.0.1");
  });
});

describe("ssl tool", () => {
  test("a healthy certificate is an A with its details", async () => {
    const r = await runTool("ssl", "example.com", { deps: deps() });
    expect(r.grade).toBe("A");
    expect(r.facts.find((f) => f.label === "Protocol")?.value).toBe("TLSv1.3");
    expect(r.facts.find((f) => f.label === "Trusted by browsers")?.value).toBe("Yes");
    expect(r.facts.find((f) => f.label === "Expires")?.value).toMatch(/in \d+ days/);
  });

  test("an expired certificate is critical and caps the grade", async () => {
    const r = await runTool("ssl", "example.com", {
      deps: deps({
        tls: async () => ({
          ...goodTls,
          authorized: false,
          authorizationError: "CERT_HAS_EXPIRED",
          validTo: new Date(Date.now() - 3 * 86_400_000),
        }),
      }),
    });
    expect(r.findings.map((f) => f.checkKey)).toContain("tls.cert_expired");
    expect(["D", "F"]).toContain(r.grade);
    expect(r.facts.find((f) => f.label === "Expires")?.value).toMatch(/days ago/);
  });

  test("nothing on 443 is a finding, but a timeout is reported as unreachable", async () => {
    const refused = await runTool("ssl", "example.com", {
      deps: deps({
        tls: async () => {
          throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
        },
      }),
    });
    expect(refused.findings.map((f) => f.checkKey)).toEqual(["tls.not_available"]);

    await expect(
      runTool("ssl", "example.com", {
        deps: deps({
          tls: async () => {
            throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
          },
        }),
      }),
    ).rejects.toThrow(/secure connection/);
  });
});

describe("email tool", () => {
  const mx = async () => [{ exchange: "mx.example.com", priority: 10 }];

  test("SPF and DMARC in place is an A and shows both records", async () => {
    const r = await runTool("email", "example.com", {
      deps: deps({
        resolveMx: mx,
        resolveTxt: async (h) =>
          h.startsWith("_dmarc.")
            ? [["v=DMARC1; p=reject; rua=mailto:d@example.com"]]
            : [["v=spf1 include:_spf.google.com -all"]],
      }),
    });
    expect(r.grade).toBe("A");
    expect(r.facts.find((f) => f.label === "SPF")?.value).toContain("v=spf1");
    expect(r.facts.find((f) => f.label === "DMARC")?.value).toContain("p=reject");
  });

  test("a domain that takes mail with no SPF or DMARC is told how to fix it", async () => {
    const r = await runTool("email", "example.com", { deps: deps({ resolveMx: mx }) });
    const keys = r.findings.map((f) => f.checkKey);
    expect(keys).toContain("email.spf_missing");
    expect(r.grade).not.toBe("A");
    expect(r.facts.find((f) => f.label === "SPF")?.value).toBeNull();
    expect(r.findings.every((f) => f.remediation.length > 10)).toBe(true);
  });

  test("a domain that doesn't receive mail has nothing to report", async () => {
    const r = await runTool("email", "example.com", { deps: deps() });
    expect(r.findings).toEqual([]);
  });
});

describe("result shape", () => {
  test("carries when it was checked, and nothing about the caller", async () => {
    const r = await runTool("ssl", "example.com", {
      deps: deps(),
      now: () => new Date("2026-11-01T10:00:00Z"),
    });
    expect(r.checkedAt).toBe("2026-11-01T10:00:00.000Z");
    expect(Object.keys(r).sort()).toEqual(
      ["checkedAt", "detected", "facts", "findings", "grade", "host", "score", "tool"].sort(),
    );
  });
});
