import { Text } from "@react-email/components";

import { Callout, Cta, Layout, color } from "../layout";
import type { TemplateProps } from "../templates";

type Props = TemplateProps["alert"];

const LABEL = { down: "Down", recovered: "Recovered", finding: "Security finding" } as const;
const ACCENT = { down: "#b42318", recovered: color.brand, finding: "#9a5b00" } as const;

export default function Alert(p: Props) {
  return (
    <Layout preview={p.line1} footer="You get this because an alert channel in Upzy sends here.">
      <Text
        style={{
          margin: "0 0 8px",
          fontSize: "12px",
          fontWeight: 700,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color: ACCENT[p.tone],
        }}
      >
        {LABEL[p.tone]}
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
        {p.line1}
      </Text>
      <Callout>
        <Text style={{ margin: 0, fontSize: "14px", lineHeight: "22px", color: color.ink }}>
          {p.line2}
        </Text>
      </Callout>
      <Cta href={p.url}>{p.tone === "finding" ? "See the finding" : "See the incident"}</Cta>
    </Layout>
  );
}

Alert.PreviewProps = {
  subject: "[Down] API",
  emoji: "🔴",
  tone: "down",
  line1: "API is down",
  line2: "https://api.example.com",
  url: "https://app.upzy.example/incidents/1",
} satisfies Props;
