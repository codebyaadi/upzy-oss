import { describe, expect, test } from "bun:test";

import {
  CreateStatusPageSchema,
  DomainSchema,
  isPublicHostname,
  UpdateStatusPageSchema,
} from "../src/status-page";

describe("custom domain", () => {
  test("accepts real hostnames, normalised to lower case", () => {
    for (const d of [
      "status.acme.com",
      "a.b.example.co.uk",
      "xn--bcher-kva.example.org",
      "s-1.example.io",
    ])
      expect(isPublicHostname(d)).toBe(true);
    expect(DomainSchema.parse("  Status.Acme.COM ")).toBe("status.acme.com");
  });

  test("rejects anything that isn't a plain public hostname", () => {
    for (const d of [
      "localhost",
      "acme",
      "10.0.0.1",
      "1.2.3.4",
      "https://status.acme.com",
      "status.acme.com/page",
      "status.acme.com:8443",
      "-bad.acme.com",
      "bad-.acme.com",
      "sta tus.acme.com",
      "status..acme.com",
      "under_score.acme.com",
      `${"a".repeat(64)}.acme.com`,
      "status.acme.123",
      "",
    ])
      expect(isPublicHostname(d)).toBe(false);
  });

  test("an update can clear the domain, and omitted fields stay omitted", () => {
    expect(UpdateStatusPageSchema.parse({ customDomain: null })).toEqual({ customDomain: null });
    expect(UpdateStatusPageSchema.parse({ title: "x" })).toEqual({ title: "x" });
    expect(UpdateStatusPageSchema.safeParse({ customDomain: "nope" }).success).toBe(false);
  });
});

describe("what the form actually sends", () => {
  test("an empty custom domain means none, on create and on update", () => {
    const create = CreateStatusPageSchema.parse({
      workspaceId: "01a14866-ba55-7faf-a7ed-5dd76102aaac",
      title: "Acme",
      slug: "acme",
      customDomain: "",
      components: [],
    });
    expect(create.customDomain).toBeUndefined();
    expect(create.securityAssetId).toBeNull();
    expect(UpdateStatusPageSchema.parse({ customDomain: "" }).customDomain).toBeNull();
    // Unchanged fields stay untouched, and a real domain is still validated.
    expect("customDomain" in UpdateStatusPageSchema.parse({ title: "x" })).toBe(false);
    expect(UpdateStatusPageSchema.safeParse({ customDomain: "not a domain" }).success).toBe(false);
  });
});
