import { Cta, H1, Layout, Muted, P } from "../layout";
import type { TemplateProps } from "../templates";

type Props = TemplateProps["resetPassword"];

export default function ResetPassword({ name, url }: Props) {
  return (
    <Layout preview="The link works for one hour.">
      <H1>Reset your password</H1>
      <P>
        Hi {name}, someone asked to reset the password for your Upzy account. The link works for 1
        hour.
      </P>
      <Cta href={url}>Set a new password</Cta>
      <Muted>If this wasn&apos;t you, ignore this email: your password stays the same.</Muted>
    </Layout>
  );
}

ResetPassword.PreviewProps = {
  name: "Ada",
  url: "https://app.upzy.example/reset-password?token=t",
} satisfies Props;
