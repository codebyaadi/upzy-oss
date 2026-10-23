import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { encryptJson } from "@upzy/crypto";
import { createDb, schema } from "@upzy/db";
import type { Poster } from "@upzy/notify";
import { and, eq } from "drizzle-orm";

import { handleDeliver, type DeliverJob, type NotifierEnv } from "../src/roles/notifier";

// Needs a migrated Postgres: DATABASE_URL=... bun test
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

const KEY = Buffer.alloc(32, 9).toString("base64");

run("incident integrations (postgres)", () => {
  const db = createDb(url);
  const {
    organizations,
    workspaces,
    monitors,
    incidents,
    notificationChannels,
    notificationDeliveries,
  } = schema;
  const orgId = `in-org-${Date.now()}`;
  let ws = "";

  const calls: { url: string; body: any; method?: string }[] = [];
  let issueNumber = 100;
  const post: Poster = async (u, body, _h, method) => {
    calls.push({ url: u, body: JSON.parse(body), method });
    if (u.endsWith("/issues"))
      return { status: 201, body: JSON.stringify({ number: ++issueNumber }) };
    return { status: 200 };
  };
  const env: NotifierEnv = {
    encryptionKey: KEY,
    appUrl: "https://app.test",
    mailFrom: "x@y.z",
    post,
  };
  const job = { attempts: 1, maxAttempts: 5 };

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

  const channel = async (kind: "github" | "pagerduty" | "opsgenie" | "teams", config: object) =>
    (
      await db
        .insert(notificationChannels)
        .values({
          workspaceId: ws,
          name: kind,
          kind,
          summary: kind,
          configEncrypted: encryptJson(config, KEY),
        })
        .returning({ id: notificationChannels.id })
    )[0]!.id;
  // Only one incident can be open per monitor, so each gets its own.
  const incident = async () => {
    const m = (
      await db
        .insert(monitors)
        .values({
          workspaceId: ws,
          name: "api",
          type: "http",
          target: "https://api.example.com",
          interval: 60,
          active: true,
        })
        .returning({ id: monitors.id })
    )[0]!.id;
    return (
      await db
        .insert(incidents)
        .values({
          workspaceId: ws,
          monitorId: m,
          type: "uptime",
          status: "open",
          title: "api is down",
        } as never)
        .returning({ id: incidents.id })
    )[0]!.id;
  };
  const deliverJob = (incidentId: string, channelId: string, event: DeliverJob["event"]) =>
    ({ incidentId, channelId, event }) as DeliverJob;
  const row = async (incidentId: string, channelId: string, event: string) =>
    (
      await db
        .select()
        .from(notificationDeliveries)
        .where(
          and(
            eq(notificationDeliveries.incidentId, incidentId),
            eq(notificationDeliveries.channelId, channelId),
            eq(notificationDeliveries.event, event),
          ),
        )
    )[0];

  test("GitHub: the outage opens an issue whose number is kept, and the recovery closes that same issue", async () => {
    calls.length = 0;
    const ch = await channel("github", { repo: "acme/web", token: "ghp_exampletoken1234567890" });
    const inc = await incident();

    await handleDeliver(db, env, undefined, deliverJob(inc, ch, "incident.opened"), job);
    const opened = await row(inc, ch, "incident.opened");
    expect(opened).toMatchObject({ status: "sent", externalId: "101" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.title).toBe("[Down] api");
    expect(calls[0]!.body.body).toContain(`https://app.test/incidents/${inc}`);

    await handleDeliver(db, env, undefined, deliverJob(inc, ch, "incident.resolved"), job);
    expect(calls.slice(1).map((c) => [c.method ?? "POST", c.url])).toEqual([
      ["POST", "https://api.github.com/repos/acme/web/issues/101/comments"],
      ["PATCH", "https://api.github.com/repos/acme/web/issues/101"],
    ]);
    expect(await row(inc, ch, "incident.resolved")).toMatchObject({ status: "sent" });
  });

  test("GitHub: two outages on one channel close their own issues, not each other's", async () => {
    calls.length = 0;
    const ch = await channel("github", { repo: "acme/web", token: "ghp_exampletoken1234567890" });
    const a = await incident();
    const b = await incident();
    await handleDeliver(db, env, undefined, deliverJob(a, ch, "incident.opened"), job);
    await handleDeliver(db, env, undefined, deliverJob(b, ch, "incident.opened"), job);
    const na = (await row(a, ch, "incident.opened"))!.externalId;
    const nb = (await row(b, ch, "incident.opened"))!.externalId;
    expect(na).not.toBe(nb);
    calls.length = 0;
    await handleDeliver(db, env, undefined, deliverJob(b, ch, "incident.resolved"), job);
    expect(calls.every((c) => c.url.includes(`/issues/${nb}`))).toBe(true);
  });

  test("GitHub: a recovery whose outage was never delivered closes nothing and still succeeds", async () => {
    calls.length = 0;
    const ch = await channel("github", { repo: "acme/web", token: "ghp_exampletoken1234567890" });
    const inc = await incident();
    await handleDeliver(db, env, undefined, deliverJob(inc, ch, "incident.resolved"), job);
    expect(calls).toHaveLength(0);
    expect(await row(inc, ch, "incident.resolved")).toMatchObject({ status: "sent" });
  });

  test("PagerDuty and Opsgenie need no stored id: the same incident id ties the page to its recovery", async () => {
    calls.length = 0;
    const pd = await channel("pagerduty", { routingKey: "R0UT1NGK3Y0123456789abcdefghijkl" });
    const og = await channel("opsgenie", {
      apiKey: "abcdef12-3456-7890-abcd-ef1234567890",
      region: "eu",
    });
    const inc = await incident();
    for (const ch of [pd, og])
      for (const ev of ["incident.opened", "incident.resolved"] as const)
        await handleDeliver(db, env, undefined, deliverJob(inc, ch, ev), job);
    const pdCalls = calls.filter((c) => c.url.includes("pagerduty"));
    expect(pdCalls.map((c) => c.body.event_action)).toEqual(["trigger", "resolve"]);
    expect(new Set(pdCalls.map((c) => c.body.dedup_key)).size).toBe(1);
    const ogCalls = calls.filter((c) => c.url.includes("opsgenie"));
    expect(ogCalls[0]!.url).toBe("https://api.eu.opsgenie.com/v2/alerts");
    expect(ogCalls[1]!.url).toContain(`upzy-incident-${inc}/close`);
    expect((await row(inc, pd, "incident.opened"))!.externalId).toBeNull();
  });

  test("a delivery is not repeated once it was sent", async () => {
    calls.length = 0;
    const ch = await channel("teams", { url: "https://contoso.webhook.office.com/webhookb2/abc" });
    const inc = await incident();
    await handleDeliver(db, env, undefined, deliverJob(inc, ch, "incident.opened"), job);
    await handleDeliver(db, env, undefined, deliverJob(inc, ch, "incident.opened"), job);
    expect(calls).toHaveLength(1);
  });

  test("a provider refusing the request is recorded as failed on the last attempt, and retried before that", async () => {
    const refuse: NotifierEnv = { ...env, post: async () => ({ status: 401 }) };
    const ch = await channel("github", { repo: "acme/web", token: "ghp_exampletoken1234567890" });
    const inc = await incident();
    await expect(
      handleDeliver(db, refuse, undefined, deliverJob(inc, ch, "incident.opened"), {
        attempts: 1,
        maxAttempts: 5,
      }),
    ).rejects.toThrow(/GitHub.*401/);
    expect(await row(inc, ch, "incident.opened")).toBeUndefined();
    await expect(
      handleDeliver(db, refuse, undefined, deliverJob(inc, ch, "incident.opened"), {
        attempts: 5,
        maxAttempts: 5,
      }),
    ).rejects.toThrow();
    expect(await row(inc, ch, "incident.opened")).toMatchObject({ status: "failed" });
  });
});
