import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createDb, schema } from "@upzy/db";
import { dnsRecordValue, runChecks, type Deps } from "@upzy/security";
import { eq, sql } from "drizzle-orm";

import { MAX_FAILURES, recheckOwnership } from "../src/roles/ownership";

// Needs a migrated Postgres: DATABASE_URL=... bun test
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run("ownership re-check (postgres)", () => {
  const db = createDb(url);
  const { assets, organizations, workspaces } = schema;
  const orgId = `own-org-${Date.now()}`;
  let ws = "";

  /** What DNS and the site's well-known file say right now. Tests change it between rounds. */
  let txt: Record<string, string[][]> = {};
  const deps = {
    resolveTxt: async (name: string) => txt[name] ?? [],
    fetch: async () => {
      throw new Error("no file served");
    },
  } as unknown as Pick<Deps, "resolveTxt" | "fetch">;

  beforeAll(async () => {
    await db
      .insert(organizations)
      .values({ id: orgId, name: "t", slug: orgId, createdAt: new Date() });
    ws = (
      await db.insert(workspaces).values({ orgId, name: "w" }).returning({ id: workspaces.id })
    )[0]!.id;
  });
  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  const add = async (
    value: string,
    kind: "domain" | "subdomain" = "domain",
    token = `tok-${value}`,
  ) =>
    (
      await db
        .insert(assets)
        .values({
          workspaceId: ws,
          kind,
          value,
          verified: true,
          verifiedAt: new Date(),
          verificationToken: token,
        })
        .returning()
    )[0]!;
  const fresh = async (id: string) => (await db.select().from(assets).where(eq(assets.id, id)))[0]!;
  /** The next round, as if a day (or a week) had passed. */
  const due = (id: string) =>
    db
      .update(assets)
      .set({ verifyNextAt: sql`now() - interval '1 minute'` })
      .where(eq(assets.id, id));

  test("an asset whose record is still there stays verified and is not looked at again for a week", async () => {
    const a = await add("keeps.example.com");
    txt = { "keeps.example.com": [[dnsRecordValue(a.verificationToken)]] };
    const r = await recheckOwnership(db, deps);
    expect(r.checked).toBeGreaterThanOrEqual(1);
    const after = await fresh(a.id);
    expect(after.verified).toBe(true);
    expect(after.verifyFailures).toBe(0);
    expect(after.verifyNextAt.getTime() - Date.now()).toBeGreaterThan(6 * 86_400_000);
    // Nothing is due for it now.
    const again = await recheckOwnership(db, deps);
    expect((await fresh(a.id)).verifyNextAt).toEqual(after.verifyNextAt);
    expect(again.lost).not.toContain("keeps.example.com");
  });

  test("a removed record loses verification only after repeated failures, never on the first", async () => {
    const a = await add("lapses.example.com");
    txt = {};
    for (let round = 1; round < MAX_FAILURES; round++) {
      await due(a.id);
      const r = await recheckOwnership(db, deps);
      expect(r.lost).not.toContain(a.value);
      const mid = await fresh(a.id);
      expect(mid.verified).toBe(true);
      expect(mid.verifyFailures).toBe(round);
      // After a failure it is looked at again the next day, not next week.
      expect(mid.verifyNextAt.getTime() - Date.now()).toBeLessThan(2 * 86_400_000);
    }
    await due(a.id);
    const last = await recheckOwnership(db, deps);
    expect(last.lost).toContain(a.value);
    const lost = await fresh(a.id);
    expect(lost.verified).toBe(false);
    expect(lost.verifiedAt).toBeNull();
    expect(lost.verificationLostAt).not.toBeNull();
  });

  test("a record that comes back in time resets the count", async () => {
    const a = await add("blip.example.com");
    txt = {};
    await due(a.id);
    await recheckOwnership(db, deps);
    expect((await fresh(a.id)).verifyFailures).toBe(1);
    txt = { "blip.example.com": [[dnsRecordValue(a.verificationToken)]] };
    await due(a.id);
    await recheckOwnership(db, deps);
    const after = await fresh(a.id);
    expect(after.verifyFailures).toBe(0);
    expect(after.verified).toBe(true);
  });

  test("a subdomain is covered by its verified parent, and follows it when the parent is withdrawn", async () => {
    const parent = await add("parent.org");
    const sub = await add("shop.parent.org", "subdomain");
    txt = { "parent.org": [[dnsRecordValue(parent.verificationToken)]] };
    await due(sub.id);
    await recheckOwnership(db, deps);
    expect((await fresh(sub.id)).verified).toBe(true);
    expect((await fresh(sub.id)).verifyFailures).toBe(0);

    // The parent's record disappears and, after the checks, both are withdrawn.
    txt = {};
    for (let i = 0; i < MAX_FAILURES; i++) {
      await due(parent.id);
      await recheckOwnership(db, deps);
    }
    expect((await fresh(parent.id)).verified).toBe(false);
    // The subdomain was still covered until now; it is looked at again at the very next round and, with nothing
    // covering it and no record of its own, withdrawn straight away.
    expect((await fresh(sub.id)).verified).toBe(true);
    await recheckOwnership(db, deps);
    expect((await fresh(sub.id)).verified).toBe(false);
  });

  test("once withdrawn, active checks stop: the next scan skips them", async () => {
    const asset = { kind: "domain", value: "lost.example.com" } as const;
    const scanDeps = {
      fetch: async () => ({
        status: 200,
        headers: { "content-type": "text/html" },
        setCookies: [],
        finalUrl: "https://lost.example.com/",
        body: "",
        ttfbMs: 1,
        totalMs: 1,
      }),
      resolveTxt: async () => [],
      resolveMx: async () => [],
      resolveCname: async () => [],
      resolveAddresses: async () => ["93.184.216.34"],
      resolveCaa: async () => [{}],
      tls: async () => {
        throw new Error("x");
      },
      tlsLegacy: async () => false,
      tcpOpen: async () => true,
      grabBanner: async () => null,
      vuln: { http: async () => ({}), cache: { get: async () => undefined, set: async () => {} } },
    } as unknown as Deps;
    const verified = await runChecks(asset, { deps: scanDeps, verified: true });
    const unverified = await runChecks(asset, { deps: scanDeps, verified: false });
    expect(verified.outcomes.ports).toBe("ok");
    // The active families are not run at all for an unverified asset.
    expect(unverified.outcomes.ports).toBeUndefined();
    expect(unverified.outcomes.exposed).toBeUndefined();
  });
});
