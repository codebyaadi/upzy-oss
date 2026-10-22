/**
 * Every email Upzy sends on its own behalf (not the incident alerts, which are formatted per channel in @upzy/notify):
 * its subject, its plain-text body, and the headers that go with it. Pure strings with no React, so the API and auth
 * can build a message without loading the renderer. The HTML version of each lives in ./emails and is rendered by the
 * worker just before sending.
 */
export interface TemplateProps {
  invitation: { organization: string; inviter: string; role: string; url: string };
  resetPassword: { name: string; url: string };
  verifyEmail: { name: string; url: string };
  statusConfirm: { page: string; url: string };
  statusNotice: {
    page: string;
    headline: string;
    stage?: string;
    message?: string;
    pageUrl: string;
    unsubscribeUrl: string;
  };
  welcome: { name: string; appUrl: string; unsubscribeUrl: string };
  fixNudge: {
    name: string;
    findingTitle: string;
    asset: string;
    severity: string;
    remediation: string;
    findingUrl: string;
    unsubscribeUrl: string;
  };
  trialEnding: {
    name: string;
    organization: string;
    daysLeft: number;
    billingUrl: string;
    unsubscribeUrl: string;
  };
  accountDeleted: { name: string };
  organizationDeleted: { name: string; organization: string; by: string };
  /** An incident or security finding sent to an email alert channel. */
  alert: {
    subject: string;
    emoji: string;
    tone: "down" | "recovered" | "finding";
    line1: string;
    line2: string;
    url: string;
  };
  weeklyDigest: {
    workspace: string;
    periodStart: string;
    periodEnd: string;
    narrative?: { headline: string; summary: string; highlights: string[]; actions: string[] };
    /** `uptime` is already formatted ("99.95%" or "no data"). */
    monitors: { name: string; uptime: string; avgMs: number | null; checks: number }[];
    incidents: {
      opened: number;
      resolved: number;
      stillOpen: number;
      totalDowntimeMinutes: number;
    };
    findings: {
      new: number;
      resolved: number;
      open: number;
      topOpen: { title: string; severity: string; asset: string }[];
    };
    dashboardUrl: string;
  };
}

export type TemplateName = keyof TemplateProps;

interface Template<P> {
  subject: (p: P) => string;
  text: (p: P) => string;
  /** Mail clients show an unsubscribe button when this is set. */
  unsubscribe?: (p: P) => string;
}

const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;
const optOut = (url: string) => `\n\n--\nUnsubscribe from product emails: ${url}`;

