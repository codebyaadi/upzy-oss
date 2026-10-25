import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createDb, schema } from "@upzy/db";
import type { FindingDraft, ScanResult } from "@upzy/security";
import { eq } from "drizzle-orm";

import { applyScanResult, newFindingFilter } from "../src/roles/scanner";

// Needs a migrated Postgres: DATABASE_URL=... bun test
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

const draft = (checkKey: string, over: Partial<FindingDraft> = {}): FindingDraft => ({
  checkKey,
  severity: "medium",
  title: checkKey,
  description: "d",
  remediation: "r",
  ...over,
});
const result = (findings: FindingDraft[], outcomes: ScanResult["outcomes"]): ScanResult => ({
  findings,
  outcomes,
  errors: {},
});

run("applyScanResult (postgres)", () => {
  const db = createDb(url);
  const { assets, findings, scans, organizations, workspaces } = schema;
  let ws = "";
  let assetId = "";
  const orgId = `scan-test-org-${Date.now()}`;

  beforeAll(async () => {
    await db
      .insert(organizations)
      .values({ id: orgId, name: "t", slug: orgId, createdAt: new Date() });
    [{ id: ws }] = (await db
      .insert(workspaces)
      .values({ orgId, name: "w" })
      .returning({ id: workspaces.id })) as [{ id: string }];
    [{ id: assetId }] = (await db
      .insert(assets)
      .values({ workspaceId: ws, kind: "domain", value: "example.com", verificationToken: "t" })
      .returning({ id: assets.id })) as [{ id: string }];
  });
  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  const scan = async () =>
    (
      await db.insert(scans).values({ workspaceId: ws, assetId, status: "running" }).returning()
    )[0]!;
  const rows = () => db.select().from(findings).where(eq(findings.assetId, assetId));
  const status = async (key: string) => (await rows()).find((f) => f.checkKey === key)?.status;

  test("repeat findings dedupe, new ones insert", async () => {
    await applyScanResult(
      db,
      await scan(),
      result([draft("headers.csp_missing"), draft("tls.weak_key", { severity: "high" })], {
        headers: "ok",
        tls: "ok",
      }),
    );
    await applyScanResult(
      db,
      await scan(),
      result([draft("headers.csp_missing"), draft("tls.weak_key", { severity: "high" })], {
        headers: "ok",
        tls: "ok",
      }),
    );
    expect(await rows()).toHaveLength(2);
  });

  test("risk score is stored and severity-ordered", async () => {
    const r = await rows();
    expect(r.find((f) => f.checkKey === "tls.weak_key")!.riskScore).toBeGreaterThan(
      r.find((f) => f.checkKey === "headers.csp_missing")!.riskScore,
    );
  });

  test("a finding that disappears is auto-resolved only for families that completed", async () => {
    // headers ran fine and found nothing; tls errored.
    await applyScanResult(db, await scan(), result([], { headers: "ok", tls: "error" }));
    expect(await status("headers.csp_missing")).toBe("resolved");
    expect(await status("tls.weak_key")).toBe("open");
  });

  test("a resolved finding reopens when it comes back", async () => {
    await applyScanResult(
      db,
      await scan(),
      result([draft("headers.csp_missing")], { headers: "ok" }),
    );
    const f = (await rows()).find((r) => r.checkKey === "headers.csp_missing")!;
    expect(f.status).toBe("open");
    expect(f.resolvedAt).toBeNull();
  });

  test("an ignored finding stays ignored and is not auto-resolved", async () => {
    await db
      .update(findings)
      .set({ status: "ignored" })
      .where(eq(findings.checkKey, "headers.csp_missing"));
    await applyScanResult(
      db,
      await scan(),
      result([draft("headers.csp_missing")], { headers: "ok" }),
    );
    expect(await status("headers.csp_missing")).toBe("ignored");
    await applyScanResult(db, await scan(), result([], { headers: "ok" }));
    expect(await status("headers.csp_missing")).toBe("ignored");
  });

  test("only findings that are not already open or ignored count as new (and so get a second look)", async () => {
    const isNew = await newFindingFilter(db, assetId);
    // Open (tls.weak_key) and ignored (headers.csp_missing) are known; something never seen, or resolved, is new.
    expect(isNew(draft("tls.weak_key", { severity: "high" }))).toBe(false);
    expect(isNew(draft("headers.csp_missing"))).toBe(false);
    expect(isNew(draft("headers.hsts_missing"))).toBe(true);
    await applyScanResult(db, await scan(), result([], { tls: "ok" }));
    expect(await status("tls.weak_key")).toBe("resolved");
    expect((await newFindingFilter(db, assetId))(draft("tls.weak_key"))).toBe(true);
    await db
      .update(findings)
      .set({ status: "open", resolvedAt: null })
      .where(eq(findings.checkKey, "tls.weak_key"));
  });

  test("skipped families never resolve anything; all-error scans are marked failed", async () => {
    const s = await scan();
    await applyScanResult(db, s, result([], { headers: "error", tls: "error", email: "skipped" }));
    expect(await status("tls.weak_key")).toBe("open");
    expect((await db.select().from(scans).where(eq(scans.id, s.id)))[0]!.status).toBe("failed");
  });
});

run("risk scoring from exploitation signals (postgres)", () => {
  const db = createDb(url);
  const { assets, findings, scans, organizations, workspaces } = schema;
  const orgId = `risk-org-${Date.now()}`;
  let ws = "",
    assetId = "";
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
          value: "risk.example.com",
          verificationToken: "t",
        })
        .returning({ id: assets.id })
    )[0]!.id;
  });
  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  test("KEV and EPSS raise the stored risk score above plain severity, and the evidence is kept", async () => {
    const s = (
      await db.insert(scans).values({ workspaceId: ws, assetId, status: "running" }).returning()
    )[0]!;
    const base = { severity: "high" as const, title: "t", description: "d", remediation: "r" };
    await applyScanResult(
      db,
      s,
      result(
        [
          {
            ...base,
            checkKey: "cve.vulnerable_component",
            subject: "plain@1",
            evidence: { total: 1 },
          },
          {
            ...base,
            checkKey: "cve.vulnerable_component",
            subject: "exploited@1",
            risk: { kev: true, epss: 0.9 },
            evidence: { cves: [{ id: "CVE-1", kev: true }] },
          },
        ],
        { cve: "ok" },
      ),
    );
    const rows = await db.select().from(findings).where(eq(findings.assetId, assetId));
    const plain = rows.find((r) => r.evidence && (r.evidence as { total?: number }).total === 1)!;
    const exploited = rows.find((r) => JSON.stringify(r.evidence).includes("CVE-1"))!;
    expect(plain.riskScore).toBe(70);
    expect(exploited.riskScore).toBe(89); // 70 + 10 (KEV) + round(0.9 * 10)
  });

  test("a component whose CVE check errored keeps its finding; a clean successful run resolves it", async () => {
    const mk = async () =>
      (
        await db.insert(scans).values({ workspaceId: ws, assetId, status: "running" }).returning()
      )[0]!;
    await applyScanResult(db, await mk(), result([], { cve: "error" }));
    expect(
      (await db.select().from(findings).where(eq(findings.assetId, assetId))).every(
        (f) => f.status === "open",
      ),
    ).toBe(true);
    await applyScanResult(db, await mk(), result([], { cve: "ok" }));
    expect(
      (await db.select().from(findings).where(eq(findings.assetId, assetId))).every(
        (f) => f.status === "resolved",
      ),
    ).toBe(true);
  });
});
