import { describe, expect, test } from "bun:test";

import { BlockedTargetError } from "@upzy/probes";

import {
  memoryCache,
  fingerprint,
  parentDomains,
  riskScore,
  runChecks,
  verifyOwnership,
  type Deps,
  type TlsInfo,
} from "../src";

const okRes = (over: Partial<Awaited<ReturnType<Deps["fetch"]>>> = {}) => ({
  status: 200,
  headers: {} as Record<string, string>,
  setCookies: [] as string[],
  finalUrl: "https://example.com/",
  body: "",
  ttfbMs: 1,
  totalMs: 1,
  ...over,
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
  fetch: async () => okRes(),
  resolveTxt: async () => [],
  resolveMx: async () => [],
  resolveCname: async () => [],
  resolveAddresses: async () => ["93.184.216.34"],
  resolveCaa: async () => [{}],
  tls: async () => goodTls,
  tlsLegacy: async () => false,
  tcpOpen: async () => false,
  grabBanner: async () => null,
  vuln: { http: async () => ({}), cache: memoryCache() },
  ...over,
});

const keys = (r: { findings: { checkKey: string }[] }) => r.findings.map((f) => f.checkKey).sort();
const domain = { kind: "domain", value: "example.com" } as const;

describe("headers", () => {
  const hardened = {
    "strict-transport-security": "max-age=31536000",
    "content-security-policy": "default-src 'self'; frame-ancestors 'self'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=()",
  };

  test("a hardened site has no header findings", async () => {
    const r = await runChecks(domain, {
      deps: deps({
        fetch: async (u) =>
          u.startsWith("http:")
            ? okRes({ finalUrl: "https://example.com/" })
            : okRes({ headers: hardened }),
      }),
    });
    expect(keys(r).filter((k) => k.startsWith("headers."))).toEqual([]);
    expect(r.outcomes.headers).toBe("ok");
  });

  test("a bare response reports the missing headers", async () => {
    const r = await runChecks(domain, { deps: deps() });
    expect(keys(r)).toEqual(
      expect.arrayContaining([
        "headers.hsts_missing",
        "headers.csp_missing",
        "headers.clickjacking_missing",
        "headers.nosniff_missing",
      ]),
    );
  });

  test("short HSTS max-age is flagged as weak, not missing", async () => {
    const r = await runChecks(domain, {
      deps: deps({
        fetch: async () =>
          okRes({ headers: { ...hardened, "strict-transport-security": "max-age=300" } }),
      }),
    });
    expect(keys(r)).toContain("headers.hsts_weak");
    expect(keys(r)).not.toContain("headers.hsts_missing");
  });

  test("cookie findings name the cookie but never include its value", async () => {
    const r = await runChecks(domain, {
      deps: deps({
        fetch: async () =>
          okRes({
            headers: hardened,
            setCookies: ["sid=SECRETVALUE; Path=/", "ok=1; Secure; HttpOnly; SameSite=Lax"],
          }),
      }),
    });
    const cookie = r.findings.filter((f) => f.checkKey === "headers.cookie_flags");
    expect(cookie).toHaveLength(1);
    expect(cookie[0]!.subject).toBe("sid");
    expect(JSON.stringify(cookie[0])).not.toContain("SECRETVALUE");
  });

  test("version banners and mixed content are reported", async () => {
    const r = await runChecks(domain, {
      deps: deps({
        fetch: async () =>
          okRes({
            headers: { ...hardened, server: "nginx/1.18.0" },
            body: '<script src="http://cdn.example/x.js"></script>',
          }),
      }),
    });
    expect(keys(r)).toEqual(
      expect.arrayContaining(["headers.version_disclosed", "headers.mixed_content"]),
    );
  });

  test("missing HTTP->HTTPS redirect is flagged", async () => {
    const r = await runChecks(domain, {
      deps: deps({ fetch: async (u) => okRes({ headers: hardened, finalUrl: u }) }),
    });
    expect(keys(r)).toContain("headers.no_https_redirect");
  });

  test("an unreachable site is an error outcome, not a clean result", async () => {
    const r = await runChecks(domain, {
      deps: deps({ fetch: async () => Promise.reject(new Error("ECONNRESET")) }),
    });
    expect(r.outcomes.headers).toBe("error");
    expect(r.errors.headers).toContain("ECONNRESET");
    expect(r.outcomes.tls).toBe("ok"); // other checks still ran
  });
});

