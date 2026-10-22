import { describe, expect, test } from "bun:test";

import { compose, renderHtml, templates, type TemplateName, type TemplateProps } from "../src";

const sample: TemplateProps = {
  invitation: { organization: "Acme", inviter: "Ada", role: "admin", url: "https://app/inv/1" },
  resetPassword: { name: "Ada", url: "https://app/reset?t=1" },
  verifyEmail: { name: "Ada", url: "https://api/verify?t=1" },
  statusConfirm: { page: "Acme status", url: "https://app/subscription/t" },
  statusNotice: {
    page: "Acme status",
    headline: "Acme status is having problems",
    stage: "Investigating",
    message: "Looking into it.",
    pageUrl: "https://status.acme.test",
    unsubscribeUrl: "https://app/subscription/t",
  },
  welcome: { name: "Ada", appUrl: "https://app", unsubscribeUrl: "https://api/u?t=1" },
  fixNudge: {
    name: "Ada",
    findingTitle: "HSTS is missing",
    asset: "example.com",
    severity: "high",
    remediation: "Add the header.",
    findingUrl: "https://app/findings",
    unsubscribeUrl: "https://api/u?t=1",
  },
  trialEnding: {
    name: "Ada",
    organization: "Acme",
    daysLeft: 2,
    billingUrl: "https://app/settings/billing",
    unsubscribeUrl: "https://api/u?t=1",
  },
  alert: {
    subject: "[Down] API",
    emoji: "🔴",
    tone: "down",
    line1: "API is down",
    line2: "https://api.example.com",
    url: "https://app/incidents/1",
  },
  weeklyDigest: {
    workspace: "Prod",
    periodStart: "2026-10-05",
    periodEnd: "2026-10-11",
    narrative: {
      headline: "A quiet week",
      summary: "Ada, all up.",
      highlights: ["a"],
      actions: ["do x"],
    },
    monitors: [{ name: "API", uptime: "99.95%", avgMs: 120, checks: 10 }],
    incidents: { opened: 1, resolved: 1, stillOpen: 0, totalDowntimeMinutes: 5 },
    findings: {
      new: 1,
      resolved: 0,
      open: 1,
      topOpen: [{ severity: "high", title: "HSTS", asset: "example.com" }],
    },
    dashboardUrl: "https://app/monitors",
  },
  accountDeleted: { name: "Ada" },
  organizationDeleted: { name: "Ada", organization: "Acme", by: "Grace" },
};
const names = Object.keys(sample) as TemplateName[];

describe("every template", () => {
  test("has sample props in this test (so a new template can't skip being checked)", () => {
    expect([...names].sort()).toEqual(Object.keys(templates).sort() as TemplateName[]);
  });

  for (const name of names) {
    test(`${name}: renders branded HTML with its links, and a text fallback`, async () => {
      const mail = compose(name, "a@b.co", sample[name] as never);
      const html = await renderHtml(mail.template.name, mail.template.props);

      expect(mail.to).toBe("a@b.co");
      expect(mail.subject.length).toBeGreaterThan(3);
      expect(mail.text.length).toBeGreaterThan(20);
      expect(html.startsWith("<!DOCTYPE html")).toBe(true);
      expect(html).toContain("#0f3d3a"); // brand colour from the style guide
      expect(html).toContain("Upzy");
      // The logo is fetched from the web app, so it has to point at the configured one.
      expect(html).toContain("/email/logo.png");

      // Every URL in the text version is also a link in the HTML one.
      for (const [url] of mail.text.matchAll(/https:\/\/[^\s)]+/g))
        expect(html).toContain(url.replace(/&/g, "&amp;"));
    });
  }
});

describe("composing", () => {
  test("lifecycle and status emails carry a List-Unsubscribe header, account mail does not", () => {
    for (const name of ["welcome", "fixNudge", "trialEnding", "statusNotice"] as const) {
      const m = compose(name, "a@b.co", sample[name] as never);
      expect(m.headers?.["List-Unsubscribe"]).toMatch(/^<https:\/\/.+>$/);
    }
    for (const name of ["resetPassword", "verifyEmail", "invitation", "accountDeleted"] as const)
      expect(compose(name, "a@b.co", sample[name] as never).headers).toBeUndefined();
  });

  test("subjects read well, including singular and plural days", () => {
    expect(compose("invitation", "x", sample.invitation).subject).toBe(
      "Ada invited you to Acme on Upzy",
    );
    expect(compose("trialEnding", "x", { ...sample.trialEnding, daysLeft: 1 }).subject).toBe(
      "Your Upzy trial ends in 1 day",
    );
    expect(compose("trialEnding", "x", sample.trialEnding).subject).toBe(
      "Your Upzy trial ends in 2 days",
    );
    expect(compose("invitation", "x", sample.invitation).text).toContain("as an admin");
  });

  test("HTML escapes what people typed, so a name can't inject markup", async () => {
    const html = await renderHtml("welcome", {
      ...sample.welcome,
      name: "<script>alert(1)</script>",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("the logo comes from the configured app URL", async () => {
    const html = await renderHtml(
      "accountDeleted",
      { name: "Ada" },
      { appUrl: "https://app.example.com/" },
    );
    expect(html).toContain("https://app.example.com/email/logo.png");
  });

  test("an unknown template is refused rather than sending an empty email", async () => {
    await expect(renderHtml("nope" as never, {})).rejects.toThrow(/Unknown email template/);
  });
});
