import type { Notification } from "./index";

/** What a provider needs from the notifier: a way to send a request and read what came back. */
export type Send = (
  url: string,
  body: string,
  headers: Record<string, string>,
  method?: "POST" | "PATCH",
) => Promise<{ status: number; body?: string }>;

export interface DeliverResult {
  /** A reference to what was created at the provider (a GitHub issue number), kept so the recovery can find it. */
  externalId?: string;
}

const ok = (status: number, what: string) => {
  if (status < 200 || status >= 300) throw new Error(`${what} responded with HTTP ${status}`);
};
const json = (v: unknown) => JSON.stringify(v);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A notification sent from the "Send a test" button: it must not leave a real page or issue behind. */
export const isTest = (n: Notification) => n.event !== "finding.opened" && n.incident.id === "test";

const capitalize = (v: string) => v.charAt(0).toUpperCase() + v.slice(1);

/** One description of what happened, shared by every provider. */
function facts(n: Notification) {
  if (n.event === "finding.opened") {
    return {
      key: `finding-${n.finding.id}`,
      title: `[Security: ${capitalize(n.finding.severity)}] ${n.finding.title}`,
      detail: `${capitalize(n.finding.severity)} finding on ${n.asset.value}: ${n.finding.title}`,
      severity: n.finding.severity,
      recovered: false,
      isFinding: true,
    };
  }
  const recovered = n.event === "incident.resolved";
  return {
    key: `incident-${n.incident.id}`,
    title: recovered ? `[Recovered] ${n.monitor.name}` : `[Down] ${n.monitor.name}`,
    detail: recovered
      ? `${n.monitor.name} has recovered (${n.monitor.target}).`
      : `${n.incident.title} (${n.monitor.target})`,
    severity: "critical",
    recovered,
    isFinding: false,
  };
}

/* ---------------------------------------------------------------------------------------------- Microsoft Teams */

/** A message card for a Teams incoming webhook or a Workflows "post to a channel" webhook. */
export async function teams(url: string, n: Notification, send: Send): Promise<DeliverResult> {
  const f = facts(n);
  const colour = f.recovered
    ? "Good"
    : f.isFinding && f.severity !== "critical"
      ? "Warning"
      : "Attention";
  const card = {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            {
              type: "TextBlock",
              size: "Medium",
              weight: "Bolder",
              color: colour,
              wrap: true,
              text: f.title,
            },
            { type: "TextBlock", wrap: true, isSubtle: true, text: f.detail },
          ],
          actions: [{ type: "Action.OpenUrl", title: "Open in Upzy", url: n.url }],
        },
      },
    ],
  };
  const res = await send(url, json(card), {});
  ok(res.status, "Microsoft Teams");
  return {};
}

/* -------------------------------------------------------------------------------------------------- PagerDuty */

const PAGERDUTY = "https://events.pagerduty.com/v2/enqueue";

/** Events API v2. The dedup key ties the recovery to the page, so one outage is one PagerDuty incident. */
export async function pagerduty(
  routingKey: string,
  n: Notification,
  send: Send,
): Promise<DeliverResult> {
  const f = facts(n);
  const dedup = `upzy-${f.key}`;
  const trigger = async () => {
    const res = await send(
      PAGERDUTY,
      json({
        routing_key: routingKey,
        event_action: "trigger",
        dedup_key: dedup,
        payload: {
          summary: clip(f.title + ": " + f.detail, 1024),
          source: n.event === "finding.opened" ? n.asset.value : n.monitor.target,
          severity:
            f.severity === "critical"
              ? "critical"
              : f.severity === "high"
                ? "error"
                : f.severity === "medium"
                  ? "warning"
                  : "info",
          custom_details:
            n.event === "finding.opened"
              ? { check: n.finding.checkKey }
              : { monitor: n.monitor.name },
        },
        links: [{ href: n.url, text: "Open in Upzy" }],
      }),
      {},
    );
    ok(res.status, "PagerDuty");
  };
  const resolve = async () => {
    const res = await send(
      PAGERDUTY,
      json({ routing_key: routingKey, event_action: "resolve", dedup_key: dedup }),
      {},
    );
    ok(res.status, "PagerDuty");
  };
  if (isTest(n)) {
    // Page and clear straight away, so a test shows the connection works without leaving an open incident.
    await trigger();
    await resolve();
  } else if (f.recovered) await resolve();
  else await trigger();
  return {};
}

/* -------------------------------------------------------------------------------------------------- Opsgenie */

