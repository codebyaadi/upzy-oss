import { H1, Layout, P } from "../layout";
import type { TemplateProps } from "../templates";

type Props = TemplateProps["accountDeleted"];

export default function AccountDeleted({ name }: Props) {
  return (
    <Layout preview="Your account and its personal data are gone.">
      <H1>Your account was deleted</H1>
      <P>
        Hi {name}, your Upzy account and the personal data tied to it were deleted. If you
        didn&apos;t do this, reply to this email right away.
      </P>
    </Layout>
  );
}

AccountDeleted.PreviewProps = { name: "Ada" } satisfies Props;
