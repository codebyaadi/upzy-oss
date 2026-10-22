import { Cta, H1, Layout, Muted, P } from "../layout";
import type { TemplateProps } from "../templates";

type Props = TemplateProps["statusConfirm"];

export default function StatusConfirm({ page, url }: Props) {
  return (
    <Layout preview={`Confirm to get incident updates from ${page}.`}>
      <H1>Confirm updates from {page}</H1>
      <P>
        Someone (hopefully you) asked to get an email when <strong>{page}</strong> reports an
        incident.
      </P>
      <Cta href={url}>Yes, send me updates</Cta>
      <Muted>
        If this wasn&apos;t you, ignore this email and you won&apos;t hear from us again.
      </Muted>
    </Layout>
  );
}

StatusConfirm.PreviewProps = {
  page: "Acme status",
  url: "https://api.upzy.example/status/confirm?t=1",
} satisfies Props;
