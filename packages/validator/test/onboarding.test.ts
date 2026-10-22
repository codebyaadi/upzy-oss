import { describe, expect, test } from "bun:test";

import { parseSite } from "../src/onboarding";

describe("parseSite", () => {
  test("a bare domain and a www address both watch the site and scan the domain", () => {
    expect(parseSite("acme.com")).toEqual({
      url: "https://acme.com/",
      host: "acme.com",
      assetValue: "acme.com",
      assetKind: "domain",
    });
    expect(parseSite("  WWW.Acme.com ")).toEqual({
      url: "https://www.acme.com/",
      host: "www.acme.com",
      assetValue: "acme.com",
      assetKind: "domain",
    });
  });

  test("a real subdomain is scanned as itself", () => {
    expect(parseSite("app.acme.com")).toMatchObject({
      assetValue: "app.acme.com",
      assetKind: "subdomain",
      url: "https://app.acme.com/",
    });
  });

  test("two-level suffixes like co.uk keep their registrable domain", () => {
    expect(parseSite("www.shop.co.uk")).toMatchObject({
      assetValue: "shop.co.uk",
      assetKind: "domain",
    });
    expect(parseSite("api.shop.co.uk")).toMatchObject({
      assetValue: "api.shop.co.uk",
      assetKind: "subdomain",
    });
  });

  test("a pasted URL keeps its scheme and path but drops the query", () => {
    expect(parseSite("https://acme.com/health?x=1#top")?.url).toBe("https://acme.com/health");
    expect(parseSite("http://acme.com/")?.url).toBe("http://acme.com/");
    expect(parseSite("https://acme.com:8443/status/")?.url).toBe("https://acme.com:8443/status");
  });

  test("anything that isn't a public website is refused", () => {
    for (const bad of [
      "",
      "localhost",
      "acme",
      "10.0.0.1",
      "1.2.3.4",
      "http://127.0.0.1/",
      "192.168.1.5:8080",
      "intranet.internal",
      "box.local",
      "ftp://acme.com",
      "javascript:alert(1)",
      "user:pw@acme.com",
      "acme .com",
      "a".repeat(400),
      "metadata.google.internal",
    ])
      expect(parseSite(bad)).toBeNull();
  });
});
