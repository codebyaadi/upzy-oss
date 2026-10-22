import { Text } from "@react-email/components";

import { Callout, Cta, Layout, P, color } from "../layout";
import type { TemplateProps } from "../templates";

type Props = TemplateProps["statusNotice"];

export default function StatusNotice(p: Props) {
  return (
    <Layout
      preview={p.headline}
      footer={`You get this because you subscribed to updates from ${p.page}.`}
      unsubscribeUrl={p.unsubscribeUrl}
    >
      <Text style={{ margin: "0 0 8px", fontSize: "13px", fontWeight: 700, color: color.brand }}>
        {p.page}
      </Text>
      <Text
        style={{
          margin: "0 0 16px",
          fontSize: "20px",
          lineHeight: "28px",
          fontWeight: 700,
          color: color.ink,
        }}
      >
        {p.headline}
      </Text>
      {p.stage && p.message ? (
        <Callout>
          <Text style={{ margin: 0, fontSize: "14px", lineHeight: "22px", color: color.ink }}>
            <strong>{p.stage}:</strong> {p.message}
          </Text>
        </Callout>
      ) : null}
      <P>See the live status for every service.</P>
      <Cta href={p.pageUrl}>Open the status page</Cta>
    </Layout>
  );
}

StatusNotice.PreviewProps = {
  page: "Acme status",
  headline: "Elevated errors on the API",
  stage: "Investigating",
  message: "We are looking into elevated error rates.",
  pageUrl: "https://status.acme.example",
  unsubscribeUrl: "https://api.upzy.example/status/unsubscribe?t=1",
} satisfies Props;
