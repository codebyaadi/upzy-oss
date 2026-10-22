import { Text } from "@react-email/components";

import { Callout, Cta, H1, Layout, Muted, P, color } from "../layout";
import type { TemplateProps } from "../templates";

type Props = TemplateProps["weeklyDigest"];

const Heading = ({ children }: { children: string }) => (
  <Text style={{ margin: "20px 0 8px", fontSize: "15px", fontWeight: 700, color: color.primary }}>
    {children}
  </Text>
);

const Line = ({ children }: { children: React.ReactNode }) => (
  <Text style={{ margin: "0 0 6px", fontSize: "14px", lineHeight: "22px", color: color.ink }}>
    {children}
  </Text>
);

export default function WeeklyDigest(p: Props) {
  const n = p.narrative;
  return (
    <Layout
      preview={n?.headline ?? `Your week for ${p.workspace}`}
      footer="Sent to owners and admins once a week."
    >
      <H1>{n?.headline ?? `Weekly summary for ${p.workspace}`}</H1>
      <Muted>
        {p.workspace} · {p.periodStart} to {p.periodEnd}
      </Muted>
      {n ? (
        <>
          <P>{n.summary}</P>
          {n.highlights.length ? (
            <Callout>
              {n.highlights.map((h) => (
                <Line key={h}>• {h}</Line>
              ))}
            </Callout>
          ) : null}
          {n.actions.length ? (
            <>
              <Heading>Worth doing</Heading>
              {n.actions.map((a) => (
                <Line key={a}>• {a}</Line>
              ))}
            </>
          ) : null}
        </>
      ) : null}

      <Heading>Uptime</Heading>
      {p.monitors.length ? (
        p.monitors.map((m) => (
          <Line key={m.name}>
            <strong>{m.name}</strong>: {m.uptime}
            {m.avgMs !== null ? `, avg ${m.avgMs} ms` : ""} ({m.checks} checks)
          </Line>
        ))
      ) : (
        <Line>No monitors yet</Line>
      )}

      <Heading>Incidents</Heading>
      <Line>
        {p.incidents.opened} opened, {p.incidents.resolved} resolved, {p.incidents.stillOpen} still
        open, {p.incidents.totalDowntimeMinutes} min of downtime
      </Line>

      <Heading>Security findings</Heading>
      <Line>
        {p.findings.new} new, {p.findings.resolved} resolved, {p.findings.open} open
      </Line>
      {p.findings.topOpen.map((f) => (
        <Line key={`${f.title}${f.asset}`}>
          [{f.severity}] {f.title} ({f.asset})
        </Line>
      ))}

      <Cta href={p.dashboardUrl}>Open the dashboard</Cta>
    </Layout>
  );
}

WeeklyDigest.PreviewProps = {
  workspace: "Prod",
  periodStart: "2026-10-05",
  periodEnd: "2026-10-11",
  narrative: {
    headline: "A quiet week",
    summary: "Everything stayed up except a short blip on Tuesday.",
    highlights: ["API uptime 99.95%"],
    actions: ["Add the missing HSTS header on example.com"],
  },
  monitors: [{ name: "API", uptime: "99.95%", avgMs: 120, checks: 10080 }],
  incidents: { opened: 1, resolved: 1, stillOpen: 0, totalDowntimeMinutes: 5 },
  findings: {
    new: 1,
    resolved: 0,
    open: 1,
    topOpen: [{ severity: "high", title: "HSTS is missing", asset: "example.com" }],
  },
  dashboardUrl: "https://app.upzy.example/monitors",
} satisfies Props;
