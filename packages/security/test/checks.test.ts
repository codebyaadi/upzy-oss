import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";

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

/** A public key as it appears after p= in a DKIM record: base64 of the DER SubjectPublicKeyInfo. */
const rsaP = (bits: number) =>
  generateKeyPairSync("rsa", { modulusLength: bits })
    .publicKey.export({ type: "spki", format: "der" })
    .toString("base64");
const KEY_512 = rsaP(512);
const KEY_1024 = rsaP(1024);
const KEY_2048 = rsaP(2048);
const dkim = (p: string, extra = "") => `v=DKIM1; k=rsa; ${extra}p=${p}`;

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
    ).toEqual(["email.dkim_not_found", "email.dmarc_missing", "email.spf_missing"]));
  test("strict SPF + enforced DMARC is clean", async () =>
    expect(
      keys(
        await run({
          "example.com": ["v=spf1 include:_spf.x.com -all"],
          "_dmarc.example.com": ["v=DMARC1; p=reject; rua=mailto:dmarc@example.com"],
          "default._domainkey.example.com": [dkim(KEY_2048)],
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
  describe("DMARC details", () => {
    const base = { "example.com": ["v=spf1 -all"] };
    const only = async (map: Record<string, string[]>) =>
      (
        await run({ ...base, "default._domainkey.example.com": [dkim(KEY_2048)], ...map })
      ).findings.filter((f) => f.checkKey.startsWith("email.dmarc"));

    test("two DMARC records mean no DMARC applies, and nothing else is judged", async () => {
      const f = await only({
        "_dmarc.example.com": ["v=DMARC1; p=none", "v=DMARC1; p=reject; rua=mailto:a@example.com"],
      });
      expect(f.map((x) => x.checkKey)).toEqual(["email.dmarc_multiple"]);
      expect(f[0]!.severity).toBe("medium");
      expect(f[0]!.evidence).toMatchObject({ count: 2 });
    });
    test("a missing or unknown policy is invalid", async () => {
      for (const record of [
        "v=DMARC1; rua=mailto:a@example.com",
        "v=DMARC1; p=banana; rua=mailto:a@example.com",
      ]) {
        const f = await only({ "_dmarc.example.com": [record] });
        expect(f.map((x) => x.checkKey)).toEqual(["email.dmarc_invalid_policy"]);
        expect(f[0]!.severity).toBe("medium");
      }
    });
    test("p=none is monitor-only, not invalid", async () => {
      const f = await only({
        "_dmarc.example.com": ["v=DMARC1; p=none; rua=mailto:a@example.com"],
      });
      expect(f.map((x) => x.checkKey)).toEqual(["email.dmarc_monitor_only"]);
    });
    test("no rua=mailto: address means no reports", async () => {
      for (const record of [
        "v=DMARC1; p=reject",
        "v=DMARC1; p=reject; rua=https://example.com/r",
        "v=DMARC1; p=reject; ruf=mailto:a@example.com",
      ]) {
        const f = await only({ "_dmarc.example.com": [record] });
        expect(f.map((x) => x.checkKey)).toEqual(["email.dmarc_no_reports"]);
        expect(f[0]!.severity).toBe("low");
      }
      expect(
        await only({
          "_dmarc.example.com": [
            "v=DMARC1; p=reject; rua=mailto:a@example.com,mailto:b@example.com",
          ],
        }),
      ).toEqual([]);
    });
  });

  describe("DKIM", () => {
    const withDmarc: Record<string, string[]> = {
      "example.com": ["v=spf1 -all"],
      "_dmarc.example.com": ["v=DMARC1; p=reject; rua=mailto:a@example.com"],
    };
    const google = async () => [{ exchange: "aspmx.l.google.com", priority: 1 }];
    const microsoft = async () => [
      { exchange: "example-com.mail.protection.outlook.com", priority: 0 },
    ];
    const found = async (map: Record<string, string[]>, m = mx) =>
      (await run({ ...withDmarc, ...map }, m)).findings.filter((f) =>
        f.checkKey.startsWith("email.dkim"),
      );

    test("Google mail with no key is missing, naming the google selector", async () => {
      const f = await found({}, google);
      expect(f.map((x) => x.checkKey)).toEqual(["email.dkim_missing"]);
      expect(f[0]!.severity).toBe("low");
      expect(f[0]!.evidence).toMatchObject({ provider: "google", selectors: ["google"] });
    });
    test("googlemail.com MX counts as Google too", async () => {
      const f = await found({}, async () => [
        { exchange: "gmail-smtp-in.l.googlemail.com", priority: 5 },
      ]);
      expect(f[0]!.evidence).toMatchObject({ provider: "google" });
    });
    test("Microsoft 365 mail with no key is missing, naming both selectors", async () => {
      const f = await found({}, microsoft);
      expect(f.map((x) => x.checkKey)).toEqual(["email.dkim_missing"]);
      expect(f[0]!.evidence).toMatchObject({
        provider: "microsoft",
        selectors: ["selector1", "selector2"],
      });
    });
    test("a key at the provider's selector is clean", async () => {
      expect(await found({ "google._domainkey.example.com": [dkim(KEY_2048)] }, google)).toEqual(
        [],
      );
      expect(
        await found({ "selector1._domainkey.example.com": [dkim(KEY_2048)] }, microsoft),
      ).toEqual([]);
    });
    test("an unknown provider with no key is information only, so no health penalty", async () => {
      const f = await found({});
      expect(f.map((x) => x.checkKey)).toEqual(["email.dkim_not_found"]);
      expect(f[0]!.severity).toBe("info");
      expect(f[0]!.description).toContain("may use one Upzy can't see");
    });
    test("a revoked key (empty p=) is not a key", async () => {
      const f = await found({ "default._domainkey.example.com": ["v=DKIM1; k=rsa; p="] });
      expect(f.map((x) => x.checkKey)).toEqual(["email.dkim_not_found"]);
      expect(f[0]!.evidence).toMatchObject({ revoked: ["default"] });
    });
    test("RSA key size: under 1024 is medium, 1024 is low, 2048 is fine", async () => {
      const f = await found({
        "s1._domainkey.example.com": [dkim(KEY_512)],
        "s2._domainkey.example.com": [dkim(KEY_1024)],
        "default._domainkey.example.com": [dkim(KEY_2048)],
      });
      const weak = f.filter((x) => x.checkKey === "email.dkim_weak_key");
      expect(
        weak.map((x) => [x.subject, x.severity, (x.evidence as { bits: number }).bits]),
      ).toEqual([
        ["s1", "medium", 512],
        ["s2", "low", 1024],
      ]);
      expect(f.map((x) => x.checkKey)).not.toContain("email.dkim_not_found");
    });
    test("a key split over several TXT strings is joined before it is read", async () => {
      const full = dkim(KEY_1024);
      const cut = Math.floor(full.length / 2);
      const r = await runChecks(domain, {
        deps: deps({
          resolveMx: mx,
          resolveTxt: async (h) =>
            h === "default._domainkey.example.com"
              ? [[full.slice(0, cut), full.slice(cut)]]
              : (withDmarc[h]?.map((t) => [t]) ?? []),
        }),
      });
      const weak = r.findings.find((f) => f.checkKey === "email.dkim_weak_key");
      expect((weak?.evidence as { bits: number }).bits).toBe(1024);
    });
    test("t=y marks a key as testing", async () => {
      const f = await found({ "default._domainkey.example.com": [dkim(KEY_2048, "t=y; ")] });
      expect(f.map((x) => [x.checkKey, x.subject, x.severity])).toEqual([
        ["email.dkim_testing", "default", "low"],
      ]);
    });
    test("an ed25519 key is fine and is not size-checked", async () => {
      const raw = generateKeyPairSync("ed25519")
        .publicKey.export({ type: "spki", format: "der" })
        .subarray(-32)
        .toString("base64");
      expect(
        await found({ "default._domainkey.example.com": [`v=DKIM1; k=ed25519; p=${raw}`] }),
      ).toEqual([]);
    });
    test("a lookup that fails is not reported as a missing key", async () => {
      const r = await runChecks(domain, {
        deps: deps({
          resolveMx: google,
          resolveTxt: async (h) => {
            if (h.endsWith("_domainkey.example.com")) throw new Error("SERVFAIL");
            return withDmarc[h]?.map((t) => [t]) ?? [];
          },
        }),
      });
      expect(keys(r).filter((k) => k.startsWith("email.dkim"))).toEqual([]);
    });
  });

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
