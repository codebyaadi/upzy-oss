import { Cta, H1, Layout, Muted, P } from "../layout";
import type { TemplateProps } from "../templates";

type Props = TemplateProps["invitation"];

export default function Invitation(p: Props) {
  return (
    <Layout preview={`${p.inviter} invited you to ${p.organization}.`}>
      <H1>Join {p.organization} on Upzy</H1>
      <P>
        <strong>{p.inviter}</strong> invited you to join <strong>{p.organization}</strong> as{" "}
        {p.role === "admin" ? "an" : "a"} {p.role}.
      </P>
      <Cta href={p.url}>Accept the invitation</Cta>
      <Muted>If you weren&apos;t expecting this, you can ignore this email.</Muted>
    </Layout>
  );
}

Invitation.PreviewProps = {
  organization: "Acme",
  inviter: "Ada",
  role: "member",
  url: "https://app.upzy.example/accept-invitation/1",
} satisfies Props;
