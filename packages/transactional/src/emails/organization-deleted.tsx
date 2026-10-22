import { H1, Layout, P } from "../layout";
import type { TemplateProps } from "../templates";

type Props = TemplateProps["organizationDeleted"];

export default function OrganizationDeleted(p: Props) {
  return (
    <Layout preview={`${p.by} deleted ${p.organization}.`}>
      <H1>{p.organization} was deleted</H1>
      <P>
        Hi {p.name}, {p.by} deleted the organization <strong>{p.organization}</strong> on Upzy. Its
        monitors, status pages, findings and history are gone, and you no longer have access to it.
      </P>
    </Layout>
  );
}

OrganizationDeleted.PreviewProps = {
  name: "Ada",
  organization: "Acme",
  by: "Grace",
} satisfies Props;
