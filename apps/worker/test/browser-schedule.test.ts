import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { createDb, schema } from "@upzy/db";
import type { runProbe } from "@upzy/probes";
import { and, eq, sql } from "drizzle-orm";

import { handleCheck } from "../src/roles/prober";
import { scheduleDue } from "../src/roles/scheduler";

const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run("browser monitors in the job system (postgres)", () => {
  const db = createDb(url);
  const { organizations, workspaces, monitors, jobs, incidents } = schema;
  const orgId = `bs-org-${Date.now()}`;
  let ws = "";
  const previous = process.env.BROWSER_WS_ENDPOINT;

  beforeAll(async () => {
    await db
      .insert(organizations)
      .values({ id: orgId, name: "t", slug: orgId, createdAt: new Date() });
    ws = (
      await db.insert(workspaces).values({ orgId, name: "w" }).returning({ id: workspaces.id })
    )[0]!.id;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.BROWSER_WS_ENDPOINT;
    else process.env.BROWSER_WS_ENDPOINT = previous;
  });
  afterAll(async () => {
    await db
      .delete(jobs)
      .where(
        sql`payload->>'monitorId' in (select id::text from monitors where workspace_id = ${ws})`,
      );
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  const make = async (type: "synthetic" | "http") =>
    (
      await db
        .insert(monitors)
        .values({
          workspaceId: ws,
          name: type,
          type,
          target: "https://example.com/login",
          interval: 300,
          active: true,
          failureThreshold: 1,
          nextRun: new Date(Date.now() - 1000),
          config: type === "synthetic" ? { browser: [{ do: "click", selector: "#go" }] } : {},
        })
        .returning()
    )[0]!;
  const queued = async (monitorId: string) =>
    (await db.select().from(jobs)).filter(
      (j) => (j.payload as { monitorId?: string }).monitorId === monitorId,
    );

  test("without a browser server, a browser monitor is left alone and ordinary ones still run", async () => {
    delete process.env.BROWSER_WS_ENDPOINT;
    const b = await make("synthetic");
    const h = await make("http");
    await scheduleDue(db, 500);
    expect(await queued(b.id)).toEqual([]);
    expect((await queued(h.id)).map((j) => j.queue)).toEqual(["check"]);
    // Still due, so it starts the moment a browser is configured.
    const [row] = await db.select().from(monitors).where(eq(monitors.id, b.id));
    expect(row!.nextRun.getTime()).toBeLessThan(Date.now());
  });

  test("with one, it is queued for the browser role, not the ordinary prober", async () => {
    process.env.BROWSER_WS_ENDPOINT = "ws://browser:3000/token";
    const b = await make("synthetic");
    await scheduleDue(db, 500);
    expect((await queued(b.id)).map((j) => j.queue)).toEqual(["browser"]);
  });

  test("its result goes through the same incident logic as any monitor", async () => {
    const b = await make("synthetic");
    const probe: typeof runProbe = async (t) => {
      // The probe gets the steps and the start page.
      expect(t.type).toBe("synthetic");
      expect(t.config.browser).toEqual([{ do: "click", selector: "#go" }]);
      return {
        status: "down",
        responseMs: 2300,
        error: "Step 1 (click #go) failed: timed out",
        errorKind: "timeout",
      };
    };
    await handleCheck(db, { monitorId: b.id, region: "local" }, { probe });
    const open = await db
      .select()
      .from(incidents)
      .where(and(eq(incidents.monitorId, b.id), eq(incidents.status, "open")));
    expect(open).toHaveLength(1);
    expect(open[0]!.title).toContain("Step 1 (click #go) failed");
  });
});