describe("tls", () => {
  const run = (tls: Deps["tls"]) => runChecks(domain, { deps: deps({ tls }) });

  test("healthy certificate", async () =>
    expect(keys(await run(async () => goodTls)).filter((k) => k.startsWith("tls."))).toEqual([]));
  test("expired", async () =>
    expect(
      keys(
        await run(async () => ({
          ...goodTls,
          validTo: new Date(Date.now() - 5 * 86_400_000),
          authorized: false,
          authorizationError: "CERT_HAS_EXPIRED",
        })),
      ),
    ).toEqual(expect.arrayContaining(["tls.cert_expired"])));
  test("expired is not double reported as untrusted", async () =>
    expect(
      keys(
        await run(async () => ({
          ...goodTls,
          validTo: new Date(Date.now() - 86_400_000),
          authorized: false,
          authorizationError: "CERT_HAS_EXPIRED",
        })),
      ),
    ).not.toContain("tls.cert_untrusted"));
  test("expiring soon", async () =>
    expect(
      keys(
        await run(async () => ({ ...goodTls, validTo: new Date(Date.now() + 10 * 86_400_000) })),
      ),
    ).toContain("tls.cert_expiring"));
  test("hostname mismatch", async () =>
    expect(
      keys(
        await run(async () => ({
          ...goodTls,
          authorized: false,
          authorizationError: "ERR_TLS_CERT_ALTNAME_INVALID",
        })),
      ),
    ).toContain("tls.cert_untrusted"));
  test("weak RSA key", async () =>
    expect(keys(await run(async () => ({ ...goodTls, keyBits: 1024 })))).toContain("tls.weak_key"));
  test("port 443 closed is a finding", async () =>
    expect(
      keys(
        await run(async () =>
          Promise.reject(Object.assign(new Error("refused"), { code: "ECONNREFUSED" })),
        ),
      ),
    ).toContain("tls.not_available"));
  test("a timeout is inconclusive (error outcome)", async () => {
    const r = await run(async () =>
      Promise.reject(Object.assign(new Error("t"), { code: "ETIMEDOUT" })),
    );
    expect(r.outcomes.tls).toBe("error");
    expect(keys(r)).not.toContain("tls.not_available");
  });
});

describe("email auth", () => {
  const mx = async () => [{ exchange: "mx.example.com", priority: 10 }];
  const txt = (map: Record<string, string[]>) => async (h: string) =>
    (map[h] ?? []).map((t) => [t]);
  const run = (map: Record<string, string[]>, m = mx) =>
    runChecks(domain, { deps: deps({ resolveMx: m, resolveTxt: txt(map) }) });

  test("domains that cannot receive mail are skipped", async () =>
    expect(
      keys(await run({}, async () => [])).filter(
        (k) => k.startsWith("email.") && !/mta_sts|tls_rpt/.test(k),
      ),
    ).toEqual([]));
  test("no SPF, no DMARC", async () =>
    expect(
      keys(await run({})).filter((k) => k.startsWith("email.") && !/mta_sts|tls_rpt/.test(k)),
    ).toEqual(["email.dmarc_missing", "email.spf_missing"]));
  test("strict SPF + enforced DMARC is clean", async () =>
    expect(
      keys(
        await run({
          "example.com": ["v=spf1 include:_spf.x.com -all"],
          "_dmarc.example.com": ["v=DMARC1; p=reject"],
        }),
      ).filter((k) => k.startsWith("email.") && !/mta_sts|tls_rpt/.test(k)),
    ).toEqual([]));
  test("+all SPF is high severity", async () => {
    const r = await run({
      "example.com": ["v=spf1 +all"],
      "_dmarc.example.com": ["v=DMARC1; p=reject"],
    });
    expect(r.findings.find((f) => f.checkKey === "email.spf_permissive")?.severity).toBe("high");
  });
  test("two SPF records are invalid", async () =>
    expect(
      keys(
        await run({
          "example.com": ["v=spf1 -all", "v=spf1 ~all"],
          "_dmarc.example.com": ["v=DMARC1; p=reject"],
        }),
      ),
    ).toContain("email.spf_multiple"));
  test("DMARC p=none is monitor-only", async () =>
    expect(
      keys(
        await run({ "example.com": ["v=spf1 -all"], "_dmarc.example.com": ["v=DMARC1; p=none"] }),
      ),
    ).toContain("email.dmarc_monitor_only"));
  test("not run for subdomains", async () => {
    const r = await runChecks(
      { kind: "subdomain", value: "app.example.com" },
      { deps: deps({ resolveMx: mx }) },
    );
    expect(r.outcomes.email).toBe("skipped");
  });
});

