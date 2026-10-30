import { describe, expect, test } from "bun:test";

import {
  assessComponents,
  detectComponents,
  memoryCache,
  runChecks,
  riskScore,
  type Deps,
  type VulnDeps,
} from "../src";
import { compareVersions, queryNvd, queryOsv } from "../src/vuln";
import { clip } from "../src/vuln/http";

const res = (headers: Record<string, string> = {}, body = "") => ({ headers, body });
const names = (r: { headers: Record<string, string>; body: string }) =>
  detectComponents(r)
    .map((c) => `${c.product}@${c.version}`)
    .sort();

describe("detectComponents", () => {
  test("server and X-Powered-By versions", () => {
    expect(names(res({ server: "nginx/1.18.0 (Ubuntu)", "x-powered-by": "PHP/7.4.3" }))).toEqual([
      "nginx@1.18.0",
      "php@7.4.3",
    ]);
    expect(names(res({ server: "Apache/2.4.41 (Ubuntu) OpenSSL/1.1.1f mod_ssl/2.4.41" }))).toEqual(
      ["apache@2.4.41", "openssl@1.1.1f"].map((s) => s.replace("apache", "http_server")).sort(),
    );
  });

  test("a header without a version is ignored rather than guessed", () => {
    expect(names(res({ server: "nginx", "x-powered-by": "Express" }))).toEqual([]);
    expect(names(res({ server: "cloudflare" }))).toEqual([]);
  });

  test("unknown products are ignored", () => {
    expect(names(res({ server: "MyCustomServer/9.9.9" }))).toEqual([]);
  });

  test("WordPress and Drupal from the generator tag, but not a bare major version", () => {
    expect(names(res({}, '<meta name="generator" content="WordPress 5.8.1" />'))).toEqual([
      "wordpress@5.8.1",
    ]);
    expect(
      names(res({}, '<meta content="Drupal 7.50 (https://www.drupal.org)" name="generator" />')),
    ).toEqual(["drupal@7.50"]);
    expect(
      names(res({}, '<meta name="generator" content="Drupal 9 (https://www.drupal.org)" />')),
    ).toEqual([]);
  });

  test("front-end libraries from script URLs in the common naming schemes", () => {
    const body = `
      <script src="/static/jquery-3.4.1.min.js"></script>
      <script src="https://cdnjs.cloudflare.com/ajax/libs/bootstrap/3.3.7/js/bootstrap.min.js"></script>
      <script src="https://cdn.jsdelivr.net/npm/lodash@4.17.15/lodash.min.js"></script>
      <script src="https://unpkg.com/vue@2.5.0/dist/vue.js"></script>`;
    expect(names(res({}, body))).toEqual([
      "bootstrap@3.3.7",
      "jquery@3.4.1",
      "lodash@4.17.15",
      "vue@2.5.0",
    ]);
  });

  test("does not mistake unrelated scripts or inline text for libraries", () => {
    expect(
      names(
        res(
          {},
          '<script src="/app.js"></script><p>we love jquery-3.4.1.min.js</p><script src="/jquery-ui-1.12.1.js"></script>',
        ),
      ),
    ).toEqual([]);
  });

  test("the same component seen twice is reported once", () => {
    expect(
      names(
        res(
          { server: "nginx/1.18.0" },
          '<script src="/a/jquery-3.4.1.js"></script><script src="/b/jquery-3.4.1.min.js"></script>',
        ),
      ),
    ).toEqual(["jquery@3.4.1", "nginx@1.18.0"]);
  });

  test("builds a version-pinned CPE and escapes odd characters", () => {
    const c = detectComponents(res({ server: "nginx/1.18.0" }))[0]!;
    expect(c.lookup).toEqual({ kind: "nvd", cpe: "cpe:2.3:a:f5:nginx:1.18.0:*:*:*:*:*:*:*" });
  });
});

