import type { Metadata } from "next";

import { Contact, LegalPage, P, Section, UL } from "@/components/legal/legal-page";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "UpzyBot" };

export default function Bot() {
  return (
    <LegalPage
      title="UpzyBot"
      intro="If you found UpzyBot in your server logs: this is Upzy, an uptime and security monitoring service. Someone added your site to their account, and this is what the requests are."
    >
      <Section title="How to recognise it">
        <P>
          Requests identify themselves with the user agent{" "}
          <code className="font-mono text-sm">UpzyBot/1.0</code> followed by a link to this page.
        </P>
      </Section>

      <Section title="What it does">
        <UL>
          <li>
            Fetches a page, normally every one to sixty minutes, to see whether it responds, and to
            read its headers.
          </li>
          <li>
            Opens a TLS connection to read the certificate, and looks up DNS records for the domain.
          </li>
          <li>
            Once a day makes the handful of requests described in the{" "}
            <a href="/acceptable-use" className="underline underline-offset-4">
              Acceptable Use
            </a>{" "}
            policy.
          </li>
        </UL>
        <P>
          Its scans never log in, guess passwords or paths, scan ports or try to exploit anything. A
          monitor the site's owner set up may send the headers, body or login steps that owner
          configured for their own service, and nothing else. It follows redirects a few hops and
          does not run JavaScript.
        </P>
      </Section>

      <Section title="If you didn't expect it">
        <P>
          Someone with an Upzy account chose to monitor your address. If that isn&apos;t you or
          someone you authorised, write to <Contact /> with the address and we will remove it, and
          look into the account. You can also block the{" "}
          <code className="font-mono text-sm">UpzyBot</code> user agent in your firewall or web
          server and nothing else will happen.
        </P>
      </Section>
    </LegalPage>
  );
}
