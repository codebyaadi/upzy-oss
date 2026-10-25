import { describe, expect, test } from "bun:test";

import { runChecks } from "../src";
import { exposedPathsCheck, portsCheck } from "../src/checks/active";
import { registrationCheck, dnssecCheck } from "../src/checks/registration";
import { reputationCheck } from "../src/checks/reputation";
import { tlsLegacyCheck } from "../src/checks/tls";
import { ALL_CHECKS, PASSIVE_CHECKS } from "../src/run";
import type { Deps, TlsInfo } from "../src/types";
import { memoryCache } from "../src/vuln/http";

const res = (body = "", status = 200, headers: Record<string, string> = {}) => ({
  status,
  headers,
  setCookies: [],
  finalUrl: "https://example.com/",
  body,
  ttfbMs: 1,
  totalMs: 1,
});

const tls: TlsInfo = {
  protocol: "TLSv1.3",
  authorized: true,
  authorizationError: null,
  validTo: new Date(Date.now() + 90 * 86_400_000),
  keyBits: 2048,
  keyType: "RSA",
};

const deps = (over: Partial<Deps> = {}): Deps => ({
  fetch: async () => res("<html></html>"),
  resolveTxt: async () => [],
  resolveMx: async () => [],
  resolveCname: async () => [],
  resolveAddresses: async () => ["93.184.216.34"],
  resolveCaa: async () => [{}],
  tls: async () => tls,
  tlsLegacy: async () => false,
  tcpOpen: async () => false,
  vuln: { http: async () => ({}), cache: memoryCache() },
  ...over,
});

const domain = { kind: "domain", value: "example.com" } as const;
const only = (check: (typeof PASSIVE_CHECKS)[number], d: Deps, verified = true) =>
  runChecks(domain, { deps: d, checks: [check], verified });
const keys = (r: { findings: { checkKey: string }[] }) => r.findings.map((f) => f.checkKey);
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const rdap = (days: number | null, status: string[] = ["active"]) =>
  JSON.stringify({
    status,
    events: days === null ? [] : [{ eventAction: "expiration", eventDate: inDays(days) }],
  });

describe("registration (RDAP)", () => {
  const withRdap = (body: string, status = 200) =>
    deps({ fetch: async (u) => (u.includes("rdap.org") ? res(body, status) : res()) });

  test("a registration with plenty of time left has no finding", async () => {
    const r = await only(registrationCheck, withRdap(rdap(200)));
    expect(r.findings).toEqual([]);
    expect(r.outcomes.registration).toBe("ok");
  });

  test("expiry within a month is reported, and gets more severe as it nears", async () => {
    for (const [days, severity] of [
      [25, "medium"],
      [10, "high"],
      [-3, "critical"],
    ] as const) {
      const r = await only(registrationCheck, withRdap(rdap(days)));
      expect(keys(r)).toEqual(["registration.expiring"]);
      expect(r.findings[0]!.severity).toBe(severity);
    }
  });

  test("a redemption period is critical, whatever the date says", async () => {
    const r = await only(registrationCheck, withRdap(rdap(200, ["redemption period"])));
    expect(keys(r)).toEqual(["registration.lapsed"]);
    expect(r.findings[0]!.severity).toBe("critical");
  });

  test("a registry without RDAP (404) is not a finding or an error", async () => {
    const r = await only(registrationCheck, withRdap("not found", 404));
    expect(r.findings).toEqual([]);
    expect(r.outcomes.registration).toBe("ok");
  });

  test("a failing lookup is an error, so old findings are not wrongly resolved", async () => {
    expect((await only(registrationCheck, withRdap("busy", 429))).outcomes.registration).toBe(
      "error",
    );
    expect((await only(registrationCheck, withRdap("<html>"))).outcomes.registration).toBe("error");
  });

  test("it only looks at registrable domains, not subdomains", async () => {
    const r = await runChecks(
      { kind: "subdomain", value: "app.example.com" },
      { deps: deps(), checks: [registrationCheck] },
    );
    expect(r.outcomes.registration).toBe("skipped");
  });
});

describe("DNSSEC", () => {
  const doh = (answers: { ds?: boolean; checked?: number; unchecked?: number }) =>
    deps({
      fetch: async (u) => {
        const url = new URL(u);
        const type = url.searchParams.get("type");
        if (type === "DS")
          return res(
            JSON.stringify({ Status: 0, ...(answers.ds ? { Answer: [{ type: 43 }] } : {}) }),
          );
        const cd = url.searchParams.get("cd") === "1";
        return res(
          JSON.stringify({ Status: cd ? (answers.unchecked ?? 0) : (answers.checked ?? 0) }),
        );
      },
    });

  test("an unsigned domain gets a low-key note", async () => {
    const r = await only(dnssecCheck, doh({ ds: false }));
    expect(keys(r)).toEqual(["dnssec.not_enabled"]);
    expect(r.findings[0]!.severity).toBe("info");
  });

  test("a signed domain that resolves is fine", async () => {
    expect((await only(dnssecCheck, doh({ ds: true }))).findings).toEqual([]);
  });

  test("signed, but a validating resolver fails while a non-validating one answers, is broken", async () => {
    const r = await only(dnssecCheck, doh({ ds: true, checked: 2, unchecked: 0 }));
    expect(keys(r)).toEqual(["dnssec.validation_failed"]);
  });

  test("a domain that is down for every resolver is not blamed on DNSSEC", async () => {
    expect((await only(dnssecCheck, doh({ ds: true, checked: 2, unchecked: 2 }))).findings).toEqual(
      [],
    );
  });

  test("an unreadable answer is an error", async () => {
    const r = await only(dnssecCheck, deps({ fetch: async () => res("oops") }));
    expect(r.outcomes.dnssec).toBe("error");
  });
});

