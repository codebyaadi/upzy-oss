import { describe, expect, test } from "bun:test";

import { deliver, type FindingNotification, type IncidentNotification, type Poster } from "../src";

const opened: IncidentNotification = {
  event: "incident.opened",
  incident: {
    id: "i1",
    title: "api is down: Unexpected status 500",
    openedAt: "2026-10-01T10:00:00Z",
    resolvedAt: null,
  },
  monitor: { id: "m1", name: "api", target: "https://api.example.com" },
  url: "https://app.example.com/incidents/i1",
};
const resolved: IncidentNotification = {
  ...opened,
  event: "incident.resolved",
  incident: { ...opened.incident, resolvedAt: "2026-10-01T10:30:00Z" },
};
const test_: IncidentNotification = {
  ...opened,
  incident: { ...opened.incident, id: "test", title: "Test notification from Upzy" },
};
const finding = (severity: string): FindingNotification => ({
  event: "finding.opened",
  finding: {
    id: "f1",
    title: "TLS certificate has expired",
    severity,
    checkKey: "tls.cert_expired",
    firstSeen: "2026-10-01T10:00:00Z",
  },
  asset: { id: "a1", value: "shop.example.com" },
  url: "https://app.example.com/findings/f1",
});

type Call = {
  url: string;
  body: any;
  headers: Record<string, string>;
  method?: string;
};
function recorder(reply: (c: Call) => { status: number; body?: string } = () => ({ status: 200 })) {
  const calls: Call[] = [];
  const post: Poster = async (url, body, headers, method) => {
    const c = { url, body: body ? JSON.parse(body) : undefined, headers, method };
    calls.push(c);
    return reply(c);
  };
  return { calls, post };
}

describe("Microsoft Teams", () => {
  const cfg = { kind: "teams", url: "https://contoso.webhook.office.com/webhookb2/abc" } as const;

  test("posts an adaptive card with the title, the detail and a link back", async () => {
    const { calls, post } = recorder();
    await deliver(cfg, opened, { post });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(cfg.url);
    const card = calls[0]!.body.attachments[0];
    expect(card.contentType).toBe("application/vnd.microsoft.card.adaptive");
    expect(card.content.type).toBe("AdaptiveCard");
    expect(card.content.body[0]).toMatchObject({ text: "[Down] api", color: "Attention" });
    expect(card.content.body[1].text).toContain("api.example.com");
    expect(card.content.actions[0]).toMatchObject({ type: "Action.OpenUrl", url: opened.url });
  });

  test("a recovery is green, and a medium finding is a warning", async () => {
    const { calls, post } = recorder();
    await deliver(cfg, resolved, { post });
    await deliver(cfg, finding("medium"), { post });
    expect(calls[0]!.body.attachments[0].content.body[0]).toMatchObject({
      text: "[Recovered] api",
      color: "Good",
    });
    expect(calls[1]!.body.attachments[0].content.body[0].color).toBe("Warning");
  });

  test("a refusal throws so the job retries", async () => {
    const { post } = recorder(() => ({ status: 400 }));
    await expect(deliver(cfg, opened, { post })).rejects.toThrow(/Microsoft Teams.*400/);
  });
});

describe("PagerDuty", () => {
  const cfg = { kind: "pagerduty", routingKey: "R0UT1NGK3Y0123456789abcdefghijkl" } as const;

  test("an outage triggers an event on the Events API with a stable dedup key", async () => {
    const { calls, post } = recorder();
    await deliver(cfg, opened, { post });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://events.pagerduty.com/v2/enqueue");
    expect(calls[0]!.body).toMatchObject({
      routing_key: cfg.routingKey,
      event_action: "trigger",
      dedup_key: "upzy-incident-i1",
      payload: { severity: "critical", source: "https://api.example.com" },
      links: [{ href: opened.url }],
    });
    expect(calls[0]!.body.payload.summary).toContain("[Down] api");
  });

  test("the recovery resolves the same dedup key", async () => {
    const { calls, post } = recorder();
    await deliver(cfg, resolved, { post });
    expect(calls[0]!.body).toEqual({
      routing_key: cfg.routingKey,
      event_action: "resolve",
      dedup_key: "upzy-incident-i1",
    });
  });

  test("finding severity maps to PagerDuty severity, and the dedup key is the finding's", async () => {
    const { calls, post } = recorder();
    for (const s of ["critical", "high", "medium", "low"]) await deliver(cfg, finding(s), { post });
    expect(calls.map((c) => c.body.payload.severity)).toEqual([
      "critical",
      "error",
      "warning",
      "info",
    ]);
    expect(calls[0]!.body.dedup_key).toBe("upzy-finding-f1");
    expect(calls[0]!.body.payload.source).toBe("shop.example.com");
  });

  test("a test triggers and immediately resolves, leaving nothing open", async () => {
    const { calls, post } = recorder();
    await deliver(cfg, test_, { post });
    expect(calls.map((c) => c.body.event_action)).toEqual(["trigger", "resolve"]);
    expect(calls[0]!.body.dedup_key).toBe(calls[1]!.body.dedup_key);
  });

  test("a failure throws", async () => {
    const { post } = recorder(() => ({ status: 429 }));
    await expect(deliver(cfg, opened, { post })).rejects.toThrow(/PagerDuty.*429/);
  });
});