const opsgenieBase = (region: "us" | "eu") =>
  region === "eu" ? "https://api.eu.opsgenie.com" : "https://api.opsgenie.com";

/** Alert API. The alias ties the close to the alert, the same way PagerDuty's dedup key does. */
export async function opsgenie(
  cfg: { apiKey: string; region: "us" | "eu" },
  n: Notification,
  send: Send,
): Promise<DeliverResult> {
  const f = facts(n);
  const alias = `upzy-${f.key}`;
  const headers = { authorization: `GenieKey ${cfg.apiKey}` };
  const base = opsgenieBase(cfg.region);
  const open = async () => {
    const res = await send(
      `${base}/v2/alerts`,
      json({
        message: clip(f.title, 130),
        alias,
        description: clip(f.detail, 15000),
        source: "Upzy",
        priority: f.severity === "critical" ? "P1" : f.severity === "high" ? "P2" : "P3",
        tags: ["upzy"],
        details: { url: n.url },
      }),
      headers,
    );
    ok(res.status, "Opsgenie");
  };
  const close = async () => {
    const res = await send(
      `${base}/v2/alerts/${encodeURIComponent(alias)}/close?identifierType=alias`,
      json({ source: "Upzy", note: "Recovered" }),
      headers,
    );
    ok(res.status, "Opsgenie");
  };
  if (isTest(n)) {
    await open();
    await close();
  } else if (f.recovered) await close();
  else await open();
  return {};
}

/* ----------------------------------------------------------------------------------------------- GitHub issues */

const GITHUB = "https://api.github.com";
const ghHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "Upzy-Notifications/1.0",
});

/**
 * An issue per outage or finding: opened when it starts, commented on and closed when the monitor recovers. The
 * issue number is returned so the recovery (a separate delivery, later) can find the same issue again.
 */
export async function github(
  cfg: { repo: string; token: string },
  n: Notification,
  deps: { send: Send; previousExternalId?: string },
): Promise<DeliverResult> {
  const f = facts(n);
  const headers = ghHeaders(cfg.token);
  const repo = `${GITHUB}/repos/${cfg.repo}`;

  const create = async (title: string, body: string, labels: string[]) => {
    const res = await deps.send(
      `${repo}/issues`,
      json({ title: clip(title, 250), body, labels }),
      headers,
    );
    ok(res.status, "GitHub");
    let number: unknown;
    try {
      number = (JSON.parse(res.body ?? "{}") as { number?: unknown }).number;
    } catch {
      number = undefined;
    }
    return typeof number === "number" ? String(number) : undefined;
  };
  const closeIssue = async (number: string, comment: string) => {
    const c = await deps.send(
      `${repo}/issues/${number}/comments`,
      json({ body: comment }),
      headers,
    );
    ok(c.status, "GitHub");
    const r = await deps.send(
      `${repo}/issues/${number}`,
      json({ state: "closed", state_reason: "completed" }),
      headers,
      "PATCH",
    );
    ok(r.status, "GitHub");
  };

  if (isTest(n)) {
    const number = await create(
      "Upzy test notification",
      "This issue was opened by the **Send a test** button in Upzy to check the connection. It is closed straight away and is safe to delete.",
      ["upzy"],
    );
    if (number) await closeIssue(number, "Connection works. Closing.");
    return {};
  }

  if (f.recovered) {
    // Opened before this channel existed, or by a delivery that didn't record a number: nothing to close.
    if (deps.previousExternalId)
      await closeIssue(
        deps.previousExternalId,
        `Recovered. ${f.detail}\n\n[Open in Upzy](${n.url})`,
      );
    return {};
  }

  const body =
    n.event === "finding.opened"
      ? [
          `**${f.detail}**`,
          "",
          `- Check: \`${n.finding.checkKey}\``,
          `- First seen: ${n.finding.firstSeen}`,
          "",
          `[See it in Upzy](${n.url}) for what it means and how to fix it.`,
        ].join("\n")
      : [
          `**${f.detail}**`,
          "",
          `- Monitor: ${n.monitor.name}`,
          `- Opened: ${n.incident.openedAt}`,
          "",
          `[See the incident in Upzy](${n.url}). This issue closes by itself when the monitor recovers.`,
        ].join("\n");
  const number = await create(
    f.title,
    body,
    n.event === "finding.opened" ? ["upzy", "security"] : ["upzy", "incident"],
  );
  return number ? { externalId: number } : {};
}
