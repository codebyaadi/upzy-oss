import { Text } from "@react-email/components";

import { Callout, Cta, H1, Layout, Muted, P, color } from "../layout";
import type { TemplateProps } from "../templates";

type Props = TemplateProps["fixNudge"];

export default function FixNudge(p: Props) {
  return (
    <Layout preview={p.findingTitle} unsubscribeUrl={p.unsubscribeUrl}>
      <H1>Your first fix is ready, {p.name}</H1>
      <P>
        Upzy&apos;s first scan of <strong>{p.asset}</strong> found something worth fixing today.
      </P>
      <Callout>
        <Text
          style={{
            margin: 0,
            fontSize: "12px",
            fontWeight: 700,
            color: color.brand,
            textTransform: "uppercase",
          }}
        >
          {p.severity}
        </Text>
        <Text style={{ margin: "4px 0 0", fontSize: "16px", fontWeight: 700, color: color.ink }}>
          {p.findingTitle}
        </Text>
      </Callout>
      {p.remediation ? (
        <>
          <P>
            <strong>How to fix it</strong>
          </P>
          <Text
            style={{
              margin: "0 0 16px",
              fontSize: "14px",
              lineHeight: "22px",
              color: color.ink,
              whiteSpace: "pre-wrap",
            }}
          >
            {p.remediation}
          </Text>
        </>
      ) : null}
      <Cta href={p.findingUrl}>See it and re-check</Cta>
      <Muted>Once you have fixed it, use Verify fix and Upzy checks it again right away.</Muted>
    </Layout>
  );
}

FixNudge.PreviewProps = {
  name: "Ada",
  findingTitle: "HSTS is missing",
  asset: "example.com",
  severity: "high",
  remediation: "Add the Strict-Transport-Security header to your responses.",
  findingUrl: "https://app.upzy.example/findings",
  unsubscribeUrl: "https://api.upzy.example/lifecycle/unsubscribe?u=1&t=2",
} satisfies Props;