describe("dns", () => {
  test("missing CAA is informational", async () => {
    const r = await runChecks(domain, { deps: deps({ resolveCaa: async () => [] }) });
    expect(r.findings.find((f) => f.checkKey === "dns.caa_missing")?.severity).toBe("info");
  });

  test("dangling CNAME", async () => {
    const r = await runChecks(
      { kind: "subdomain", value: "old.example.com" },
      {
        deps: deps({
          resolveCname: async () => ["gone.example.net"],
          resolveAddresses: async () => [],
        }),
      },
    );
    expect(keys(r)).toContain("takeover.dangling_cname");
  });

  test("CNAME to a provider that serves the unclaimed fingerprint is critical", async () => {
    const r = await runChecks(
      { kind: "subdomain", value: "docs.example.com" },
      {
        deps: deps({
          resolveCname: async () => ["acme.github.io"],
          fetch: async () => okRes({ body: "<h1>There isn't a GitHub Pages site here.</h1>" }),
        }),
      },
    );
    const f = r.findings.find((x) => x.checkKey === "takeover.vulnerable_service");
    expect(f?.severity).toBe("critical");
    expect(f?.subject).toBe("GitHub Pages");
  });

  test("a working provider CNAME is not flagged", async () => {
    const r = await runChecks(
      { kind: "subdomain", value: "docs.example.com" },
      {
        deps: deps({
          resolveCname: async () => ["acme.github.io"],
          fetch: async () => okRes({ body: "Welcome" }),
        }),
      },
    );
    expect(keys(r).filter((k) => k.startsWith("takeover."))).toEqual([]);
  });

  test("SSRF-blocked target surfaces as an error outcome", async () => {
    const r = await runChecks(
      { kind: "subdomain", value: "x.example.com" },
      {
        deps: deps({
          resolveCname: async () => ["a.github.io"],
          fetch: async () => Promise.reject(new BlockedTargetError("private")),
        }),
      },
    );
    expect(r.outcomes.takeover).toBe("error");
  });
});

test("url assets are checked on their own URL and host", async () => {
  const seen: string[] = [];
  const r = await runChecks(
    { kind: "url", value: "https://shop.example.com/app" },
    { deps: deps({ fetch: async (u) => (seen.push(u), okRes()) }) },
  );
  expect(seen[0]).toBe("https://shop.example.com/app");
  expect(r.outcomes.email).toBe("skipped");
  expect(r.outcomes.takeover).toBe("skipped");
});

describe("fingerprint / score", () => {
  test("same issue on the same asset hashes identically; subject and asset change it", () => {
    const a = fingerprint("asset1", { checkKey: "headers.cookie_flags", subject: "sid" });
    expect(fingerprint("asset1", { checkKey: "headers.cookie_flags", subject: "sid" })).toBe(a);
    expect(fingerprint("asset1", { checkKey: "headers.cookie_flags", subject: "other" })).not.toBe(
      a,
    );
    expect(fingerprint("asset2", { checkKey: "headers.cookie_flags", subject: "sid" })).not.toBe(a);
  });
  test("risk score orders by severity and rewards KEV/EPSS", () => {
    expect(riskScore("critical")).toBeGreaterThan(riskScore("high"));
    expect(riskScore("medium", { kev: true })).toBeGreaterThan(riskScore("medium"));
    expect(riskScore("critical", { kev: true, epss: 1 })).toBe(100);
  });
});

describe("ownership verification", () => {
  const token = "abc123";
  test("DNS TXT on the host", async () => {
    const r = await verifyOwnership(domain, token, {
      resolveTxt: async (h) => (h === "example.com" ? [["upzy-verify=abc123"]] : []),
      fetch: async () => Promise.reject(new Error("no")),
    });
    expect(r).toEqual({ verified: true, method: "dns" });
  });
  test("DNS TXT on _upzy.<host>", async () => {
    const r = await verifyOwnership(domain, token, {
      resolveTxt: async (h) => (h === "_upzy.example.com" ? [["upzy-verify=abc123"]] : []),
      fetch: async () => Promise.reject(new Error("no")),
    });
    expect(r.method).toBe("dns");
  });
  test("well-known file", async () => {
    const r = await verifyOwnership(domain, token, {
      resolveTxt: async () => [],
      fetch: async (u) =>
        u.endsWith("/.well-known/upzy-verify.txt")
          ? okRes({ body: "abc123\n" })
          : Promise.reject(new Error("no")),
    });
    expect(r).toEqual({ verified: true, method: "file" });
  });
  test("wrong token, wrong status or no proof fails", async () => {
    expect(
      (
        await verifyOwnership(domain, token, {
          resolveTxt: async () => [["upzy-verify=other"]],
          fetch: async () => okRes({ body: "other" }),
        })
      ).verified,
    ).toBe(false);
    expect(
      (
        await verifyOwnership(domain, token, {
          resolveTxt: async () => [],
          fetch: async () => okRes({ status: 404, body: "abc123" }),
        })
      ).verified,
    ).toBe(false);
  });
  test("parentDomains lists ancestors, excluding the TLD", () => {
    expect(parentDomains("a.b.example.com")).toEqual(["b.example.com", "example.com"]);
    expect(parentDomains("example.com")).toEqual([]);
  });
});