describe("Safe Browsing", () => {
  const key = "AIza-secret-key";
  const answer =
    (body: object, status = 200) =>
    async (_u: string) =>
      res(JSON.stringify(body), status);

  test("does nothing without a key", async () => {
    let called = false;
    const r = await only(
      reputationCheck,
      deps({
        fetch: async (u) => {
          if (u.includes("safebrowsing")) called = true;
          return res();
        },
      }),
    );
    expect(called).toBe(false);
    expect(r.findings).toEqual([]);
  });

  test("a flagged site is critical, one finding per kind of threat", async () => {
    const r = await only(
      reputationCheck,
      deps({
        safeBrowsingKey: key,
        fetch: answer({ matches: [{ threatType: "MALWARE" }, { threatType: "MALWARE" }] }),
      }),
    );
    expect(keys(r)).toEqual(["reputation.flagged_unsafe"]);
    expect(r.findings[0]!.severity).toBe("critical");
    expect(JSON.stringify(r.findings)).not.toContain(key);
  });

  test("a clean site has no finding", async () => {
    const r = await only(reputationCheck, deps({ safeBrowsingKey: key, fetch: answer({}) }));
    expect(r.findings).toEqual([]);
    expect(r.outcomes.reputation).toBe("ok");
  });

  test("an API error is an error outcome that never repeats the key", async () => {
    const r = await only(
      reputationCheck,
      deps({ safeBrowsingKey: key, fetch: answer({ error: key }, 403) }),
    );
    expect(r.outcomes.reputation).toBe("error");
    expect(JSON.stringify(r.errors)).not.toContain(key);
  });
});

describe("legacy TLS protocols", () => {
  test("accepting TLS 1.0 or 1.1 is a medium finding naming what is accepted", async () => {
    const r = await only(tlsLegacyCheck, deps({ tlsLegacy: async (_h, v) => v === "TLSv1" }));
    expect(keys(r)).toEqual(["tls.legacy_protocol_enabled"]);
    expect(r.findings[0]!.evidence).toMatchObject({ protocols: ["TLSv1"] });
  });

  test("a server that refuses both is clean", async () => {
    expect((await only(tlsLegacyCheck, deps())).findings).toEqual([]);
  });

  test("a timeout is inconclusive, not clean", async () => {
    const r = await only(
      tlsLegacyCheck,
      deps({
        tlsLegacy: async () => {
          throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
        },
      }),
    );
    expect(r.outcomes.tls).toBe("error");
  });
});

describe("active checks only run for verified assets", () => {
  test("an unverified asset skips them; a verified one runs them", async () => {
    const d = deps();
    const unverified = await runChecks(domain, { deps: d });
    expect(unverified.outcomes.exposure).toBeUndefined();
    expect(unverified.outcomes.ports).toBeUndefined();
    const verified = await runChecks(domain, { deps: d, verified: true });
    expect(verified.outcomes.exposure).toBe("ok");
    expect(verified.outcomes.ports).toBe("ok");
    expect(ALL_CHECKS.length).toBeGreaterThan(PASSIVE_CHECKS.length);
  });

  test("an explicit active check on an unverified asset is skipped, so it can't resolve anything", async () => {
    const r = await only(portsCheck, deps(), false);
    expect(r.outcomes.ports).toBe("skipped");
  });
});

describe("exposed paths", () => {
  const serve = (files: Record<string, string>) =>
    deps({
      fetch: async (u) => {
        const body = files[new URL(u).pathname];
        return body === undefined ? res("Not found", 404) : res(body);
      },
    });

  test("a real .env and a real git HEAD are found, without copying their contents", async () => {
    const r = await only(
      exposedPathsCheck,
      serve({
        "/.env": "DB_PASSWORD=hunter2\nAPP_KEY=abc",
        "/.git/HEAD": "ref: refs/heads/main\n",
      }),
    );
    expect(keys(r).sort()).toEqual(["exposure.path", "exposure.path"]);
    expect(r.findings.map((f) => f.subject).sort()).toEqual(["/.env", "/.git/HEAD"]);
    expect(r.findings.every((f) => f.severity === "critical")).toBe(true);
    expect(JSON.stringify(r.findings)).not.toContain("hunter2");
  });

  test("a site that answers 200 with its home page for everything is not flagged", async () => {
    const r = await only(
      exposedPathsCheck,
      deps({ fetch: async () => res("<!doctype html><title>Welcome</title><p>Hello</p>") }),
    );
    expect(r.findings).toEqual([]);
  });

  test("a redirect to a login page is not exposure", async () => {
    const r = await only(exposedPathsCheck, deps({ fetch: async () => res("DB_PASSWORD=x", 302) }));
    expect(r.findings).toEqual([]);
  });

  test("requests that fail are skipped rather than failing the scan", async () => {
    const r = await only(
      exposedPathsCheck,
      deps({
        fetch: async () => {
          throw new Error("reset");
        },
      }),
    );
    expect(r.outcomes.exposure).toBe("ok");
  });
});

describe("open ports", () => {
  test("databases open to the internet are reported with severity by kind", async () => {
    const r = await only(portsCheck, deps({ tcpOpen: async (_h, p) => p === 6379 || p === 3306 }));
    const bySubject = Object.fromEntries(r.findings.map((f) => [f.subject, f.severity]));
    expect(bySubject).toEqual({ "3306": "high", "6379": "critical" });
  });

  test("nothing open is clean, and web and SSH ports are never flagged", async () => {
    const asked: number[] = [];
    const r = await only(portsCheck, deps({ tcpOpen: async (_h, p) => (asked.push(p), false) }));
    expect(r.findings).toEqual([]);
    expect(asked).not.toContain(22);
    expect(asked).not.toContain(80);
    expect(asked).not.toContain(443);
  });
});
