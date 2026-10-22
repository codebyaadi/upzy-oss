import { describe, expect, test } from "bun:test";

import {
  availabilityScore,
  computeHealth,
  describeStack,
  detectStack,
  fixFor,
  gradeOf,
  headersBundle,
  HEADER_SPECS,
  runChecks,
  UNKNOWN_STACK,
  type Stack,
} from "../src";

const stack = (over: Partial<Stack> = {}): Stack => ({ ...UNKNOWN_STACK, ...over });

describe("stack detection", () => {
  test("reads platform, server and framework from response headers", () => {
    expect(detectStack({ headers: { "cf-ray": "abc-LHR", server: "cloudflare" } })).toEqual(
      stack({ platform: "cloudflare" }),
    );
    expect(
      detectStack({ headers: { "x-vercel-id": "iad1::x", "x-powered-by": "Next.js" } }),
    ).toEqual(stack({ platform: "vercel", framework: "nextjs" }));
    expect(detectStack({ headers: { server: "nginx/1.25.3", "x-powered-by": "Express" } })).toEqual(
      stack({ server: "nginx", framework: "express" }),
    );
    expect(
      detectStack({ headers: { server: "Apache/2.4.58", "x-powered-by": "PHP/8.2" } }),
    ).toEqual(stack({ server: "apache", framework: "php" }));
    expect(detectStack({ headers: { "x-nf-request-id": "1" } }).platform).toBe("netlify");
    expect(detectStack({ headers: { "x-amz-cf-id": "1" } }).platform).toBe("cloudfront");
    expect(detectStack({ headers: { "x-github-request-id": "1" } }).platform).toBe("github-pages");
    expect(detectStack({ headers: {} })).toEqual(UNKNOWN_STACK);
  });

  test("is described in words, and a scan records it without an extra request", async () => {
    expect(
      describeStack(stack({ platform: "cloudflare", server: "nginx", framework: "nextjs" })),
    ).toBe("Cloudflare in front of nginx (Next.js)");
    expect(describeStack(UNKNOWN_STACK)).toBe("Unknown");

    let calls = 0;
    const res = {
      status: 200,
      headers: { server: "nginx" } as Record<string, string>,
      setCookies: [],
      finalUrl: "https://example.com/",
      body: "",
      ttfbMs: 1,
      totalMs: 1,
    };
    const { headersCheck } = await import("../src/checks/headers");
    const r = await runChecks(
      { kind: "url", value: "https://example.com/" },
      {
        checks: [headersCheck],
        deps: {
          fetch: async (u: string) => {
            if (u.startsWith("https:")) calls++;
            return res;
          },
        } as never,
      },
    );
    expect(r.stack?.server).toBe("nginx");
    expect(calls).toBe(1);
  });
});

