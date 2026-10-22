import { Cta, H1, Layout, Muted, P } from "../layout";
import type { TemplateProps } from "../templates";

type Props = TemplateProps["verifyEmail"];

export default function VerifyEmail({ name, url }: Props) {
  return (
    <Layout preview="One click to finish setting up your account.">
      <H1>Confirm your email</H1>
      <P>Hi {name}, confirm your email address to finish setting up your Upzy account.</P>
      <Cta href={url}>Confirm email</Cta>
      <Muted>If you didn&apos;t sign up, you can ignore this email.</Muted>
    </Layout>
  );
}

VerifyEmail.PreviewProps = {
  name: "Ada",
  url: "https://api.upzy.example/api/auth/verify-email?token=t",
} satisfies Props;
