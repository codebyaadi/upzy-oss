import { expect, test } from "bun:test";

import { verifyWebhook } from "@upzy/crypto";

import {
  deliver,
  subjectFor,
  textFor,
  type FindingNotification,
  type IncidentNotification,
  type Poster,
} from "../src";

const n: IncidentNotification = {
  event: "incident.opened",
  incident: {
    id: "i1",
    title: "api is down: Unexpected status 500",
    openedAt: "2026-01-01T00:00:00Z",
    resolvedAt: null,
  },
  monitor: { id: "m1", name: "api", target: "https://api.example.com" },
  url: "https://app.upzy.dev/incidents/i1",
};

const capture = () => {
  const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
  const post: Poster = async (url, body, headers) => (
    calls.push({ url, body, headers }),
    { status: 200 }
  );
  return { calls, post };
};

test("slack payload carries the title and link", async () => {
  const { calls, post } = capture();
  await deliver({ kind: "slack", url: "https://hooks.slack.com/x" }, n, { post });
  expect(JSON.parse(calls[0]!.body).text).toContain("api is down");
  expect(JSON.parse(calls[0]!.body).text).toContain(n.url);
});

test("discord disables mentions", async () => {
  const { calls, post } = capture();
  await deliver({ kind: "discord", url: "https://discord.com/api/webhooks/x" }, n, { post });
  expect(JSON.parse(calls[0]!.body).allowed_mentions).toEqual({ parse: [] });
});

test("webhook is signed and verifiable", async () => {
  const { calls, post } = capture();
  await deliver({ kind: "webhook", url: "https://example.com/hook", secret: "whsec_test" }, n, {
    post,
  });
  const { body, headers } = calls[0]!;
  expect(verifyWebhook("whsec_test", body, headers["upzy-signature"]!)).toBe(true);
  expect(JSON.parse(body).type).toBe("incident.opened");
});

test("non-2xx responses throw so the job retries", async () => {
  const post: Poster = async () => ({ status: 500 });
  await expect(
    deliver({ kind: "slack", url: "https://hooks.slack.com/x" }, n, { post }),
  ).rejects.toThrow(/HTTP 500/);
});

test("email requires a configured sender", async () => {
  await expect(deliver({ kind: "email", to: "a@b.co" }, n)).rejects.toThrow(/not configured/);
  const sent: unknown[] = [];
  await deliver({ kind: "email", to: "a@b.co" }, n, { email: async (m) => void sent.push(m) });
  expect(sent).toHaveLength(1);
});

const f: FindingNotification = {
  event: "finding.opened",
  finding: {
    id: "f1",
    title: "TLS certificate has expired",
    severity: "critical",
    checkKey: "tls.cert_expired",
    firstSeen: "2026-01-01T00:00:00Z",
  },
  asset: { id: "a1", value: "shop.example.com" },
  url: "https://app.upzy.dev/findings/f1",
};

test("finding notifications name the asset, severity and link", () => {
  expect(subjectFor(f)).toBe("[Security: Critical] TLS certificate has expired");
  expect(textFor(f)).toContain("shop.example.com");
  expect(textFor(f)).toContain(f.url);
});

test("finding webhooks are signed and typed", async () => {
  const { calls, post } = capture();
  await deliver({ kind: "webhook", url: "https://example.com/hook", secret: "whsec_test" }, f, {
    post,
  });
  const { body, headers } = calls[0]!;
  expect(verifyWebhook("whsec_test", body, headers["upzy-signature"]!)).toBe(true);
  expect(JSON.parse(body)).toMatchObject({
    type: "finding.opened",
    data: { finding: { id: "f1" }, asset: { value: "shop.example.com" } },
  });
});

test("finding email goes through the sender with a security subject", async () => {
  const sent: { subject: string }[] = [];
  await deliver({ kind: "email", to: "a@b.co" }, f, { email: async (m) => void sent.push(m) });
  expect(sent[0]!.subject).toContain("Security");
});
