import { signWebhook } from "@upzy/crypto";
import { safeFetch } from "@upzy/probes";
import { compose, type TemplateProps } from "@upzy/transactional/templates";

export type IncidentEventName = "incident.opened" | "incident.resolved";
export type NotifyEventName = IncidentEventName | "finding.opened";

export interface IncidentNotification {
  event: IncidentEventName;
  incident: { id: string; title: string; openedAt: string; resolvedAt: string | null };
  monitor: { id: string; name: string; target: string };
  /** Link to the incident in the dashboard. */
  url: string;
}

export interface FindingNotification {
  event: "finding.opened";
  finding: { id: string; title: string; severity: string; checkKey: string; firstSeen: string };
  asset: { id: string; value: string };
  /** Link to the finding in the dashboard. */
  url: string;
}

export type Notification = IncidentNotification | FindingNotification;

export type ChannelConfig =
  | { kind: "email"; to: string }
  | { kind: "slack"; url: string }
  | { kind: "discord"; url: string }
  | { kind: "webhook"; url: string; secret: string };

/** Sends an HTTP POST. Defaults to the SSRF-guarded client; tests inject their own. */
export type Poster = (
  url: string,
  body: string,
  headers: Record<string, string>,
) => Promise<{ status: number }>;

export const guardedPost: Poster = (url, body, headers) =>
  safeFetch(url, {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...headers },
    timeoutMs: 10_000,
  });

export interface EmailSender {
  (msg: {
    to: string;
    subject: string;
    text: string;
    html?: string;
    headers?: Record<string, string>;
    /** A @upzy/transactional template to render as the HTML version (done by the worker's sender). */
    template?: { name: string; props: unknown };
  }): Promise<void>;
}

const SEVERITY_EMOJI: Record<string, string> = { critical: "🚨", high: "🟠" };
const capitalize = (v: string) => v.charAt(0).toUpperCase() + v.slice(1);

export const subjectFor = (n: Notification) =>
  n.event === "finding.opened"
    ? `[Security: ${capitalize(n.finding.severity)}] ${n.finding.title}`
    : n.event === "incident.opened"
      ? `[Down] ${n.monitor.name}`
      : `[Recovered] ${n.monitor.name}`;

/** What an email alert says, shared by the plain-text version and the HTML template. */
function alertFor(n: Notification): Omit<TemplateProps["alert"], "subject"> {
  if (n.event === "finding.opened")
    return {
      emoji: SEVERITY_EMOJI[n.finding.severity] ?? "⚠️",
      tone: "finding",
      line1: `${capitalize(n.finding.severity)} finding on ${n.asset.value}`,
      line2: n.finding.title,
      url: n.url,
    };
  return n.event === "incident.opened"
    ? { emoji: "🔴", tone: "down", line1: n.incident.title, line2: n.monitor.target, url: n.url }
    : {
        emoji: "🟢",
        tone: "recovered",
        line1: `${n.monitor.name} has recovered`,
        line2: n.monitor.target,
        url: n.url,
      };
}

export function textFor(n: Notification): string {
  const a = alertFor(n);
  return `${a.emoji} ${a.line1}
${a.line2}
${a.url}`;
}

function assertOk(status: number, what: string) {
  if (status < 200 || status >= 300) throw new Error(`${what} responded with HTTP ${status}`);
}

/** Delivers a notification. Throws on failure so the queue retries. */
export async function deliver(
  config: ChannelConfig,
  n: Notification,
  deps: { post?: Poster; email?: EmailSender } = {},
): Promise<void> {
  const post = deps.post ?? guardedPost;
  switch (config.kind) {
    case "slack": {
      const res = await post(config.url, JSON.stringify({ text: textFor(n) }), {});
      return assertOk(res.status, "Slack");
    }
    case "discord": {
      const res = await post(
        config.url,
        JSON.stringify({ content: textFor(n), allowed_mentions: { parse: [] } }),
        {},
      );
      return assertOk(res.status, "Discord");
    }
    case "webhook": {
      const body = JSON.stringify(
        n.event === "finding.opened"
          ? {
              id: `${n.finding.id}:${n.event}`,
              type: n.event,
              data: { finding: n.finding, asset: n.asset, url: n.url },
            }
          : {
              id: `${n.incident.id}:${n.event}`,
              type: n.event,
              data: { incident: n.incident, monitor: n.monitor, url: n.url },
            },
      );
      const res = await post(config.url, body, {
        "upzy-signature": signWebhook(config.secret, body),
        "user-agent": "Upzy-Webhooks/1.0",
      });
      return assertOk(res.status, "Webhook endpoint");
    }
    case "email": {
      if (!deps.email) throw new Error("Email is not configured on this worker (SMTP_URL)");
      await deps.email(compose("alert", config.to, { subject: subjectFor(n), ...alertFor(n) }));
      return;
    }
  }
}
