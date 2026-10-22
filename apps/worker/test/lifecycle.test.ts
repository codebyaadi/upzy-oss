import { afterAll, describe, expect, test } from "bun:test";

import { validUnsubscribeToken } from "@upzy/auth/unsubscribe";
import { createDb, schema } from "@upzy/db";
import { eq, inArray, like, sql } from "drizzle-orm";

import { parseLifecycle, sendLifecycleEmails, type LifecycleConfig } from "../src/roles/lifecycle";

describe("lifecycle settings", () => {
  test("on by default when there is a secret, off without one or when switched off", () => {
    expect(parseLifecycle({ BETTER_AUTH_SECRET: "s" }).enabled).toBe(true);
    expect(parseLifecycle({}).enabled).toBe(false);
    expect(parseLifecycle({ BETTER_AUTH_SECRET: "s", LIFECYCLE_EMAILS: "off" }).enabled).toBe(
      false,
    );
    expect(parseLifecycle({ BETTER_AUTH_SECRET: "s", LIFECYCLE_EMAILS: "false" }).enabled).toBe(
      false,
    );
  });

  test("links point at the configured web app and API", () => {
    const c = parseLifecycle({
      BETTER_AUTH_SECRET: "s",
      APP_URL: "https://app.example.com/",
      BETTER_AUTH_URL: "https://api.example.com",
    });
    expect(c.appUrl).toBe("https://app.example.com");
    expect(c.apiUrl).toBe("https://api.example.com");
  });
});

