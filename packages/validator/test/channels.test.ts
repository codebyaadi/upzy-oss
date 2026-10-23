import { describe, expect, test } from "bun:test";

import { CreateChannelSchema } from "../src";

const ws = "00000000-0000-4000-8000-000000000001";
const parse = (o: object) => CreateChannelSchema.safeParse({ workspaceId: ws, name: "ops", ...o });

describe("Microsoft Teams channel", () => {
  test("accepts webhook and workflow URLs on Microsoft's hosts", () => {
    for (const url of [
      "https://contoso.webhook.office.com/webhookb2/abc@def/IncomingWebhook/x/y",
      "https://outlook.office.com/webhook/abc",
      "https://prod-12.westeurope.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke",
      "https://acme.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/x/triggers/manual/paths/invoke",
    ])
      expect(parse({ kind: "teams", url }).success, url).toBe(true);
  });

  test("refuses other hosts, plain http, look-alike hosts and private addresses", () => {
    for (const url of [
      "http://contoso.webhook.office.com/x",
      "https://evil.example.com/webhook.office.com",
      "https://webhook.office.com.evil.example/x",
      "https://notwebhook.office.com.attacker.io/x",
      "https://169.254.169.254/latest",
      "https://localhost/x",
      "not a url",
    ])
      expect(parse({ kind: "teams", url }).success, url).toBe(false);
  });
});

describe("PagerDuty channel", () => {
  test("needs a 32-character integration key", () => {
    expect(parse({ kind: "pagerduty", routingKey: "a".repeat(32) }).success).toBe(true);
    expect(parse({ kind: "pagerduty", routingKey: `  ${"B1".repeat(16)}  ` }).success).toBe(true);
    for (const routingKey of ["", "short", "a".repeat(31), "a".repeat(33), `${"a".repeat(31)}-`])
      expect(parse({ kind: "pagerduty", routingKey }).success, routingKey).toBe(false);
  });
});

describe("Opsgenie channel", () => {
  const apiKey = "abcdef12-3456-7890-abcd-ef1234567890";
  test("takes a key and a region, defaulting to the US", () => {
    const r = parse({ kind: "opsgenie", apiKey });
    expect(r.success && r.data).toMatchObject({ region: "us" });
    expect(parse({ kind: "opsgenie", apiKey, region: "eu" }).success).toBe(true);
    expect(parse({ kind: "opsgenie", apiKey, region: "asia" }).success).toBe(false);
  });
  test("refuses things that aren't keys", () => {
    for (const k of ["", "short", "has spaces in the key 12345678", "x".repeat(65), "key;rm -rf /"])
      expect(parse({ kind: "opsgenie", apiKey: k }).success, k).toBe(false);
  });
});

describe("GitHub channel", () => {
  const token = "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz";
  test("takes owner/name and a token", () => {
    expect(parse({ kind: "github", repo: "acme/web", token }).success).toBe(true);
    expect(
      parse({ kind: "github", repo: "my-org/my.repo_1", token: "ghp_" + "a".repeat(36) }).success,
    ).toBe(true);
  });
  test("refuses repository values that could point somewhere else", () => {
    for (const repo of [
      "acme",
      "acme/web/extra",
      "/web",
      "acme/",
      "https://github.com/acme/web",
      "acme/web?x=1",
      "../acme/web",
      "acme/web#frag",
      "acme /web",
    ])
      expect(parse({ kind: "github", repo, token }).success, repo).toBe(false);
  });
  test("refuses tokens that are too short or contain odd characters", () => {
    for (const t of ["", "short", "ghp_ has space xxxxxxxxxxxxxxxxxx", "a".repeat(300)])
      expect(parse({ kind: "github", repo: "acme/web", token: t }).success, t).toBe(false);
  });
});

describe("existing channels are unchanged", () => {
  test("email, Slack, Discord and webhook still validate as before", () => {
    expect(parse({ kind: "email", to: "a@b.co" }).success).toBe(true);
    expect(parse({ kind: "slack", url: "https://hooks.slack.com/services/T/B/x" }).success).toBe(
      true,
    );
    expect(parse({ kind: "slack", url: "https://example.com/services/T/B/x" }).success).toBe(false);
    expect(parse({ kind: "discord", url: "https://discord.com/api/webhooks/1/x" }).success).toBe(
      true,
    );
    expect(parse({ kind: "webhook", url: "https://example.com/hook" }).success).toBe(true);
    expect(parse({ kind: "webhook", url: "http://10.0.0.1/hook" }).success).toBe(false);
  });
  test("an unknown kind is refused", () => {
    expect(parse({ kind: "telegram", url: "https://t.me/x" }).success).toBe(false);
  });
});