describe("health score", () => {
  const open = (...sev: [string, "critical" | "high" | "medium" | "low" | "info"][]) =>
    sev.map(([checkKey, severity]) => ({ checkKey, severity }));

  test("a clean site is an A", () => {
    const h = computeHealth({ open: [], kind: "domain", uptime: 100 });
    expect(h.score).toBe(100);
    expect(h.grade).toBe("A");
    expect(h.categories).toEqual({ security: 100, hygiene: 100, email: 100, availability: 100 });
  });

  test("findings cost points in their own category, and categories are weighted", () => {
    const h = computeHealth({
      open: open(["headers.csp_missing", "medium"], ["email.dmarc_missing", "medium"]),
      kind: "domain",
      uptime: 100,
    });
    expect(h.categories.security).toBe(88);
    expect(h.categories.email).toBe(88);
    // The weighted average is 92, but an open medium finding keeps it out of the A range.
    expect(h.score).toBe(89);
    expect(h.grade).toBe("B");
    expect(h.cappedBy).toBe("medium");
    const lows = computeHealth({
      open: open(["headers.nosniff_missing", "low"]),
      kind: "domain",
      uptime: 100,
    });
    expect(lows.grade).toBe("A");
    expect(lows.cappedBy).toBeNull();
  });

  test("info findings are free; housekeeping goes to hygiene", () => {
    const h = computeHealth({
      open: open(["headers.referrer_policy_missing", "info"], ["dns.caa_missing", "low"]),
      kind: "domain",
    });
    expect(h.categories.security).toBe(100);
    expect(h.categories.hygiene).toBe(95);
    expect(h.categories.availability).toBeUndefined();
  });

  test("email trust only applies to domains", () => {
    expect(computeHealth({ open: [], kind: "subdomain" }).categories.email).toBeUndefined();
    expect(computeHealth({ open: [], kind: "url" }).categories.email).toBeUndefined();
  });

  test("an open critical or high finding caps the grade however good the rest is", () => {
    const crit = computeHealth({
      open: open(["takeover.dangling_cname", "critical"]),
      kind: "subdomain",
      uptime: 100,
    });
    expect(crit.score).toBeLessThanOrEqual(59);
    expect(crit.grade === "D" || crit.grade === "F").toBe(true);
    expect(crit.cappedBy).toBe("critical");
    const high = computeHealth({
      open: open(["tls.cert_untrusted", "high"]),
      kind: "url",
      uptime: 100,
    });
    expect(high.score).toBeLessThanOrEqual(79);
    expect(high.grade).not.toBe("A");
    expect(high.cappedBy).toBe("high");
  });

  test("uptime maps to a score and bad uptime pulls the grade down", () => {
    expect(availabilityScore(100)).toBe(100);
    expect(availabilityScore(99.95)).toBe(100);
    expect(availabilityScore(99.9)).toBe(95);
    expect(availabilityScore(99)).toBe(75);
    expect(availabilityScore(95)).toBe(40);
    expect(availabilityScore(80)).toBe(0);
    expect(computeHealth({ open: [], kind: "url", uptime: 90 }).grade).not.toBe("A");
    expect(gradeOf(90)).toBe("A");
    expect(gradeOf(89)).toBe("B");
    expect(gradeOf(49)).toBe("F");
  });
});