describe("versions", () => {
  test("compareVersions orders dotted versions numerically", () => {
    expect(compareVersions("3.5.0", "3.4.1")).toBe(1);
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("2.0", "2.0.0")).toBe(0);
    expect(compareVersions("1.2.3", "1.2.4")).toBe(-1);
  });
});

/** A scripted HTTP layer: routes are matched by URL substring and the calls are recorded. */
const scripted = (routes: Record<string, unknown>) => {
  const calls: string[] = [];
  const deps: VulnDeps = {
    cache: memoryCache(),
    sleep: async () => {},
    http: async (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      const key = Object.keys(routes).find((k) => url.includes(k));
      if (!key) throw new Error(`unexpected request ${url}`);
      const v = routes[key];
      if (v instanceof Error) throw v;
      return typeof v === "function" ? (v as (u: string) => unknown)(url) : v;
    },
  };
  return { deps, calls };
};

const osvJquery = {
  vulns: [
    {
      id: "GHSA-gxr4-xjj5-5px2",
      aliases: ["CVE-2020-11022"],
      summary: "XSS in jQuery",
      database_specific: { severity: "MODERATE" },
      affected: [
        { ranges: [{ type: "SEMVER", events: [{ introduced: "1.2.0" }, { fixed: "3.5.0" }] }] },
      ],
    },
    {
      id: "GHSA-jpcq-cgw6-v4j6",
      aliases: ["CVE-2020-11023"],
      summary: "More XSS",
      database_specific: { severity: "MODERATE" },
      affected: [
        { ranges: [{ type: "SEMVER", events: [{ introduced: "1.0.3" }, { fixed: "3.5.0" }] }] },
      ],
    },
  ],
};

const nvdPage = (cves: object[], total = cves.length) => ({
  totalResults: total,
  vulnerabilities: cves.map((cve) => ({ cve })),
});
const nvdCve = (id: string, sev: string, score: number, extra: object = {}) => ({
  id,
  descriptions: [{ lang: "en", value: `desc ${id}` }],
  metrics: { cvssMetricV31: [{ cvssData: { baseScore: score, baseSeverity: sev } }] },
  ...extra,
});

describe("OSV", () => {
  test("maps advisories to CVEs, severity and the fix version, and caches", async () => {
    const { deps, calls } = scripted({ "osv.dev": osvJquery });
    const a = await queryOsv(deps, { ecosystem: "npm", name: "jquery" }, "3.4.1");
    expect(a).toEqual([
      {
        id: "CVE-2020-11022",
        cve: "CVE-2020-11022",
        summary: "XSS in jQuery",
        severity: "medium",
        cvss: null,
        fixedIn: "3.5.0",
      },
      {
        id: "CVE-2020-11023",
        cve: "CVE-2020-11023",
        summary: "More XSS",
        severity: "medium",
        cvss: null,
        fixedIn: "3.5.0",
      },
    ]);
    await queryOsv(deps, { ecosystem: "npm", name: "jquery" }, "3.4.1");
    expect(calls).toHaveLength(1);
  });

  test("a fix at or below the current version is not offered as an upgrade target", async () => {
    const { deps } = scripted({
      "osv.dev": {
        vulns: [
          {
            id: "GHSA-x",
            affected: [{ ranges: [{ events: [{ fixed: "3.0.0" }, { fixed: "4.1.0" }] }] }],
          },
        ],
      },
    });
    expect((await queryOsv(deps, { ecosystem: "npm", name: "x" }, "3.5.0"))[0]!.fixedIn).toBe(
      "4.1.0",
    );
  });

  test("an advisory with no CVE alias keeps its own id", async () => {
    const { deps } = scripted({
      "osv.dev": { vulns: [{ id: "GHSA-aaaa-bbbb-cccc", summary: "s" }] },
    });
    expect((await queryOsv(deps, { ecosystem: "npm", name: "x" }, "1.0.0"))[0]).toMatchObject({
      id: "GHSA-aaaa-bbbb-cccc",
      cve: null,
    });
  });

  test("follows pagination", async () => {
    let n = 0;
    const { deps } = scripted({
      "osv.dev": () =>
        n++ === 0
          ? { vulns: [{ id: "CVE-2020-0001" }], next_page_token: "t" }
          : { vulns: [{ id: "CVE-2020-0002" }] },
    });
    expect(
      (await queryOsv(deps, { ecosystem: "npm", name: "x" }, "1.0.0")).map((v) => v.id),
    ).toEqual(["CVE-2020-0001", "CVE-2020-0002"]);
  });
});

