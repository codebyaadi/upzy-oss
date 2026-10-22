import { Text } from "@react-email/components";

import { Callout, Cta, H1, Layout, Muted, color } from "../layout";
import type { TemplateProps } from "../templates";

type Props = TemplateProps["clientReport"];

const GRADE_COLOR: Record<string, string> = {
  A: "#0f7a6a",
  B: "#4d7c0f",
  C: "#a16207",
  D: "#c2410c",
  F: "#b42318",
};

const Heading = ({ children }: { children: string }) => (
  <Text style={{ margin: "22px 0 8px", fontSize: "15px", fontWeight: 700, color: color.primary }}>
    {children}
  </Text>
);
const Line = ({ children }: { children: React.ReactNode }) => (
  <Text style={{ margin: "0 0 6px", fontSize: "14px", lineHeight: "22px", color: color.ink }}>
    {children}
  </Text>
);

export default function ClientReport(p: Props) {
  return (
    <Layout
      preview={`${p.workspace}: ${p.uptime ? `${p.uptime} uptime` : "your report"}, ${p.periodLabel}`}
      footer={`You get this report because ${p.preparedBy} set it up for ${p.workspace}.`}
      unsubscribeUrl={p.unsubscribeUrl}
    >
      <H1>
        {p.workspace}: {p.frequency} report
      </H1>
      <Muted>
        {p.periodLabel} · Prepared by {p.preparedBy}
      </Muted>

      <Callout>
        <Text style={{ margin: 0, fontSize: "12px", fontWeight: 700, color: color.brand }}>
          UPTIME
        </Text>
        <Text style={{ margin: "2px 0 0", fontSize: "28px", fontWeight: 800, color: color.ink }}>
          {p.uptime ?? "No data yet"}
        </Text>
      </Callout>

      {p.monitors.length > 0 && (
        <>
          <Heading>By service</Heading>
          {p.monitors.map((m) => (
            <Line key={m.name}>
              <strong>{m.name}</strong>: {m.uptime}
              {m.avgMs !== null ? `, average response ${m.avgMs} ms` : ""}
            </Line>
          ))}
        </>
      )}

      <Heading>Incidents</Heading>
      <Line>
        {p.incidents.opened} opened, {p.incidents.resolved} resolved, {p.incidents.stillOpen} still
        open. Total downtime: {p.incidents.totalDowntimeMinutes} min.
      </Line>

      <Heading>Security</Heading>
      <Line>
        {p.security.grade ? (
          <>
            Grade{" "}
            <strong style={{ color: GRADE_COLOR[p.security.grade] ?? color.ink }}>
              {p.security.grade}
            </strong>
            .{" "}
          </>
        ) : (
          "Not scanned yet. "
        )}
        {p.security.resolvedFindings} issue{p.security.resolvedFindings === 1 ? "" : "s"} fixed,{" "}
        {p.security.newFindings} new, {p.security.openFindings} open.
      </Line>

      {p.statusPageUrl && <Cta href={p.statusPageUrl}>See live status</Cta>}
    </Layout>
  );
}

ClientReport.PreviewProps = {
  workspace: "Acme",
  preparedBy: "Pixel & Co",
  frequency: "monthly",
  periodLabel: "October 2026",
  uptime: "99.94%",
  monitors: [
    { name: "Website", uptime: "99.98%", avgMs: 180, checks: 43200 },
    { name: "Checkout API", uptime: "99.9%", avgMs: 240, checks: 43200 },
  ],
  incidents: { opened: 2, resolved: 2, stillOpen: 0, totalDowntimeMinutes: 26 },
  security: { grade: "A", newFindings: 1, resolvedFindings: 3, openFindings: 1 },
  statusPageUrl: "https://status.acme.example",
  unsubscribeUrl: "https://api.upzy.example/reports/unsubscribe?w=1&e=a@b.co&t=x",
} satisfies Props;