describe("fix for my stack", () => {
  const fix = (checkKey: string, s: Stack, evidence?: Record<string, unknown>) =>
    fixFor({ checkKey, stack: s, host: "www.acme.com", evidence });
  const code = (f: ReturnType<typeof fix>) => f!.snippets.map((s) => s.code).join("\n");

  test("a missing header gets the syntax of the platform it runs on", () => {
    const cf = fix("headers.hsts_missing", stack({ platform: "cloudflare" }))!;
    expect(cf.target).toBe("Cloudflare");
    expect(code(cf)).toContain("Strict-Transport-Security: max-age=31536000; includeSubDomains");

    expect(
      JSON.parse(fix("headers.nosniff_missing", stack({ platform: "vercel" }))!.snippets[0]!.code),
    ).toEqual({
      headers: [
        { source: "/(.*)", headers: [{ key: "X-Content-Type-Options", value: "nosniff" }] },
      ],
    });
    expect(code(fix("headers.hsts_missing", stack({ platform: "netlify" })))).toContain(
      "/*\n  Strict-Transport-Security:",
    );
    expect(code(fix("headers.hsts_missing", stack({ server: "nginx" })))).toContain(
      'add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;',
    );
    expect(code(fix("headers.hsts_missing", stack({ server: "apache" })))).toContain(
      "Header always set Strict-Transport-Security",
    );
    expect(code(fix("headers.hsts_missing", stack({ server: "caddy" })))).toContain("header {");
    expect(code(fix("headers.hsts_missing", stack({ framework: "nextjs" })))).toContain(
      "async headers()",
    );
    expect(code(fix("headers.hsts_missing", stack({ framework: "express" })))).toContain(
      "res.setHeader",
    );
  });

  test("an unknown stack shows the common servers, and a CDN also shows the origin's syntax", () => {
    const generic = fix("headers.csp_missing", UNKNOWN_STACK)!;
    expect(generic.snippets.map((s) => s.language)).toEqual(["nginx", "apache", "caddy"]);
    const both = fix("headers.hsts_missing", stack({ platform: "cloudflare", server: "nginx" }))!;
    expect(both.snippets.map((s) => s.language)).toEqual(["text", "nginx"]);
    expect(both.detected).toBe("Cloudflare in front of nginx");
  });

  test("CSP starts in report-only mode and says so", () => {
    const f = fix("headers.csp_missing", stack({ server: "nginx" }))!;
    expect(code(f)).toContain("Content-Security-Policy-Report-Only");
    expect(f.steps.join(" ")).toContain("report-only");
  });

  test("GitHub Pages can't set headers: it says so and points to a CDN", () => {
    const f = fix("headers.hsts_missing", stack({ platform: "github-pages" }))!;
    expect(f.steps[0]).toContain("doesn't let you set response headers");
    expect(f.snippets[0]!.label).toContain("Cloudflare");
  });

  test("DNS fixes are filled in with the domain, and every fix tells you to verify", () => {
    expect(code(fix("email.dmarc_missing", UNKNOWN_STACK))).toContain("_dmarc.acme.com.  TXT");
    expect(code(fix("dns.caa_missing", UNKNOWN_STACK))).toContain("acme.com.  CAA  0 issue");
    expect(code(fix("email.spf_missing", UNKNOWN_STACK))).toContain("v=spf1");
    for (const key of [
      "headers.hsts_missing",
      "headers.no_https_redirect",
      "tls.cert_expiring",
      "email.dmarc_missing",
      "takeover.dangling_cname",
    ])
      expect(fix(key, UNKNOWN_STACK)!.caveat).toContain("Verify fix");
  });

  test("redirect, TLS and cookie fixes depend on the stack", () => {
    expect(fix("headers.no_https_redirect", stack({ platform: "cloudflare" }))!.steps[0]).toContain(
      "Always Use HTTPS",
    );
    expect(code(fix("headers.no_https_redirect", stack({ server: "nginx" })))).toContain(
      "return 301",
    );
    expect(code(fix("tls.deprecated_protocol", stack({ server: "nginx" })))).toContain(
      "ssl_protocols TLSv1.2 TLSv1.3",
    );
    expect(fix("tls.cert_expiring", stack({ platform: "vercel" }))!.steps[0]).toContain(
      "renews certificates for you",
    );
    expect(code(fix("tls.cert_expiring", stack({ server: "nginx" })))).toContain("certbot");
    const cookie = fix("headers.cookie_flags", stack({ framework: "express" }), { cookie: "sid" })!;
    expect(cookie.steps[0]).toContain('"sid"');
    expect(code(cookie)).toContain("sameSite");
  });

  test("version disclosure uses the server's own setting", () => {
    expect(code(fix("headers.version_disclosed", stack({ server: "nginx" })))).toBe(
      "server_tokens off;",
    );
    expect(code(fix("headers.version_disclosed", stack({ framework: "express" })))).toContain(
      "x-powered-by",
    );
  });

  test("findings with no template return null so the built-in remediation is used", () => {
    expect(fix("cve.vulnerable_component", UNKNOWN_STACK)).toBeNull();
    expect(fix("nothing.here", UNKNOWN_STACK)).toBeNull();
  });

  test("all missing headers can be fixed with one snippet", () => {
    const keys = Object.keys(HEADER_SPECS);
    const f = headersBundle(stack({ server: "nginx" }), "acme.com", [
      ...keys,
      "headers.hsts_weak",
      "x.y",
    ])!;
    const lines = f.snippets[0]!.code.split("\n");
    // hsts_missing and hsts_weak are the same header: it appears once.
    expect(lines.filter((l) => l.includes("Strict-Transport-Security"))).toHaveLength(1);
    expect(lines).toHaveLength(new Set(Object.values(HEADER_SPECS).map((s) => s.name)).size);
    expect(headersBundle(UNKNOWN_STACK, "acme.com", ["tls.cert_expired"])).toBeNull();
  });
});