describe("NVD", () => {
  test("maps CVSS (newest scheme first), skips rejected CVEs, and paginates", async () => {
    const pages = [
      nvdPage(
        [
          nvdCve("CVE-2021-0001", "HIGH", 7.5),
          nvdCve("CVE-2021-0002", "LOW", 2, { vulnStatus: "Rejected" }),
        ],
        3,
      ),
      nvdPage(
        [
          {
            id: "CVE-2021-0003",
            descriptions: [],
            metrics: { cvssMetricV2: [{ baseSeverity: "MEDIUM", cvssData: { baseScore: 5 } }] },
          },
        ],
        3,
      ),
    ];
    let i = 0;
    const { deps, calls } = scripted({ "nvd.nist.gov": () => pages[i++] });
    const out = await queryNvd(deps, "cpe:2.3:a:f5:nginx:1.18.0:*:*:*:*:*:*:*");
    expect(out.map((v) => [v.id, v.severity, v.cvss])).toEqual([
      ["CVE-2021-0001", "high", 7.5],
      ["CVE-2021-0003", "medium", 5],
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("startIndex=0");
    expect(calls[1]).toContain("startIndex=2");
  });

  test("requests are paced so the unauthenticated rate limit is respected", async () => {
    const sleeps: number[] = [];
    const { deps } = scripted({ "nvd.nist.gov": nvdPage([]) });
    deps.sleep = async (ms) => void sleeps.push(ms);
    await queryNvd(deps, "cpe:2.3:a:a:b:1:*:*:*:*:*:*:*");
    await queryNvd(deps, "cpe:2.3:a:a:b:2:*:*:*:*:*:*:*");
    await Bun.sleep(5);
    expect(sleeps.every((ms) => ms >= 6000)).toBe(true);
    expect(sleeps.length).toBeGreaterThanOrEqual(1);
    const keyed = {
      ...deps,
      nvdApiKey: "k",
      cache: memoryCache(),
      sleep: async (ms: number) => void sleeps.push(ms),
    };
    sleeps.length = 0;
    await queryNvd(keyed, "cpe:2.3:a:a:b:3:*:*:*:*:*:*:*");
    await Bun.sleep(5);
    expect(sleeps.at(-1)).toBeLessThan(1000);
  });
});

describe("assessComponents", () => {
  const nginx = detectComponents(res({ server: "nginx/1.18.0" }));
  const kev = { vulnerabilities: [{ cveID: "CVE-2021-0001" }] };
  const epss = {
    data: [
      { cve: "CVE-2021-0001", epss: "0.5" },
      { cve: "CVE-2021-0002", epss: "0.01" },
    ],
  };
  const nvd = nvdPage([
    nvdCve("CVE-2021-0002", "CRITICAL", 9.8),
    nvdCve("CVE-2021-0001", "MEDIUM", 5.3),
    nvdCve("CVE-2021-0003", "LOW", 3.1),
  ]);

  test("ranks known-exploited first, adds EPSS, and raises severity for KEV", async () => {
    const { deps } = scripted({ "nvd.nist.gov": nvd, "cisa.gov": kev, "first.org": epss });
    const [a] = await assessComponents(deps, nginx);
    expect(a!.vulns.map((v) => v.id)).toEqual(["CVE-2021-0001", "CVE-2021-0002", "CVE-2021-0003"]);
    expect(a!.vulns[0]).toMatchObject({ kev: true, epss: 0.5 });
    expect(a!.vulns[2]).toMatchObject({ kev: false, epss: null });
    expect(a!.severity).toBe("critical"); // worst CVSS
  });

  test("a KEV entry lifts an otherwise medium component to high", async () => {
    const { deps } = scripted({
      "nvd.nist.gov": nvdPage([nvdCve("CVE-2021-0001", "MEDIUM", 5.3)]),
      "cisa.gov": kev,
      "first.org": epss,
    });
    expect((await assessComponents(deps, nginx))[0]!.severity).toBe("high");
  });

  test("components with no vulnerabilities produce nothing and skip KEV/EPSS lookups", async () => {
    const { deps, calls } = scripted({ "nvd.nist.gov": nvdPage([]) });
    expect(await assessComponents(deps, nginx)).toEqual([]);
    expect(calls.some((c) => c.includes("cisa") || c.includes("first.org"))).toBe(false);
  });

  test("KEV or EPSS outages only drop the enrichment, not the finding", async () => {
    const { deps } = scripted({
      "nvd.nist.gov": nvd,
      "cisa.gov": new Error("HTTP 503"),
      "first.org": new Error("HTTP 500"),
    });
    const [a] = await assessComponents(deps, nginx);
    expect(a!.vulns).toHaveLength(3);
    expect(a!.vulns.every((v) => !v.kev && v.epss === null)).toBe(true);
  });

  test("a failed vulnerability lookup throws, so it can never look like 'no vulnerabilities'", async () => {
    const { deps } = scripted({ "nvd.nist.gov": new Error("HTTP 403 from services.nvd.nist.gov") });
    await expect(assessComponents(deps, nginx)).rejects.toThrow("HTTP 403");
  });

  test("EPSS is fetched in batches of 100 and cached per CVE", async () => {
    const many = nvdPage(
      Array.from({ length: 150 }, (_, i) =>
        nvdCve(`CVE-2020-${String(i).padStart(4, "0")}`, "LOW", 1),
      ),
    );
    const { deps, calls } = scripted({
      "nvd.nist.gov": many,
      "cisa.gov": kev,
      "first.org": { data: [] },
    });
    await assessComponents(deps, nginx);
    expect(calls.filter((c) => c.includes("first.org"))).toHaveLength(2);
  });
});

describe("cve check", () => {
  const page = (headers: Record<string, string>, body = "") => ({
    status: 200,
    headers,
    setCookies: [],
    finalUrl: "https://example.com/",
    body,
    ttfbMs: 1,
    totalMs: 1,
  });
  const baseDeps = (fetchPage: ReturnType<typeof page>, vuln: VulnDeps): Deps => ({
    fetch: async () => fetchPage,
    resolveTxt: async () => [],
    resolveMx: async () => [],
    resolveCname: async () => [],
    resolveAddresses: async () => ["1.2.3.4"],
    resolveCaa: async () => [{}],
    tlsLegacy: async () => false,
    tcpOpen: async () => false,
    grabBanner: async () => null,
    tls: async () => ({
      protocol: "TLSv1.3",
      authorized: true,
      authorizationError: null,
      validTo: new Date(Date.now() + 90 * 86_400_000),
      keyBits: 2048,
      keyType: "RSA",
    }),
    vuln,
  });
  const only = (deps: Deps) =>
    runChecks({ kind: "domain", value: "example.com" }, { deps, checks: undefined }).then((r) => r);

  test("reports one finding per vulnerable component with ranked evidence and a risk boost", async () => {
    const { deps: vuln } = scripted({
      "api.osv.dev": osvJquery,
      "nvd.nist.gov": nvdPage([nvdCve("CVE-2021-0001", "MEDIUM", 5.3)]),
      "cisa.gov": { vulnerabilities: [{ cveID: "CVE-2021-0001" }] },
      "first.org": {
        data: [
          { cve: "CVE-2021-0001", epss: "0.9" },
          { cve: "CVE-2020-11022", epss: "0.2" },
        ],
      },
    });
    const r = await only(
      baseDeps(
        page({ server: "nginx/1.18.0" }, '<script src="/jquery-3.4.1.min.js"></script>'),
        vuln,
      ),
    );
    const cve = r.findings.filter((f) => f.checkKey === "cve.vulnerable_component");
    expect(r.outcomes.cve).toBe("ok");
    expect(cve.map((f) => f.subject).sort()).toEqual(["jquery@3.4.1", "nginx@1.18.0"]);

    const ngx = cve.find((f) => f.subject === "nginx@1.18.0")!;
    expect(ngx.severity).toBe("high");
    expect(ngx.title).toContain("1 exploited in the wild");
    expect(ngx.description).toContain("backport");
    expect(ngx.risk).toEqual({ kev: true, epss: 0.9 });
    expect(riskScore(ngx.severity, ngx.risk)).toBeGreaterThan(riskScore(ngx.severity));

    const jq = cve.find((f) => f.subject === "jquery@3.4.1")!;
    expect(jq.remediation).toContain("3.5.0");
    expect((jq.evidence as { cves: unknown[] }).cves).toHaveLength(2);
  });

  test("evidence lists at most 10 CVEs but still reports the total", async () => {
    const { deps: vuln } = scripted({
      "nvd.nist.gov": nvdPage(
        Array.from({ length: 25 }, (_, i) => nvdCve(`CVE-2019-${1000 + i}`, "LOW", 2)),
      ),
      "cisa.gov": { vulnerabilities: [{ cveID: "CVE-0-0" }] },
      "first.org": { data: [] },
    });
    const r = await only(baseDeps(page({ server: "nginx/1.18.0" }), vuln));
    const f = r.findings.find((x) => x.checkKey === "cve.vulnerable_component")!;
    expect((f.evidence as { cves: unknown[]; total: number }).cves).toHaveLength(10);
    expect((f.evidence as { total: number }).total).toBe(25);
  });

  test("no detectable versions means no findings and no lookups", async () => {
    const { deps: vuln, calls } = scripted({});
    const r = await only(baseDeps(page({ server: "nginx" }), vuln));
    expect(r.findings.filter((f) => f.checkKey.startsWith("cve."))).toEqual([]);
    expect(r.outcomes.cve).toBe("ok");
    expect(calls).toHaveLength(0);
  });

  test("a lookup failure marks the family as errored so its findings are not auto-resolved", async () => {
    const { deps: vuln } = scripted({
      "nvd.nist.gov": new Error("HTTP 429 from services.nvd.nist.gov"),
    });
    const r = await only(baseDeps(page({ server: "nginx/1.18.0" }), vuln));
    expect(r.outcomes.cve).toBe("error");
    expect(r.errors.cve).toContain("429");
    expect(r.outcomes.tls).toBe("ok");
  });

  test("the page is fetched once and shared between the header and CVE checks", async () => {
    const urls: string[] = [];
    const { deps: vuln } = scripted({});
    const d = baseDeps(page({ server: "nginx" }), vuln);
    d.fetch = async (u) => (urls.push(u), page({ server: "nginx" }));
    await runChecks({ kind: "url", value: "https://example.com/app" }, { deps: d });
    expect(urls.filter((u) => u === "https://example.com/app")).toHaveLength(1);
  });
});

test("clip shortens at a word boundary with an ellipsis and leaves short text alone", () => {
  expect(clip("short  text")).toBe("short text");
  const long = "word ".repeat(100);
  const out = clip(long, 50);
  expect(out.length).toBeLessThanOrEqual(51);
  expect(out.endsWith("…")).toBe(true);
  expect(out.slice(0, -1).endsWith("word")).toBe(true);
});
