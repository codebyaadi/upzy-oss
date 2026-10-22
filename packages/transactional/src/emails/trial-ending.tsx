import { Cta, H1, Layout, Muted, P } from "../layout";
import type { TemplateProps } from "../templates";

type Props = TemplateProps["trialEnding"];

export default function TrialEnding(p: Props) {
  const left = `${p.daysLeft} ${p.daysLeft === 1 ? "day" : "days"}`;
  return (
    <Layout
      preview={`${p.organization} moves to the Free plan after the trial.`}
      unsubscribeUrl={p.unsubscribeUrl}
    >
      <H1>Your trial ends in {left}</H1>
      <P>
        Hi {p.name}, the free trial for <strong>{p.organization}</strong> ends in {left}.
      </P>
      <P>
        After that the workspace moves to the Free plan. Your monitors, incidents and findings stay,
        but the Free plan&apos;s limits apply to anything new.
      </P>
      <Cta href={p.billingUrl}>Pick a plan</Cta>
      <Muted>Nothing to do if Free is enough.</Muted>
    </Layout>
  );
}

TrialEnding.PreviewProps = {
  name: "Ada",
  organization: "Acme",
  daysLeft: 2,
  billingUrl: "https://app.upzy.example/settings/billing",
  unsubscribeUrl: "https://api.upzy.example/lifecycle/unsubscribe?u=1&t=2",
} satisfies Props;
