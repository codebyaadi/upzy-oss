import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createDb, schema } from "@upzy/db";
import { memoryCache, type Deps } from "@upzy/security";
import { and, eq, sql } from "drizzle-orm";

import { checkKevAdditions, KEV_SEEN_KEY } from "../src/roles/advisories";
import { applyScanResult } from "../src/roles/scanner";

// Needs a migrated Postgres: DATABASE_URL=... bun test
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

const NGINX = "cpe:2.3:a:f5:nginx:1.18.0:*:*:*:*:*:*:*";
const component = {
  product: "nginx",
  display: "nginx",
  version: "1.18.0",
  detectedFrom: "Server: nginx/1.18.0",
  lookup: { kind: "nvd" as const, cpe: NGINX },
};

run("newly exploited CVEs (postgres)", () => {
  const db = createDb(url);
  const { assets, findings, jobs, organizations, workspaces, systemState, assetComponents } =
    schema;
  const orgId = `adv-org-${Date.now()}`;
  let ws = "";
  let assetId = "";
  let otherAssetId = "";

  /** What CISA lists and which CVEs the databases know for nginx 1.18.0; tests change these between runs. */
  let kev: { cveID: string; vendorProject: string; product: string }[] = [];
  let nvd: string[] = [];
  let nvdCalls = 0;
  const deps = {
    vuln: {
      cache: memoryCache(),
      sleep: async () => {},
      http: async (u: string) => {
        if (u.includes("known_exploited")) return { vulnerabilities: kev };
        if (u.includes("first.org")) return { data: [] };
        if (u.includes("nvd.nist.gov")) {
          nvdCalls++;
          // Only nginx 1.18.0 is covered by the fixture CVEs; 1.25.0 is clean.
          if (!u.includes("nginx%3A1.18.0") && !u.includes("nginx:1.18.0"))
            return { totalResults: 0, vulnerabilities: [] };
          return {
            totalResults: nvd.length,
            vulnerabilities: nvd.map((id) => ({
              cve: {
                id,
                descriptions: [{ lang: "en", value: "A flaw in nginx" }],
                metrics: {
                  cvssMetricV31: [{ cvssData: { baseScore: 7.5, baseSeverity: "HIGH" } }],
                },
              },
            })),
          };
        }
        throw new Error(`unexpected request ${u}`);
      },
    },
  } as unknown as Deps;

  const alerts = async () =>
    (
      await db
        .select({ n: sql<number>`count(*)::int` })
        .from(jobs)
        .where(
          and(eq(jobs.queue, "notify"), sql`${jobs.payload}->>'occurrence' like 'kev:CVE-2099-%'`),
        )
    )[0]!.n;

  beforeAll(async () => {
    await db
      .insert(organizations)
      .values({ id: orgId, name: "t", slug: orgId, createdAt: new Date() });
    ws = (
      await db.insert(workspaces).values({ orgId, name: "w" }).returning({ id: workspaces.id })
    )[0]!.id;
    const [a, b] = await db
      .insert(assets)
      .values([
        { workspaceId: ws, kind: "domain", value: "a.example.com", verificationToken: "t" },
        { workspaceId: ws, kind: "domain", value: "b.example.com", verificationToken: "t" },
      ])
      .returning({ id: assets.id });
    assetId = a!.id;
    otherAssetId = b!.id;
    await db.insert(assetComponents).values({ assetId, ...component });
    // The second asset runs a different nginx version that the new CVE does not cover.
    await db.insert(assetComponents).values({
      assetId: otherAssetId,
      ...component,
      version: "1.25.0",
      lookup: { kind: "nvd", cpe: NGINX.replace("1.18.0", "1.25.0") },
    });
    await db.delete(systemState).where(eq(systemState.key, KEV_SEEN_KEY));
  });
  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(systemState).where(eq(systemState.key, KEV_SEEN_KEY));
    await db.delete(jobs).where(sql`${jobs.payload}->>'occurrence' like 'kev:CVE-2099-%'`);
  });

  test("the first run only records the catalogue", async () => {
    kev = [{ cveID: "CVE-2000-0001", vendorProject: "F5", product: "nginx" }];
    const r = await checkKevAdditions(db, deps);
    expect(r).toEqual({ baseline: true, added: 0, affected: 0 });
    expect(await alerts()).toBe(0);
  });

  test("a CVE added later that hits a detected version opens a finding and alerts once", async () => {
    kev = [
      ...kev,
      { cveID: "CVE-2099-0001", vendorProject: "F5", product: "NGINX" },
      { cveID: "CVE-2099-0002", vendorProject: "Other", product: "Unrelated Thing" },
    ];
    nvd = ["CVE-2099-0001"];
    const r = await checkKevAdditions(db, deps);
    expect(r).toEqual({ baseline: false, added: 2, affected: 1 });

    const rows = await db
      .select()
      .from(findings)
      .where(and(eq(findings.workspaceId, ws), eq(findings.checkKey, "cve.vulnerable_component")));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.assetId).toBe(assetId);
    expect(rows[0]!.status).toBe("open");
    expect(rows[0]!.severity).toBe("high");
    expect(JSON.stringify(rows[0]!.evidence)).toContain("CVE-2099-0001");
    expect(await alerts()).toBe(1);
  });

  test("looking again does not alert again, and a failed lookup is retried rather than forgotten", async () => {
    const before = nvdCalls;
    expect(await checkKevAdditions(db, deps)).toEqual({ baseline: false, added: 0, affected: 0 });
    expect(nvdCalls).toBe(before);

    kev = [...kev, { cveID: "CVE-2099-0003", vendorProject: "F5", product: "nginx" }];
    nvd = ["CVE-2099-0001", "CVE-2099-0003"];
    const down = {
      vuln: {
        ...deps.vuln,
        http: async (u: string) => {
          if (u.includes("nvd.nist.gov")) throw new Error("NVD unavailable");
          return deps.vuln.http(u);
        },
      },
    } as Deps;
    const failed = await checkKevAdditions(db, down);
    expect(failed.affected).toBe(0);
    // Not remembered: the next run still sees CVE-2099-0003 as new, finds it, and alerts for it.
    const retried = await checkKevAdditions(db, deps);
    expect(retried.added).toBe(1);
    expect(retried.affected).toBe(1);
    expect(await alerts()).toBe(2);
    expect(await checkKevAdditions(db, deps)).toEqual({ baseline: false, added: 0, affected: 0 });
  });

  test("a scan stores what the page runs, and forgets what it no longer shows", async () => {
    const [scan] = await db
      .insert(schema.scans)
      .values({ workspaceId: ws, assetId, status: "running", startedAt: new Date() })
      .returning();
    await applyScanResult(db, scan!, {
      findings: [],
      outcomes: {},
      errors: {},
      components: [{ ...component, version: "1.20.0", lookup: component.lookup }],
    });
    const held = await db
      .select({ version: assetComponents.version })
      .from(assetComponents)
      .where(eq(assetComponents.assetId, assetId));
    expect(held.map((h) => h.version)).toEqual(["1.20.0"]);
    // A scan that could not read the page says nothing, so what is stored stays.
    await applyScanResult(db, scan!, { findings: [], outcomes: {}, errors: {} });
    expect(
      await db.select().from(assetComponents).where(eq(assetComponents.assetId, assetId)),
    ).toHaveLength(1);
  });
});
