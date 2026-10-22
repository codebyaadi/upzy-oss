import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createDb, schema } from "@upzy/db";
import { eq, sql } from "drizzle-orm";

import { notifySubscribers } from "../src/roles/status-notify";

// Needs a migrated Postgres: DATABASE_URL=... bun test
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run("status page subscriber email (postgres)", () => {
  const db = createDb(url);
  const { organizations, workspaces, monitors, incidents, incidentUpdates, statusPages, jobs } =
    schema;
  const tag = `sn${Date.now()}`;
  const orgId = `${tag}-org`;
  const appUrl = "https://app.example.test";
  let incidentId = "";
  let pageId = "";
  const ids: Record<string, string> = {};

  const emailsTo = async () =>
    (
      await db
        .select({ p: jobs.payload })
        .from(jobs)
        .where(sql`${jobs.queue} = 'email' and ${jobs.payload}->>'to' like ${`%${tag}%`}`)
    ).map((r) => r.p as { to: string; subject: string; text: string; headers?: object });
  const clear = () =>
    db
      .delete(jobs)
      .where(sql`${jobs.queue} = 'email' and ${jobs.payload}->>'to' like ${`%${tag}%`}`);

  beforeAll(async () => {
    await db
      .insert(organizations)
      .values({ id: orgId, name: "Sn", slug: orgId, createdAt: new Date() });
    const [ws] = await db
      .insert(workspaces)
      .values({ orgId, name: "Prod" })
      .returning({ id: workspaces.id });
    const [mon] = await db
      .insert(monitors)
      .values({
        workspaceId: ws!.id,
        name: "internal-db-primary",
        type: "http",
        target: "https://secret.internal.example/health",
        interval: 60,
        active: true,
      })
      .returning({ id: monitors.id });
    const [page] = await db
      .insert(statusPages)
      .values({ workspaceId: ws!.id, slug: tag, title: "Acme status", published: true })
      .returning({ id: statusPages.id });
    pageId = page!.id;
    await db
      .insert(schema.statusPageMonitors)
      .values({ pageId, monitorId: mon!.id, displayName: "Checkout" });
    const sub = (name: string, confirmed: boolean) =>
      db.insert(schema.statusSubscribers).values({
        pageId,
        email: `${name}-${tag}@example.com`,
        token: `${name}${tag}`.padEnd(40, "x"),
        confirmedAt: confirmed ? new Date() : null,
      });
    await sub("yes", true);
    await sub("pending", false);
    const [inc] = await db
      .insert(incidents)
      .values({
        workspaceId: ws!.id,
        monitorId: mon!.id,
        type: "uptime",
        status: "open",
        title: "SECRET: connection refused at 10.0.0.9",
      })
      .returning({ id: incidents.id });
    incidentId = inc!.id;
    ids.ws = ws!.id;
  });
  afterAll(async () => {
    await clear();
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  test("only confirmed subscribers are emailed, with the public name and never internal details", async () => {
    await clear();
    expect(await notifySubscribers(db, appUrl, { kind: "opened", incidentId })).toBe(1);
    const sent = await emailsTo();
    expect(sent).toHaveLength(1);
    const m = sent[0]!;
    expect(m.to).toBe(`yes-${tag}@example.com`);
    expect(m.subject).toBe("[Acme status] Checkout is having problems");
    expect(m.text).toContain(`${appUrl}/status/${tag}`);
    expect(m.text).toContain(`${appUrl}/subscription/yes${tag}`);
    expect(m.headers).toHaveProperty("List-Unsubscribe");
    for (const secret of ["SECRET", "10.0.0.9", "internal-db-primary", "secret.internal"])
      expect(JSON.stringify(m)).not.toContain(secret);
  });

  test("a posted update carries the message; recovery says it is back to normal", async () => {
    await clear();
    const [u] = await db
      .insert(incidentUpdates)
      .values({ incidentId, status: "identified", message: "A bad deploy. Rolling back." })
      .returning({ id: incidentUpdates.id });
    await notifySubscribers(db, appUrl, { kind: "update", incidentId, updateId: u!.id });
    await notifySubscribers(db, appUrl, { kind: "resolved", incidentId });
    const subjects = (await emailsTo()).map((m) => m.subject).sort();
    expect(subjects).toEqual([
      "[Acme status] Checkout is back to normal",
      "[Acme status] Checkout: Identified",
    ]);
    expect((await emailsTo()).find((m) => m.subject.endsWith("Identified"))!.text).toContain(
      "Identified: A bad deploy. Rolling back.",
    );
    // An update that was deleted before it went out sends nothing.
    await db.delete(incidentUpdates).where(eq(incidentUpdates.id, u!.id));
    await clear();
    expect(
      await notifySubscribers(db, appUrl, { kind: "update", incidentId, updateId: u!.id }),
    ).toBe(0);
  });

  test("an unpublished page sends nothing", async () => {
    await clear();
    await db.update(statusPages).set({ published: false }).where(eq(statusPages.id, pageId));
    expect(await notifySubscribers(db, appUrl, { kind: "opened", incidentId })).toBe(0);
    await db.update(statusPages).set({ published: true }).where(eq(statusPages.id, pageId));
  });

  test("a verified custom domain is the address in the email", async () => {
    await clear();
    await db
      .update(statusPages)
      .set({ customDomain: `status.${tag}.example.org`, domainVerifiedAt: new Date() })
      .where(eq(statusPages.id, pageId));
    await notifySubscribers(db, appUrl, { kind: "opened", incidentId });
    expect((await emailsTo())[0]!.text).toContain(`https://status.${tag}.example.org`);
  });
});
