import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { reportUnsubscribeToken } from "@upzy/auth/unsubscribe";
import { createDb, schema } from "@upzy/db";
import { eq, inArray, sql } from "drizzle-orm";

import {
  handleReport,
  lastPeriod,
  parseReports,
  scheduleReports,
  type ReportConfig,
} from "../src/roles/reports";

const at = (iso: string) => new Date(iso);

describe("report periods", () => {
  test("weekly: the last finished Monday to Sunday, due from 07:00 UTC on the Monday", () => {
    const p = lastPeriod("weekly", at("2026-10-20T09:00:00Z")); // a Tuesday
    expect(p.key).toBe("2026-10-12");
    expect(p.from.toISOString()).toBe("2026-10-12T00:00:00.000Z");
    expect(p.to.toISOString()).toBe("2026-10-19T00:00:00.000Z");
    expect(p.label).toBe("12 to 18 October 2026");
    expect(p.due).toBe(true);

    expect(lastPeriod("weekly", at("2026-10-19T06:59:00Z")).due).toBe(false);
    expect(lastPeriod("weekly", at("2026-10-19T06:59:00Z")).key).toBe("2026-10-12");
    expect(lastPeriod("weekly", at("2026-10-19T07:00:00Z")).due).toBe(true);
    // The Sunday before: still the previous week, not yet due for the new one.
    expect(lastPeriod("weekly", at("2026-10-18T23:00:00Z")).key).toBe("2026-10-05");
  });

  test("weekly labels span months and years", () => {
    expect(lastPeriod("weekly", at("2026-10-06T09:00:00Z")).label).toBe(
      "28 September to 4 October 2026",
    );
    expect(lastPeriod("weekly", at("2027-01-05T09:00:00Z")).label).toBe(
      "28 December 2026 to 3 January 2027",
    );
  });

  test("monthly: the calendar month before, due from 07:00 UTC on the 1st", () => {
    const p = lastPeriod("monthly", at("2026-11-01T08:00:00Z"));
    expect(p.key).toBe("2026-10");
    expect(p.from.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(p.to.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(p.label).toBe("October 2026");
    expect(p.due).toBe(true);
    expect(lastPeriod("monthly", at("2026-11-01T06:00:00Z")).due).toBe(false);
    expect(lastPeriod("monthly", at("2026-11-15T06:00:00Z")).due).toBe(true);
    // Year rollover and a short month.
    expect(lastPeriod("monthly", at("2027-01-02T00:00:00Z")).key).toBe("2026-12");
    expect(lastPeriod("monthly", at("2026-03-02T09:00:00Z")).label).toBe("February 2026");
  });
});

describe("report settings", () => {
  test("need a secret for the unsubscribe links, and can be switched off", () => {
    expect(parseReports({ BETTER_AUTH_SECRET: "s" }).enabled).toBe(true);
    expect(parseReports({}).enabled).toBe(false);
    expect(parseReports({ BETTER_AUTH_SECRET: "s", CLIENT_REPORTS: "off" }).enabled).toBe(false);
    expect(parseReports({ BETTER_AUTH_SECRET: "s" }).billingEnabled).toBe(false);
  });
});

const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run("client reports (postgres)", () => {
  const db = createDb(url);
  const {
    users,
    organizations,
    workspaces,
    monitors,
    monitorChecks,
    incidents,
    findings,
    assets,
    subscriptions,
    reportSchedules,
    reportRecipients,
    statusPages,
    jobs,
  } = schema;
  const tag = `rp${Date.now()}`;
  const NOW = at("2026-11-02T09:00:00Z"); // a Monday, so October is due
  const config: ReportConfig = {
    enabled: true,
    billingEnabled: false,
    appUrl: "https://app.example.com",
    apiUrl: "https://api.example.com",
    secret: "secret",
  };
  const orgIds: string[] = [];
  let seq = 0;

  const emailsTo = async (...addresses: string[]) => {
    const rows = await db
      .select({ payload: jobs.payload })
      .from(jobs)
      .where(eq(jobs.queue, "email"));
    return rows
      .map((r) => r.payload as { to: string; subject: string; text: string; template?: unknown })
      .filter((p) => addresses.includes(p.to));
  };

  async function client(
    opts: { recipients?: string[]; frequency?: "weekly" | "monthly"; enabled?: boolean } = {},
  ) {
    const n = ++seq;
    const orgId = `${tag}-org${n}`;
    orgIds.push(orgId);
    await db
      .insert(organizations)
      .values({ id: orgId, name: `Pixel ${n}`, slug: orgId, createdAt: new Date() });
    const ws = (
      await db
        .insert(workspaces)
        .values({ orgId, name: `Acme ${n}` })
        .returning({ id: workspaces.id })
    )[0]!.id;
    await db.insert(reportSchedules).values({
      workspaceId: ws,
      enabled: opts.enabled ?? true,
      frequency: opts.frequency ?? "monthly",
    });
    const recipients = opts.recipients ?? [`${tag}-client${n}@example.com`];
    for (const email of recipients)
      await db.insert(reportRecipients).values({ workspaceId: ws, email });
    return { orgId, ws, recipients };
  }

  async function monitorWithChecks(
    ws: string,
    name: string,
    ups: number,
    downs: number,
    inMonth = "2026-10-15T12:00:00Z",
  ) {
    const m = (
      await db
        .insert(monitors)
        .values({
          workspaceId: ws,
          name,
          type: "http",
          target: `https://${name}.example.com`,
          interval: 60,
          active: true,
        })
        .returning({ id: monitors.id })
    )[0]!.id;
    const rows = [
      ...Array.from({ length: ups }, () => ({
        monitorId: m,
        status: "up" as const,
        responseMs: 200,
        createdAt: at(inMonth),
      })),
      ...Array.from({ length: downs }, () => ({
        monitorId: m,
        status: "down" as const,
        responseMs: null,
        createdAt: at(inMonth),
      })),
    ];
    if (rows.length) await db.insert(monitorChecks).values(rows);
    return m;
  }

  afterAll(async () => {
    await db.delete(organizations).where(inArray(organizations.id, orgIds));
    await db.delete(users).where(sql`false`);
    await db.delete(jobs).where(sql`${jobs.payload}::text like ${`%${tag}%`}`);
  });
  beforeAll(async () => {
    // Other tests' schedules must not be due in this one.
    await db.update(reportSchedules).set({ enabled: false });
  });

  describe("scheduling", () => {
    test("queues one report per due workspace, once per period", async () => {
      const c = await client();
      expect(await scheduleReports(db, config, NOW)).toBe(1);
      const [row] = await db
        .select()
        .from(reportSchedules)
        .where(eq(reportSchedules.workspaceId, c.ws));
      expect(row!.lastSentPeriod).toBe("2026-10");
      // Same period again, even from another worker: nothing.
      expect(await scheduleReports(db, config, new Date(NOW.getTime() + 3_600_000))).toBe(0);
      // The next month is a new period.
      expect(await scheduleReports(db, config, at("2026-12-01T08:00:00Z"))).toBe(1);
    });

    test("two workers racing claim it once", async () => {
      await db.update(reportSchedules).set({ enabled: false });
      await client();
      const results = await Promise.all([
        scheduleReports(db, config, at("2027-02-01T08:00:00Z")),
        scheduleReports(db, config, at("2027-02-01T08:00:00Z")),
        scheduleReports(db, config, at("2027-02-01T08:00:00Z")),
      ]);
      expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    });

    test("not before it is due, not when switched off, not when the worker is disabled", async () => {
      await db.update(reportSchedules).set({ enabled: false });
      const early = await client();
      expect(await scheduleReports(db, config, at("2027-06-01T06:00:00Z"))).toBe(0);
      expect(
        await scheduleReports(db, { ...config, enabled: false }, at("2027-06-02T09:00:00Z")),
      ).toBe(0);
      const off = await client({ enabled: false });
      expect(await scheduleReports(db, config, at("2027-06-02T09:00:00Z"))).toBe(1);
      const [a] = await db
        .select()
        .from(reportSchedules)
        .where(eq(reportSchedules.workspaceId, early.ws));
      const [b] = await db
        .select()
        .from(reportSchedules)
        .where(eq(reportSchedules.workspaceId, off.ws));
      expect(a!.lastSentPeriod).toBe("2027-05");
      expect(b!.lastSentPeriod).toBeNull();
    });

    test("with plans enforced, only the Agency plan sends, and a plan that can't isn't consumed", async () => {
      const billed: ReportConfig = { ...config, billingEnabled: true };
      await db.update(reportSchedules).set({ enabled: false });
      const pro = await client();
      const agency = await client();
      const lapsed = await client();
      await db.insert(subscriptions).values([
        { organizationId: pro.orgId, plan: "pro", status: "active" },
        { organizationId: agency.orgId, plan: "agency", status: "active" },
        {
          organizationId: lapsed.orgId,
          plan: "agency",
          status: "cancelled",
          trialEndsAt: at("2026-01-01T00:00:00Z"),
        },
      ]);
      const when = at("2027-09-01T08:00:00Z");
      expect(await scheduleReports(db, billed, when)).toBe(1);
      const state = async (ws: string) =>
        (await db.select().from(reportSchedules).where(eq(reportSchedules.workspaceId, ws)))[0]!
          .lastSentPeriod;
      expect(await state(agency.ws)).toBe("2027-08");
      expect(await state(pro.ws)).toBeNull();
      expect(await state(lapsed.ws)).toBeNull();

      // Upgrading later sends the next due report, because nothing was consumed.
      await db
        .update(subscriptions)
        .set({ plan: "agency" })
        .where(eq(subscriptions.organizationId, pro.orgId));
      expect(await scheduleReports(db, billed, at("2027-09-02T08:00:00Z"))).toBe(1);
      expect(await state(pro.ws)).toBe("2027-08");
    });
  });

  describe("the report", () => {
    test("goes to each recipient who hasn't opted out, with correct numbers and a working unsubscribe link", async () => {
      const a = `${tag}-a@example.com`;
      const b = `${tag}-b@example.com`;
      const gone = `${tag}-gone@example.com`;
      const c = await client({ recipients: [a, b, gone] });
      await db
        .update(reportRecipients)
        .set({ unsubscribedAt: new Date() })
        .where(eq(reportRecipients.email, gone));
      await monitorWithChecks(c.ws, "website", 990, 10); // 99.0%
      await monitorWithChecks(c.ws, "api", 1000, 0); // 100%
      // Outside the period: must not count.
      await monitorWithChecks(c.ws, "late", 0, 500, "2026-11-01T12:00:00Z");

      const sent = await handleReport(
        db,
        { kind: "scheduled", workspaceId: c.ws, periodKey: "2026-10" },
        config,
        NOW,
      );
      expect(sent).toBe(2);
      const mail = await emailsTo(a, b, gone);
      expect(mail.map((m) => m.to).sort()).toEqual([a, b].sort());
      const m = mail.find((x) => x.to === a)!;
      expect(m.subject).toBe(`Acme ${seq}: monthly report, October 2026`);
      expect(m.text).toContain("Prepared by Pixel");
      expect(m.text).toContain("- website: 99.00%");
      expect(m.text).toContain("- api: 100.00%");
      // 1990 of 2000 checks were up: 99.50%.
      expect(m.text).toContain("Uptime: 99.50%");
      const link = m.text.match(/Unsubscribe: (\S+)/)![1]!;
      expect(link).toContain(encodeURIComponent(a));
      expect(link).toContain(reportUnsubscribeToken("secret", c.ws, a));
      expect(link).not.toContain(reportUnsubscribeToken("secret", c.ws, b));
      expect(m.template).toBeDefined();
    });

    test("is sent once per period and address even if the job runs twice", async () => {
      const to = `${tag}-once@example.com`;
      const c = await client({ recipients: [to] });
      await monitorWithChecks(c.ws, "site", 10, 0);
      const job = { kind: "scheduled" as const, workspaceId: c.ws, periodKey: "2026-10" };
      await handleReport(db, job, config, NOW);
      await handleReport(db, job, config, NOW);
      expect(await emailsTo(to)).toHaveLength(1);
    });

    test("covers the claimed period even when the job runs after a newer one began", async () => {
      const to = `${tag}-late@example.com`;
      const c = await client({ recipients: [to] });
      await monitorWithChecks(c.ws, "site", 10, 0, "2026-10-10T00:00:00Z");
      await handleReport(
        db,
        { kind: "scheduled", workspaceId: c.ws, periodKey: "2026-10" },
        config,
        at("2026-12-05T09:00:00Z"),
      );
      expect((await emailsTo(to))[0]!.subject).toContain("October 2026");
    });

    test("reports incidents and the security grade, but never what was found", async () => {
      const to = `${tag}-sec@example.com`;
      const c = await client({ recipients: [to] });
      const m = await monitorWithChecks(c.ws, "shop", 100, 0);
      await db.insert(incidents).values({
        workspaceId: c.ws,
        monitorId: m,
        type: "uptime",
        status: "resolved",
        title: "SECRET-INCIDENT-TITLE",
        createdAt: at("2026-10-10T10:00:00Z"),
        resolvedAt: at("2026-10-10T10:30:00Z"),
      } as never);
      const asset = (
        await db
          .insert(assets)
          .values({
            workspaceId: c.ws,
            kind: "domain",
            value: "shop.example.com",
            verificationToken: "t",
            lastScanAt: new Date(),
          })
          .returning({ id: assets.id })
      )[0]!.id;
      await db.insert(findings).values({
        workspaceId: c.ws,
        assetId: asset,
        checkKey: "headers.hsts_missing",
        fingerprint: `${tag}-f`,
        severity: "high",
        riskScore: 10,
        title: "SECRET-FINDING-TITLE",
        description: "SECRET-DESCRIPTION",
        firstSeen: at("2026-10-12T00:00:00Z"),
      });
      await db
        .insert(statusPages)
        .values({ workspaceId: c.ws, slug: `${tag}-sp`, title: "t", published: true });

      await handleReport(
        db,
        { kind: "scheduled", workspaceId: c.ws, periodKey: "2026-10" },
        config,
        NOW,
      );
      const text = (await emailsTo(to))[0]!.text;
      expect(text).toContain("Incidents: 1 opened, 1 resolved, 0 still open, 30 min of downtime");
      expect(text).toContain("Security: grade");
      expect(text).toContain("1 new, 0 open".replace("0 open", "1 open"));
      expect(text).toContain(`https://app.example.com/status/${tag}-sp`);
      for (const secret of [
        "SECRET-INCIDENT-TITLE",
        "SECRET-FINDING-TITLE",
        "SECRET-DESCRIPTION",
        "shop.example.com",
      ])
        expect(text).not.toContain(secret);
    });

    test("a workspace with no monitors sends nothing", async () => {
      const to = `${tag}-empty@example.com`;
      const c = await client({ recipients: [to] });
      expect(
        await handleReport(
          db,
          { kind: "scheduled", workspaceId: c.ws, periodKey: "2026-10" },
          config,
          NOW,
        ),
      ).toBe(0);
      expect(await emailsTo(to)).toHaveLength(0);
    });

    test("a test report goes only to the address asked for, as often as asked, ignoring opt-outs and the schedule", async () => {
      const client1 = `${tag}-realclient@example.com`;
      const me = `${tag}-me@example.com`;
      const c = await client({ recipients: [client1], enabled: false });
      await monitorWithChecks(c.ws, "site", 10, 0);
      await handleReport(db, { kind: "test", workspaceId: c.ws, to: me }, config, NOW);
      await handleReport(db, { kind: "test", workspaceId: c.ws, to: me }, config, NOW);
      expect(await emailsTo(me)).toHaveLength(2);
      expect(await emailsTo(client1)).toHaveLength(0);
    });

    test("weekly reports cover the last Monday to Sunday", async () => {
      const to = `${tag}-weekly@example.com`;
      const c = await client({ recipients: [to], frequency: "weekly" });
      await monitorWithChecks(c.ws, "site", 20, 0, "2026-10-28T12:00:00Z");
      await handleReport(
        db,
        { kind: "scheduled", workspaceId: c.ws, periodKey: "2026-10-26" },
        config,
        at("2026-11-02T09:00:00Z"),
      );
      const m = (await emailsTo(to))[0]!;
      expect(m.subject).toBe(`Acme ${seq}: weekly report, 26 October to 1 November 2026`);
      expect(m.text).toContain("Uptime: 100.00%");
    });
  });
});
