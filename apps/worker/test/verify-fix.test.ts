import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createDb, schema } from "@upzy/db";
import { healthHistory, type Deps } from "@upzy/security";
import { eq } from "drizzle-orm";

import { applyScanResult, handleVerify } from "../src/roles/scanner";

// Needs a migrated Postgres: DATABASE_URL=... bun test
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

const GOOD = {
  "strict-transport-security": "max-age=31536000",
  "content-security-policy": "default-src 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=()",
  "x-frame-options": "DENY",
  server: "cloudflare",
  "cf-ray": "abc",
};

/** A site whose headers can be changed between verifications. */
const site = (headers: Record<string, string> | Error) =>
  ({
    fetch: async (u: string) => {
      if (headers instanceof Error) throw headers;
      return {
        status: 200,
        headers,
        setCookies: [],
        finalUrl: u.replace("http:", "https:"),
        body: "",
        ttfbMs: 1,
        totalMs: 1,
      };
    },
  }) as unknown as Deps;

run("verify fix (postgres)", () => {
  const db = createDb(url);
  const { assets, findings, scans, organizations, workspaces } = schema;
  const orgId = `vf-${Date.now()}`;
  let assetId = "";
  let ws = "";
  const find = async (key: string) =>
    (await db.select().from(findings).where(eq(findings.assetId, assetId))).find(
      (f) => f.checkKey === key,
    )!;

  beforeAll(async () => {
    await db
      .insert(organizations)
      .values({ id: orgId, name: "t", slug: orgId, createdAt: new Date() });
    ws = (
      await db.insert(workspaces).values({ orgId, name: "w" }).returning({ id: workspaces.id })
    )[0]!.id;
    assetId = (
      await db
        .insert(assets)
        .values({
          workspaceId: ws,
          kind: "domain",
          value: "verify.example.com",
          verificationToken: "t",
          lastScanAt: new Date(),
        })
        .returning({ id: assets.id })
    )[0]!.id;
    // The findings an earlier scan raised: two headers problems and an email one (a different family).
    const [scan] = await db
      .insert(scans)
      .values({ workspaceId: ws, assetId, status: "running" })
      .returning();
    const d = (checkKey: string) => ({
      checkKey,
      severity: "medium" as const,
      title: checkKey,
      description: "d",
      remediation: "r",
    });
    await applyScanResult(db, scan!, {
      findings: [d("headers.hsts_missing"), d("headers.csp_missing"), d("email.dmarc_missing")],
      outcomes: { headers: "ok", email: "ok" },
      errors: {},
    });
  });
  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  test("a fix that isn't in place yet leaves the finding open and says when it was checked", async () => {
    const f = await find("headers.hsts_missing");
    await handleVerify(db, { findingId: f.id }, site({ ...GOOD, "strict-transport-security": "" }));
    const after = await find("headers.hsts_missing");
    expect(after.status).toBe("open");
    expect(after.lastVerifiedAt).not.toBeNull();
    expect(after.verifyStatus).toBeNull();
  });

  test("once the header is there, the finding turns green and only its own family is touched", async () => {
    const f = await find("headers.hsts_missing");
    await db.update(findings).set({ verifyStatus: "pending" }).where(eq(findings.id, f.id));
    await handleVerify(db, { findingId: f.id }, site(GOOD));
    const after = await find("headers.hsts_missing");
    expect(after.status).toBe("resolved");
    expect(after.verifyStatus).toBeNull();
    // CSP was fixed in the same family, so it resolves too; the email finding wasn't re-checked, so it is untouched.
    expect((await find("headers.csp_missing")).status).toBe("resolved");
    expect((await find("email.dmarc_missing")).status).toBe("open");

    // The stack was read from the same request, and today's health point was stored.
    const [a] = await db.select().from(assets).where(eq(assets.id, assetId));
    expect(a!.stack).toMatchObject({ platform: "cloudflare" });
    expect((await healthHistory(db, assetId)).length).toBe(1);
  });

  test("when the check can't run, the finding stays as it was and the reason is recorded", async () => {
    const f = await find("email.dmarc_missing");
    await handleVerify(
      db,
      { findingId: f.id },
      {
        ...site(GOOD),
        resolveMx: async () => {
          throw new Error("DNS lookup timed out");
        },
      },
    );
    const after = await find("email.dmarc_missing");
    expect(after.status).toBe("open");
    expect(after.verifyStatus).toBe("failed");
    expect(after.verifyError).toContain("DNS lookup timed out");
  });

  test("a finding from a check that can't be re-run says so", async () => {
    const [scan] = await db
      .insert(scans)
      .values({ workspaceId: ws, assetId, status: "running" })
      .returning();
    await applyScanResult(db, scan!, {
      findings: [
        {
          checkKey: "mystery.thing",
          severity: "low",
          title: "m",
          description: "d",
          remediation: "r",
        },
      ],
      outcomes: { mystery: "ok" },
      errors: {},
    });
    const f = await find("mystery.thing");
    await handleVerify(db, { findingId: f.id }, site(GOOD));
    expect((await find("mystery.thing")).verifyStatus).toBe("failed");
  });
});
