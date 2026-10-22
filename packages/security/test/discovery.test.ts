import { describe, expect, test } from "bun:test";

import {
  checkResolves,
  discoverSubdomains,
  extractSubdomains,
  MAX_HOSTS,
  SOURCES,
  type JsonFetcher,
} from "../src";

describe("extractSubdomains", () => {
  test("splits multi-name entries, strips wildcards, lowercases and dedupes", () => {
    expect(
      extractSubdomains("example.com", [
        "WWW.Example.com\napi.example.com",
        "*.api.example.com",
        "api.example.com",
      ]),
    ).toEqual(["api.example.com", "www.example.com"]);
  });

  test("drops the apex, unrelated domains and look-alike suffixes", () => {
    expect(
      extractSubdomains("example.com", [
        "example.com",
        "*.example.com",
        "evil.com",
        "notexample.com",
        "example.com.evil.com",
        "a.example.org",
      ]),
    ).toEqual([]);
  });

  test("drops invalid names (wildcards mid-name, emails, junk, bad labels)", () => {
    expect(
      extractSubdomains("example.com", [
        "a*.example.com",
        "user@mail.example.com",
        "?.example.com",
        "-bad.example.com",
        "bad-.example.com",
        "sp ace.example.com",
        "ok.example.com",
        `${"a".repeat(64)}.example.com`,
      ]),
    ).toEqual(["ok.example.com", "ace.example.com"].sort());
  });

  test("accepts punycode and deep subdomains", () => {
    expect(
      extractSubdomains("example.com", ["xn--bcher-kva.example.com", "a.b.c.example.com"]),
    ).toEqual(["a.b.c.example.com", "xn--bcher-kva.example.com"]);
  });

  test("handles a trailing dot on the domain and is capped", () => {
    expect(extractSubdomains("example.com.", ["a.example.com"])).toEqual(["a.example.com"]);
    const many = Array.from({ length: MAX_HOSTS + 50 }, (_, i) => `h${i}.example.com`);
    expect(extractSubdomains("example.com", many)).toHaveLength(MAX_HOSTS);
  });
});

describe("discoverSubdomains", () => {
  const crt = [{ name_value: "a.example.com\nb.example.com", common_name: "a.example.com" }];
  const spotter = [{ dns_names: ["c.example.com", "*.d.example.com"] }];

  const fake = (
    routes: Record<string, unknown | Error>,
  ): { json: JsonFetcher; calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      json: async (url) => {
        calls.push(url);
        const key = Object.keys(routes).find((k) => url.includes(k));
        const v = key ? routes[key] : new Error("no route");
        if (v instanceof Error) throw v;
        return v;
      },
    };
  };

  test("uses the first source that answers", async () => {
    const { json, calls } = fake({ "crt.sh/?q=%25": crt });
    const r = await discoverSubdomains("example.com", { json });
    expect(r).toMatchObject({
      hosts: ["a.example.com", "b.example.com"],
      source: "crt.sh",
      errors: [],
    });
    expect(calls).toHaveLength(1);
  });

  test("falls back when crt.sh is down (502) and records why", async () => {
    const { json } = fake({ "crt.sh": new Error("HTTP 502"), certspotter: spotter });
    const r = await discoverSubdomains("example.com", { json });
    expect(r.source).toBe("certspotter");
    expect(r.hosts).toEqual(["c.example.com", "d.example.com"]);
    expect(r.errors).toEqual(["crt.sh: HTTP 502", "crt.sh (identity): HTTP 502"]);
  });

  test("a source that answers with an empty list is a real 'nothing found', not a failure", async () => {
    const { json, calls } = fake({ "crt.sh/?q=%25": [] });
    const r = await discoverSubdomains("example.com", { json });
    expect(r.hosts).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test("an unexpected payload (e.g. an HTML error page) counts as a failure", async () => {
    const { json } = fake({ "crt.sh": "<html>busy</html>", certspotter: spotter });
    expect((await discoverSubdomains("example.com", { json })).source).toBe("certspotter");
  });

  test("throws, listing every error, when all sources fail", async () => {
    const { json } = fake({});
    await expect(discoverSubdomains("example.com", { json })).rejects.toThrow(
      /All certificate transparency sources failed.*certspotter/,
    );
  });

  test("the domain is URL-encoded into queries", () => {
    expect(SOURCES[0]!.url("example.com")).toContain("q=%25.example.com");
    expect(SOURCES[0]!.url("a&b.com")).not.toContain("a&b");
  });
});

describe("checkResolves", () => {
  test("maps resolving, non-resolving and erroring hosts, with bounded concurrency", async () => {
    let active = 0;
    let peak = 0;
    const resolve = async (h: string) => {
      active++;
      peak = Math.max(peak, active);
      await Bun.sleep(5);
      active--;
      if (h.startsWith("err")) throw new Error("SERVFAIL");
      return h.startsWith("live") ? ["1.2.3.4"] : [];
    };
    const hosts = [
      ...Array.from({ length: 30 }, (_, i) => `live${i}.x.com`),
      "dead.x.com",
      "err.x.com",
    ];
    const m = await checkResolves(hosts, resolve, 5);
    expect(m.get("live0.x.com")).toBe(true);
    expect(m.get("dead.x.com")).toBe(false);
    expect(m.get("err.x.com")).toBeNull();
    expect(m.size).toBe(32);
    expect(peak).toBeLessThanOrEqual(5);
  });
});

test("a transient lookup error is retried once before a host is reported unknown", async () => {
  const seen = new Map<string, number>();
  const flaky = async (h: string) => {
    seen.set(h, (seen.get(h) ?? 0) + 1);
    if (h === "flaky.x.com" && seen.get(h) === 1) throw new Error("timeout");
    if (h === "broken.x.com") throw new Error("SERVFAIL");
    return ["1.2.3.4"];
  };
  const m = await checkResolves(["flaky.x.com", "broken.x.com", "ok.x.com"], flaky);
  expect(m.get("flaky.x.com")).toBe(true);
  expect(m.get("broken.x.com")).toBeNull();
  expect(seen.get("broken.x.com")).toBe(2);
  expect(seen.get("ok.x.com")).toBe(1);
});
