import { describe, expect, test } from "bun:test";

import {
  extractHosts,
  mergePageState,
  mxMatches,
  parsePolicy,
  runChecks,
  siteOf,
  type Deps,
  type PageState,
} from "../src";
import { mtaStsCheck } from "../src/checks/mta-sts";
import { pageChangeCheck } from "../src/checks/page-change";
import { memoryCache } from "../src/vuln/http";

const page = (body = "<html></html>", headers: Record<string, string> = {}) => ({
  status: 200,
  headers: { "content-type": "text/html; charset=utf-8", ...headers },
  setCookies: [],
  finalUrl: "https://example.com/",
  body,
  ttfbMs: 1,
  totalMs: 1,
});

const deps = (over: Partial<Deps> = {}): Deps => ({
  fetch: async () => page(),
  resolveTxt: async () => [],
  resolveMx: async () => [{ exchange: "mx1.mail.example.net", priority: 10 }],
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
const txt =
  (map: Record<string, string>): Deps["resolveTxt"] =>
  async (name) =>
    name in map ? [[map[name]!]] : [];
const policyOf = (lines: string[]) => async (url: string) =>
  url.includes("mta-sts.txt") ? page(lines.join("\n")) : page();
const keys = async (d: Deps) =>
  (await runChecks(domain, { deps: d, checks: [mtaStsCheck] })).findings
    .map((f) => f.checkKey)
    .sort();

describe("MTA-STS and TLS-RPT", () => {
  test("a domain with no mail is left alone", async () => {
    expect(await keys(deps({ resolveMx: async () => [] }))).toEqual([]);
    expect(await keys(deps({ resolveMx: async () => [{ exchange: "", priority: 0 }] }))).toEqual(
      [],
    );
  });

  test("mail but no policy is a low finding", async () => {
    expect(await keys(deps())).toEqual(["email.mta_sts_missing"]);
  });

  test("a good enforcing policy that covers the MX, with reports, is clean", async () => {
    const d = deps({
      resolveTxt: txt({
        "_mta-sts.example.com": "v=STSv1; id=20260101",
        "_smtp._tls.example.com": "v=TLSRPTv1; rua=mailto:r@example.com",
      }),
      fetch: policyOf([
        "version: STSv1",
        "mode: enforce",
        "mx: *.mail.example.net",
        "max_age: 86400",
      ]),
    });
    expect(await keys(d)).toEqual([]);
  });

  test("testing mode and missing reports are noted", async () => {
    const d = deps({
      resolveTxt: txt({ "_mta-sts.example.com": "v=STSv1; id=1" }),
      fetch: policyOf([
        "version: STSv1",
        "mode: testing",
        "mx: mx1.mail.example.net",
        "max_age: 600",
      ]),
    });
    expect(await keys(d)).toEqual(["email.mta_sts_not_enforced", "email.tls_rpt_missing"]);
  });

  test("an MX the policy does not cover is high when enforcing, because mail is being refused", async () => {
    const d = deps({
      resolveTxt: txt({
        "_mta-sts.example.com": "v=STSv1; id=1",
        "_smtp._tls.example.com": "v=TLSRPTv1; rua=mailto:r@example.com",
      }),
      fetch: policyOf(["version: STSv1", "mode: enforce", "mx: other.example.org", "max_age: 600"]),
    });
    const r = await runChecks(domain, { deps: d, checks: [mtaStsCheck] });
    expect(r.findings.map((f) => [f.checkKey, f.severity])).toEqual([
      ["email.mta_sts_mx_mismatch", "high"],
    ]);
  });

  test("a record without a usable policy is a medium finding with the reason", async () => {
    const records = txt({
      "_mta-sts.example.com": "v=STSv1; id=1",
      "_smtp._tls.example.com": "v=TLSRPTv1; rua=mailto:r@example.com",
    });
    const missing = deps({
      resolveTxt: records,
      fetch: async (u) => (u.includes("mta-sts.txt") ? { ...page(), status: 404 } : page()),
    });
    const r = await runChecks(domain, { deps: missing, checks: [mtaStsCheck] });
    expect(r.findings[0]!.checkKey).toBe("email.mta_sts_policy_invalid");
    expect(JSON.stringify(r.findings[0]!.evidence)).toContain("404");

    const unreachable = deps({
      resolveTxt: records,
      fetch: async (u) => {
        if (u.includes("mta-sts.txt")) throw new Error("Too many redirects (>0)");
        return page();
      },
    });
    expect(await keys(unreachable)).toEqual(["email.mta_sts_policy_invalid"]);
    // The policy is fetched without following redirects, as the standard requires.
    let redirects: number | undefined;
    await runChecks(domain, {
      deps: deps({
        resolveTxt: records,
        fetch: async (u, o) => {
          if (u.includes("mta-sts.txt")) redirects = o?.maxRedirects;
          return page();
        },
      }),
      checks: [mtaStsCheck],
    });
    expect(redirects).toBe(0);

    const noMode = deps({
      resolveTxt: records,
      fetch: policyOf(["version: STSv1", "mx: a.example.net", "max_age: 5"]),
    });
    expect(await keys(noMode)).toEqual(["email.mta_sts_policy_invalid"]);
  });

  test("policy parsing and the wildcard rule", () => {
    expect(
      parsePolicy(
        "version: STSv1\r\nmode: Enforce\r\nmx: A.Example.com\r\nmx: *.b.example.com\r\nmax_age: 604800\r\n",
      ),
    ).toEqual({
      version: "STSv1",
      mode: "enforce",
      mx: ["a.example.com", "*.b.example.com"],
      maxAge: 604800,
    });
    expect(mxMatches("*.example.com", "mail.example.com")).toBe(true);
    expect(mxMatches("*.example.com", "a.b.example.com")).toBe(false);
    expect(mxMatches("*.example.com", "example.com")).toBe(false);
    expect(mxMatches("mx.example.com", "MX.EXAMPLE.COM.")).toBe(true);
  });
});

describe("page state", () => {
  test("sites are told apart by their registrable part", () => {
    expect(siteOf("www.example.com")).toBe("example.com");
    expect(siteOf("a.b.example.co.uk")).toBe("example.co.uk");
    expect(siteOf("example.com")).toBe("example.com");
    expect(siteOf("203.0.113.5")).toBe("203.0.113.5");
  });

  test("only other sites' scripts, frames and form targets are collected", () => {
    const body = `
      <script src="/app.js"></script>
      <script src="https://static.example.com/x.js"></script>
      <script src='//cdn.thirdparty.net/lib.js'></script>
      <script src="https://Analytics.Vendor.io/a.js"></script>
      <script>inline()</script>
      <iframe src="https://player.video.com/embed/1"></iframe>
      <form action="https://pay.stripe.com/x"></form><form action="/login"></form>
      <script src="data:text/javascript,alert(1)"></script>`;
    expect(extractHosts(body, "https://www.example.com/", "www.example.com")).toEqual({
      scripts: ["analytics.vendor.io", "cdn.thirdparty.net"],
      frames: ["player.video.com"],
      forms: ["pay.stripe.com"],
    });
  });

  test("the first look is the baseline, later arrivals are dated after it", () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    const first = mergePageState(null, { scripts: ["cdn.a.net"], frames: [], forms: [] }, t0);
    expect(first.baselineAt).toBe(t0.toISOString());
    expect(first.scriptHosts["cdn.a.net"]).toBe("baseline");
    const later = mergePageState(
      first,
      { scripts: ["cdn.a.net", "evil.example.org"], frames: [], forms: [] },
      new Date("2026-01-08T00:00:00Z"),
    );
    expect(later.baselineAt).toBe(first.baselineAt);
    expect(later.scriptHosts["cdn.a.net"]).toBe("baseline");
    expect(later.scriptHosts["evil.example.org"]).toBe("2026-01-08T00:00:00.000Z");
  });
});

describe("page-change detection", () => {
  const withScripts = (...hosts: string[]) =>
    page(`<html>${hosts.map((h) => `<script src="https://${h}/x.js"></script>`).join("")}</html>`);
  const scan = (body: ReturnType<typeof page>, previousPage: PageState | null | undefined) =>
    runChecks(domain, {
      deps: deps({ fetch: async () => body }),
      checks: [pageChangeCheck],
      previousPage,
    });

  test("the first scan reports nothing, however many third parties the page already uses", async () => {
    const r = await scan(withScripts("cdn.a.net", "tags.b.io"), null);
    expect(r.findings).toEqual([]);
    expect(Object.keys(r.page!.scriptHosts).sort()).toEqual(["cdn.a.net", "tags.b.io"]);
  });

  test("a script that appears later is a finding, and stays one while it is on the page", async () => {
    const baseline = (await scan(withScripts("cdn.a.net"), null)).page!;
    const second = await scan(withScripts("cdn.a.net", "skimmer.evil.example"), baseline);
    expect(second.findings.map((f) => [f.checkKey, f.subject, f.severity])).toEqual([
      ["content.new_third_party_script", "skimmer.evil.example", "medium"],
    ]);
    // Next scan: no longer "new" compared with last time, but still not part of the baseline, so still reported.
    const third = await scan(withScripts("cdn.a.net", "skimmer.evil.example"), second.page);
    expect(third.findings).toHaveLength(1);
    // Removed from the page: nothing is reported, so the finding resolves with the family.
    const fixed = await scan(withScripts("cdn.a.net"), third.page);
    expect(fixed.findings).toEqual([]);
    expect(fixed.outcomes.content).toBe("ok");
  });

  test("a new form target and a new frame have their own findings", async () => {
    const baseline = (await scan(page("<html></html>"), null)).page!;
    const r = await scan(
      page(
        '<form action="https://collect.evil.example/p"></form><iframe src="https://ads.evil.example/f"></iframe>',
      ),
      baseline,
    );
    expect(r.findings.map((f) => f.checkKey).sort()).toEqual([
      "content.new_external_form_target",
      "content.new_third_party_frame",
    ]);
  });

  test("a page that is not HTML, or could not be read, has nothing to compare", async () => {
    const json = await scan(page('{"a":1}', { "content-type": "application/json" }), null);
    expect(json.page).toBeUndefined();
    expect(json.findings).toEqual([]);
    const down = await runChecks(domain, {
      deps: deps({ fetch: async () => ({ ...page(), status: 503 }) }),
      checks: [pageChangeCheck],
    });
    expect(down.page).toBeUndefined();
  });
});