describe("Opsgenie", () => {
  const us = {
    kind: "opsgenie",
    apiKey: "abcdef12-3456-7890-abcd-ef1234567890",
    region: "us",
  } as const;

  test("an outage creates an alert with the key in the authorization header", async () => {
    const { calls, post } = recorder();
    await deliver(us, opened, { post });
    expect(calls[0]!.url).toBe("https://api.opsgenie.com/v2/alerts");
    expect(calls[0]!.headers.authorization).toBe(`GenieKey ${us.apiKey}`);
    expect(calls[0]!.body).toMatchObject({
      alias: "upzy-incident-i1",
      priority: "P1",
      source: "Upzy",
      details: { url: opened.url },
    });
    expect(calls[0]!.body.message).toBe("[Down] api");
  });

  test("the message is cut to the 130 characters Opsgenie allows", async () => {
    const { calls, post } = recorder();
    const long = { ...opened, monitor: { ...opened.monitor, name: "x".repeat(300) } };
    await deliver(us, long, { post });
    expect(calls[0]!.body.message.length).toBeLessThanOrEqual(130);
  });

  test("the EU region uses the EU host", async () => {
    const { calls, post } = recorder();
    await deliver({ ...us, region: "eu" }, opened, { post });
    expect(calls[0]!.url).toBe("https://api.eu.opsgenie.com/v2/alerts");
  });

  test("the recovery closes the alert by alias", async () => {
    const { calls, post } = recorder();
    await deliver(us, resolved, { post });
    expect(calls[0]!.url).toBe(
      "https://api.opsgenie.com/v2/alerts/upzy-incident-i1/close?identifierType=alias",
    );
    expect(calls[0]!.body).toMatchObject({ source: "Upzy", note: "Recovered" });
  });

  test("findings: critical is P1, high P2, the rest P3; a test opens then closes", async () => {
    const { calls, post } = recorder();
    for (const s of ["critical", "high", "medium"]) await deliver(us, finding(s), { post });
    expect(calls.map((c) => c.body.priority)).toEqual(["P1", "P2", "P3"]);
    const t = recorder();
    await deliver(us, test_, { post: t.post });
    expect(t.calls).toHaveLength(2);
    expect(t.calls[1]!.url).toContain("/close");
  });
});

describe("GitHub issues", () => {
  const cfg = { kind: "github", repo: "acme/web", token: "ghp_exampletoken1234567890" } as const;
  const created = (n: number) => () => ({ status: 201, body: JSON.stringify({ number: n }) });

  test("an outage opens an issue and reports its number", async () => {
    const { calls, post } = recorder(created(42));
    const r = await deliver(cfg, opened, { post });
    expect(r).toEqual({ externalId: "42" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.github.com/repos/acme/web/issues");
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${cfg.token}`);
    expect(calls[0]!.headers.accept).toBe("application/vnd.github+json");
    expect(calls[0]!.body.title).toBe("[Down] api");
    expect(calls[0]!.body.labels).toEqual(["upzy", "incident"]);
    expect(calls[0]!.body.body).toContain(opened.url);
  });

  test("the recovery comments on that issue and closes it", async () => {
    const { calls, post } = recorder();
    await deliver(cfg, resolved, { post, previousExternalId: "42" });
    expect(calls.map((c) => [c.method ?? "POST", c.url])).toEqual([
      ["POST", "https://api.github.com/repos/acme/web/issues/42/comments"],
      ["PATCH", "https://api.github.com/repos/acme/web/issues/42"],
    ]);
    expect(calls[0]!.body.body).toContain("Recovered");
    expect(calls[1]!.body).toEqual({ state: "closed", state_reason: "completed" });
  });

  test("a recovery with no issue to close does nothing", async () => {
    const { calls, post } = recorder();
    expect(await deliver(cfg, resolved, { post })).toEqual({});
    expect(calls).toHaveLength(0);
  });

  test("a finding opens a labelled issue that is not auto-closed", async () => {
    const { calls, post } = recorder(created(7));
    const r = await deliver(cfg, finding("high"), { post });
    expect(r).toEqual({ externalId: "7" });
    expect(calls[0]!.body.title).toBe("[Security: High] TLS certificate has expired");
    expect(calls[0]!.body.labels).toEqual(["upzy", "security"]);
    expect(calls[0]!.body.body).toContain("shop.example.com");
  });

  test("a test opens an issue and closes it straight away", async () => {
    const { calls, post } = recorder((c) =>
      c.method === "PATCH" || c.url.endsWith("/comments") ? { status: 200 } : created(9)(),
    );
    await deliver(cfg, test_, { post });
    expect(calls).toHaveLength(3);
    expect(calls[0]!.body.title).toBe("Upzy test notification");
    expect(calls[2]!.method).toBe("PATCH");
  });

  test("a response without a number still succeeds, without an id to close later", async () => {
    const { post } = recorder(() => ({ status: 201, body: "not json" }));
    expect(await deliver(cfg, opened, { post })).toEqual({});
  });

  test("a bad token or repo (401, 404) throws so the failure shows on the delivery", async () => {
    for (const status of [401, 403, 404]) {
      const { post } = recorder(() => ({ status }));
      await expect(deliver(cfg, opened, { post })).rejects.toThrow(new RegExp(`GitHub.*${status}`));
    }
  });
});
