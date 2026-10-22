import { Cta, H1, Layout, Muted, P } from "../layout";
import type { TemplateProps } from "../templates";

type Props = TemplateProps["welcome"];

export default function Welcome({ name, appUrl, unsubscribeUrl }: Props) {
  return (
    <Layout preview="Two things worth doing first." unsubscribeUrl={unsubscribeUrl}>
      <H1>Welcome to Upzy, {name}</H1>
      <P>Thanks for trying it. The quickest way to see it work:</P>
      <P>
        <strong>1. Add a monitor</strong> for your site or API, so you hear about downtime before
        your users do.
      </P>
      <P>
        <strong>2. Add your domain as an asset</strong>, and Upzy scans it for exposed ports, weak
        TLS and missing headers.
      </P>
      <Cta href={`${appUrl}/get-started`}>Get started</Cta>
      <Muted>Stuck? Just reply to this email.</Muted>
    </Layout>
  );
}

Welcome.PreviewProps = {
  name: "Ada",
  appUrl: "https://app.upzy.example",
  unsubscribeUrl: "https://api.upzy.example/lifecycle/unsubscribe?u=1&t=2",
} satisfies Props;
