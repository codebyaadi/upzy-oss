import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createDb, schema } from "@upzy/db";
import { eq } from "drizzle-orm";

import { handleDiscover } from "../src/roles/discovery";

// Needs a migrated Postgres: DATABASE_URL=... bun test
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run("subdomain discovery (postgres)", () => {
  const db = createDb(url);
  const { assets, discoveredHosts, organizations, workspaces } = schema;
  const orgId = `disc-org-${Date.now()}`;
  let ws = "",
    domainId = "",
    subId = "";

  const found = (hosts: string[]) => ({
    discover: async () => ({ hosts, source: "test", errors: [] as string[] }),
    resolve: async (h: string) => (h.startsWith("dead") ? [] : ["1.2.3.4"]),
  });
  const rows = () => db.select().from(discoveredHosts).where(eq(discoveredHosts.workspaceId, ws));

  beforeAll(async () => {
    await db
      .insert(organizations)
      .values({ id: orgId, name: "t", slug: orgId, createdAt: new Date() });
    ws = (
      await db.insert(workspaces).values({ orgId, name: "w" }).returning({ id: workspaces.id })
    )[0]!.id;
    domainId = (
      await db
        .insert(assets)
        .values({ workspaceId: ws, kind: "domain", value: "example.com", verificationToken: "t" })
        .returning({ id: assets.id })
    )[0]!.id;
    subId = (
      await db
        .insert(assets)
        .values({
          workspaceId: ws,
          kind: "subdomain",
          value: "www.example.com",
          verificationToken: "t",
        })
        .returning({ id: assets.id })
    )[0]!.id;
  });
  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  test("records new hosts as suggestions, skipping existing assets, with DNS status", async () => {
    const fresh = await handleDiscover(
      db,
      { assetId: domainId },
      found(["www.example.com", "api.example.com", "dead.example.com"]),
    );
    expect(fresh).toBe(2);
    const r = await rows();
    expect(r.map((x) => x.host).sort()).toEqual(["api.example.com", "dead.example.com"]);
    expect(r.find((x) => x.host === "api.example.com")).toMatchObject({
      status: "new",
      resolves: true,
      source: "test",
      parentAssetId: domainId,
    });
    expect(r.find((x) => x.host === "dead.example.com")!.resolves).toBe(false);
  });

  test("a repeat run refreshes last_seen and adds nothing new", async () => {
    const before = (await rows()).find((x) => x.host === "api.example.com")!;
    await Bun.sleep(5);
    expect(
      await handleDiscover(
        db,
        { assetId: domainId },
        found(["api.example.com", "dead.example.com"]),
      ),
    ).toBe(0);
    const after = (await rows()).find((x) => x.host === "api.example.com")!;
    expect(after.lastSeen.getTime()).toBeGreaterThan(before.lastSeen.getTime());
    expect(await rows()).toHaveLength(2);
  });

  test("a dismissed host stays dismissed when seen again", async () => {
    await db
      .update(discoveredHosts)
      .set({ status: "dismissed" })
      .where(eq(discoveredHosts.host, "dead.example.com"));
    await handleDiscover(db, { assetId: domainId }, found(["dead.example.com"]));
    expect((await rows()).find((x) => x.host === "dead.example.com")!.status).toBe("dismissed");
  });

  test("success clears a previous error and records the time", async () => {
    await db.update(assets).set({ discoveryError: "old failure" }).where(eq(assets.id, domainId));
    await handleDiscover(db, { assetId: domainId }, found([]));
    const [a] = await db.select().from(assets).where(eq(assets.id, domainId));
    expect(a!.discoveryError).toBeNull();
    expect(a!.lastDiscoveryAt).not.toBeNull();
  });

  test("when every source fails the error is stored, retry is scheduled soon, and the job fails", async () => {
    const failing = {
      discover: async () =>
        Promise.reject(new Error("All certificate transparency sources failed (crt.sh: HTTP 502)")),
    };
    await expect(handleDiscover(db, { assetId: domainId }, failing)).rejects.toThrow(
      "All certificate transparency",
    );
    const [a] = await db.select().from(assets).where(eq(assets.id, domainId));
    expect(a!.discoveryError).toContain("crt.sh: HTTP 502");
    expect(a!.nextDiscoveryAt.getTime() - Date.now()).toBeLessThan(2 * 3600_000);
    expect(await rows()).toHaveLength(2); // an outage does not wipe known hosts
  });

  test("only domain assets are discovered", async () => {
    expect(await handleDiscover(db, { assetId: subId }, found(["x.example.com"]))).toBe(0);
    expect((await rows()).find((x) => x.host === "x.example.com")).toBeUndefined();
  });
});