export const templates: { [N in TemplateName]: Template<TemplateProps[N]> } = {
  invitation: {
    subject: (p) => `${p.inviter} invited you to ${p.organization} on Upzy`,
    text: (p) =>
      `${p.inviter} invited you to join ${p.organization} on Upzy as ${p.role === "admin" ? "an" : "a"} ${p.role}.\n\nAccept the invitation:\n${p.url}\n\nIf you weren't expecting this, you can ignore this email.`,
  },
  resetPassword: {
    subject: () => "Reset your Upzy password",
    text: (p) =>
      `Hi ${p.name},\n\nSomeone asked to reset the password for your Upzy account. Set a new one here (the link expires in 1 hour):\n${p.url}\n\nIf this wasn't you, ignore this email: your password stays the same.`,
  },
  verifyEmail: {
    subject: () => "Confirm your email for Upzy",
    text: (p) =>
      `Hi ${p.name},\n\nConfirm your email address to finish setting up your Upzy account:\n${p.url}`,
  },
  statusConfirm: {
    subject: (p) => `Confirm updates from ${p.page}`,
    text: (p) =>
      `Someone (hopefully you) asked to get an email when ${p.page} reports an incident.\n\nConfirm here:\n${p.url}\n\nIf this wasn't you, ignore this email and you won't hear from us again.`,
  },
  statusNotice: {
    subject: (p) => `[${p.page}] ${p.headline}`,
    text: (p) =>
      `${p.headline}\n${p.stage && p.message ? `\n${p.stage}: ${p.message}\n` : ""}\nLive status: ${p.pageUrl}\n\n--\nYou get this because you subscribed to updates from ${p.page}.\nUnsubscribe: ${p.unsubscribeUrl}`,
    unsubscribe: (p) => p.unsubscribeUrl,
  },
  welcome: {
    subject: () => "Welcome to Upzy",
    text: (p) =>
      `Hi ${p.name},\n\nThanks for trying Upzy. The quickest way to see it work:\n\n1. Add a monitor for your site or API, so you hear about downtime before your users do.\n2. Add your domain as an asset, and Upzy scans it for exposed ports, weak TLS and missing headers.\n\nStart here: ${p.appUrl}/get-started\n\nIf you get stuck, reply to this email.${optOut(p.unsubscribeUrl)}`,
    unsubscribe: (p) => p.unsubscribeUrl,
  },
  fixNudge: {
    subject: (p) => `Your first fix: ${p.findingTitle}`,
    text: (p) =>
      `Hi ${p.name},\n\nUpzy's first scan of ${p.asset} found something worth fixing today (${p.severity}):\n\n${p.findingTitle}\n${p.remediation ? `\nHow to fix it:\n${p.remediation}\n` : ""}\nSee the details and re-check it once you've fixed it:\n${p.findingUrl}${optOut(p.unsubscribeUrl)}`,
    unsubscribe: (p) => p.unsubscribeUrl,
  },
  trialEnding: {
    subject: (p) => `Your Upzy trial ends in ${days(p.daysLeft)}`,
    text: (p) =>
      `Hi ${p.name},\n\nThe free trial for ${p.organization} ends in ${days(p.daysLeft)}. After that the workspace moves to the Free plan: your monitors, incidents and findings stay, but the Free plan's limits apply to anything new.\n\nPick a plan to keep everything on:\n${p.billingUrl}${optOut(p.unsubscribeUrl)}`,
    unsubscribe: (p) => p.unsubscribeUrl,
  },
  accountDeleted: {
    subject: () => "Your Upzy account was deleted",
    text: (p) =>
      `Hi ${p.name},\n\nYour Upzy account and the personal data tied to it were deleted. If you didn't do this, reply to this email right away.`,
  },
  organizationDeleted: {
    subject: (p) => `${p.organization} was deleted on Upzy`,
    text: (p) =>
      `Hi ${p.name},\n\n${p.by} deleted the organization ${p.organization} on Upzy. Its monitors, status pages, findings and history are gone, and you no longer have access to it.`,
  },
  alert: {
    subject: (p) => p.subject,
    text: (p) => `${p.emoji} ${p.line1}
${p.line2}
${p.url}`,
  },
  weeklyDigest: {
    subject: (p) => `Your weekly Upzy summary: ${p.workspace}`,
    text: (p) => {
      const lines: string[] = [
        `Weekly summary for ${p.workspace}`,
        `${p.periodStart} to ${p.periodEnd}`,
        "",
      ];
      const n = p.narrative;
      if (n) {
        lines.push(n.headline, "", n.summary, "");
        if (n.highlights.length) lines.push(...n.highlights.map((h) => `- ${h}`), "");
        if (n.actions.length) lines.push("Worth doing:", ...n.actions.map((a) => `- ${a}`), "");
      }
      lines.push("Uptime");
      lines.push(
        ...(p.monitors.length
          ? p.monitors.map(
              (m) =>
                `- ${m.name}: ${m.uptime}${m.avgMs !== null ? `, avg ${m.avgMs} ms` : ""} (${m.checks} checks)`,
            )
          : ["- No monitors yet"]),
      );
      lines.push(
        "",
        `Incidents: ${p.incidents.opened} opened, ${p.incidents.resolved} resolved, ${p.incidents.stillOpen} still open, ${p.incidents.totalDowntimeMinutes} min of downtime`,
        `Security findings: ${p.findings.new} new, ${p.findings.resolved} resolved, ${p.findings.open} open`,
      );
      if (p.findings.topOpen.length)
        lines.push(
          "Top open findings:",
          ...p.findings.topOpen.map((f) => `- [${f.severity}] ${f.title} (${f.asset})`),
        );
      lines.push("", `Open the dashboard: ${p.dashboardUrl}`);
      return lines.join("\n");
    },
  },
};

/** A message ready to queue: plain text now, HTML rendered from `template` when it is sent. */
export interface ComposedEmail {
  to: string;
  subject: string;
  text: string;
  headers?: Record<string, string>;
  template: { name: TemplateName; props: unknown };
}

export function compose<N extends TemplateName>(
  name: N,
  to: string,
  props: TemplateProps[N],
): ComposedEmail {
  const t = templates[name] as Template<TemplateProps[N]>;
  const unsubscribe = t.unsubscribe?.(props);
  return {
    to,
    subject: t.subject(props),
    text: t.text(props),
    ...(unsubscribe ? { headers: { "List-Unsubscribe": `<${unsubscribe}>` } } : {}),
    template: { name, props },
  };
}