const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run("lifecycle emails (postgres)", () => {
  const db = createDb(url);
  const { users, organizations, members, workspaces, assets, findings, subscriptions, jobs } =
    schema;
  const tag = `lc${Date.now()}`;
  const NOW = new Date("2026-11-10T12:00:00Z");
  const MIN = 60_000;
  const DAY = 86_400_000;
  const ago = (ms: number) => new Date(NOW.getTime() - ms);
  const config: LifecycleConfig = {
    enabled: true,
    appUrl: "https://app.example.com",
    apiUrl: "https://api.example.com",
    secret: "secret",
    trialWarnDays: 3,
  };
  const userIds: string[] = [];
  const orgIds: string[] = [];

  const user = async (
    name: string,
    createdAt: Date,
    over: Partial<typeof users.$inferInsert> = {},
  ) => {
    const id = `${tag}-${name}`;
    userIds.push(id);
    await db
      .insert(users)
      .values({ id, name: `${name} Person`, email: `${id}@example.com`, createdAt, ...over });
    return id;
  };
  const org = async (name: string, ...people: [string, string][]) => {
    const id = `${tag}-org-${name}`;
    orgIds.push(id);
    await db
      .insert(organizations)
      .values({ id, name: `Org ${name}`, slug: id, createdAt: new Date() });
    for (const [userId, role] of people)
      await db.insert(members).values({
        id: `${id}-${userId}`,
        organizationId: id,
        userId,
        role,
        createdAt: new Date(),
      });
    const ws = (
      await db.insert(workspaces).values({ orgId: id, name: "w" }).returning({ id: workspaces.id })
    )[0]!.id;
    return { id, ws };
  };
  const finding = async (
    ws: string,
    over: Partial<typeof findings.$inferInsert> = {},
    domain = "example.com",
  ) => {
    const asset = (
      await db
        .insert(assets)
        .values({ workspaceId: ws, kind: "domain", value: domain, verificationToken: "t" })
        .returning({ id: assets.id })
    )[0]!.id;
    await db.insert(findings).values({
      workspaceId: ws,
      assetId: asset,
      checkKey: "headers.hsts_missing",
      fingerprint: `${tag}-${Math.random()}`,
      severity: "high",
      riskScore: 50,
      title: "HSTS is missing",
      description: "d",
      remediation: "Add the Strict-Transport-Security header.",
      ...over,
    });
  };

  /** The emails queued for these users, as {to, subject, text}. */
  const queued = async (...ids: string[]) => {
    const rows = await db
      .select({ payload: jobs.payload })
      .from(jobs)
      .where(eq(jobs.queue, "email"));
    const want = new Set(ids.map((i) => `${i}@example.com`));
    return rows
      .map((r) => r.payload as { to: string; subject: string; text: string })
      .filter((p) => want.has(p.to));
  };

  afterAll(async () => {
    await db.delete(organizations).where(inArray(organizations.id, orgIds));
    await db.delete(users).where(inArray(users.id, userIds));
    await db.delete(schema.lifecycleEmails).where(like(schema.lifecycleEmails.subject, `${tag}%`));
    await db.delete(jobs).where(sql`${jobs.payload}::text like ${`%${tag}%`}`);
  });

  describe("welcome", () => {
    test("goes to a new user after a few minutes, once, with a working unsubscribe link", async () => {
      const id = await user("welcome", ago(15 * MIN));
      const r1 = await sendLifecycleEmails(db, config, NOW);
      expect(r1.welcome).toBeGreaterThanOrEqual(1);
      const again = await sendLifecycleEmails(db, config, new Date(NOW.getTime() + 15 * MIN));
      expect(again.welcome).toBe(0);

      const mail = await queued(id);
      expect(mail).toHaveLength(1);
      expect(mail[0]!.subject).toBe("Welcome to Upzy");
      expect(mail[0]!.text).toContain("Hi welcome,");
      expect(mail[0]!.text).toContain("https://app.example.com/get-started");
      const link = mail[0]!.text.match(
        /https:\/\/api\.example\.com\/lifecycle\/unsubscribe\?u=([^&\s]+)&t=([0-9a-f]+)/,
      );
      expect(link).not.toBeNull();
      expect(decodeURIComponent(link![1]!)).toBe(id);
      expect(validUnsubscribeToken("secret", id, link![2]!)).toBe(true);
    });

    test("waits for the first few minutes and skips old accounts and people who opted out", async () => {
      const fresh = await user("fresh", ago(2 * MIN));
      const old = await user("old", ago(5 * DAY));
      const optedOut = await user("optout", ago(15 * MIN), { lifecycleEmails: false });
      await sendLifecycleEmails(db, config, NOW);
      const welcomeMail = (await queued(fresh, old, optedOut)).filter((m) =>
        m.subject.startsWith("Welcome"),
      );
      expect(welcomeMail).toHaveLength(0);
    });

    test("does nothing when disabled", async () => {
      const id = await user("disabled", ago(20 * MIN));
      const r = await sendLifecycleEmails(db, { ...config, enabled: false }, NOW);
      expect(r).toEqual({ welcome: 0, fixNudge: 0, trialEnding: 0 });
      expect(await queued(id)).toHaveLength(0);
    });
  });

  describe("fix nudge", () => {
    const nudges = async (...ids: string[]) =>
      (await queued(...ids)).filter((m) => m.subject.startsWith("Your first fix"));

    test("two days in, names the most serious open finding, once", async () => {
      const id = await user("nudge", ago(3 * DAY));
      const o = await org("nudge", [id, "owner"]);
      await finding(
        o.ws,
        { title: "Minor thing", severity: "medium", riskScore: 10 },
        "a.example.com",
      );
      await finding(
        o.ws,
        { title: "Open database port", severity: "critical", riskScore: 95 },
        "b.example.com",
      );
      await finding(o.ws, { title: "Info only", severity: "info", riskScore: 99 }, "c.example.com");

      await sendLifecycleEmails(db, config, NOW);
      await sendLifecycleEmails(db, config, NOW);
      const mail = await nudges(id);
      expect(mail).toHaveLength(1);
      expect(mail[0]!.subject).toBe("Your first fix: Open database port");
      expect(mail[0]!.text).toContain("b.example.com");
      expect(mail[0]!.text).toContain("Strict-Transport-Security");
      expect(mail[0]!.text).toContain("https://app.example.com/findings");
    });

    test("is not sent when there is nothing to fix, when something is already fixed, or too early", async () => {
      const none = await user("nofind", ago(3 * DAY));
      await org("nofind", [none, "owner"]);

      const fixed = await user("fixed", ago(3 * DAY));
      const fo = await org("fixed", [fixed, "owner"]);
      await finding(fo.ws, { status: "resolved", resolvedAt: ago(DAY) }, "d.example.com");
      await finding(fo.ws, {}, "e.example.com");

      const early = await user("early", ago(1 * DAY));
      const eo = await org("early", [early, "owner"]);
      await finding(eo.ws, {}, "f.example.com");

      const lowOnly = await user("lowonly", ago(3 * DAY));
      const lo = await org("lowonly", [lowOnly, "owner"]);
      await finding(lo.ws, { severity: "low", riskScore: 5 }, "g.example.com");

      await sendLifecycleEmails(db, config, NOW);
      expect(await nudges(none, fixed, early, lowOnly)).toHaveLength(0);
    });

    test("never reads another organization's findings", async () => {
      const mine = await user("mine", ago(3 * DAY));
      await org("mine", [mine, "owner"]);
      const theirs = await user("theirs", ago(40 * DAY));
      const to = await org("theirs", [theirs, "owner"]);
      await finding(to.ws, { title: "Someone else's problem" }, "h.example.com");
      await sendLifecycleEmails(db, config, NOW);
      expect(await nudges(mine)).toHaveLength(0);
    });
  });

  describe("trial ending", () => {
    const trial = async (
      name: string,
      ends: Date,
      over: Partial<typeof subscriptions.$inferInsert> = {},
    ) => {
      const owner = await user(`${name}-owner`, ago(10 * DAY));
      const admin = await user(`${name}-admin`, ago(10 * DAY));
      const member = await user(`${name}-member`, ago(10 * DAY));
      const quiet = await user(`${name}-quiet`, ago(10 * DAY), { lifecycleEmails: false });
      const o = await org(
        name,
        [owner, "owner"],
        [admin, "admin"],
        [member, "member"],
        [quiet, "admin"],
      );
      await db.insert(subscriptions).values({ organizationId: o.id, trialEndsAt: ends, ...over });
      return { owner, admin, member, quiet };
    };
    const trialMail = async (...ids: string[]) =>
      (await queued(...ids)).filter((m) => m.subject.includes("trial ends"));

    test("tells owners and admins who haven't opted out, once, how long is left", async () => {
      const p = await trial("ends", new Date(NOW.getTime() + 2 * DAY - MIN));
      const r = await sendLifecycleEmails(db, config, NOW);
      expect(r.trialEnding).toBeGreaterThanOrEqual(2);
      await sendLifecycleEmails(db, config, new Date(NOW.getTime() + 6 * 3_600_000));

      expect(await trialMail(p.owner)).toHaveLength(1);
      expect(await trialMail(p.admin)).toHaveLength(1);
      expect(await trialMail(p.member)).toHaveLength(0);
      expect(await trialMail(p.quiet)).toHaveLength(0);
      const [m] = await trialMail(p.owner);
      expect(m!.subject).toBe("Your Upzy trial ends in 2 days");
      expect(m!.text).toContain("Org ends");
      expect(m!.text).toContain("https://app.example.com/settings/billing");
    });

    test("says '1 day' on the last day", async () => {
      const p = await trial("last", new Date(NOW.getTime() + 5 * 3_600_000));
      await sendLifecycleEmails(db, config, NOW);
      expect((await trialMail(p.owner))[0]!.subject).toBe("Your Upzy trial ends in 1 day");
    });

    test("is not sent too early, after it ended, or to organizations that already pay", async () => {
      const far = await trial("far", new Date(NOW.getTime() + 9 * DAY));
      const over = await trial("over", new Date(NOW.getTime() - DAY));
      const paid = await trial("paid", new Date(NOW.getTime() + 2 * DAY), {
        plan: "pro",
        status: "active",
      });
      await sendLifecycleEmails(db, config, NOW);
      expect(await trialMail(far.owner, over.owner, paid.owner)).toHaveLength(0);
    });

    test("an organization on a cancelled plan with trial left still gets it", async () => {
      const p = await trial("cancelled", new Date(NOW.getTime() + 2 * DAY), {
        plan: "pro",
        status: "cancelled",
      });
      await sendLifecycleEmails(db, config, NOW);
      expect(await trialMail(p.owner)).toHaveLength(1);
    });
  });
});
