import type { Metadata } from "next";

import { Contact, LegalPage, P, Section, UL } from "@/components/legal/legal-page";
import { pageMetadata } from "@/lib/seo";

export const dynamic = "force-dynamic";
export const metadata: Metadata = pageMetadata({
  title: "Acceptable Use",
  description: "What you may and may not do with Upzy, including what you may scan.",
  path: "/acceptable-use",
});

export default function AcceptableUse() {
  return (
    <LegalPage
      title="Acceptable Use"
      intro="Upzy sends requests to websites and servers on your behalf. This page says what it sends, what you may point it at, and what isn't allowed. The short version: only check things you own or are allowed to check."
    >
      <Section title="Only what you're allowed to check">
        <P>
          Add only domains, subdomains and URLs that you own, or that the owner has agreed in
          writing that you may monitor and security-scan. Upzy asks you to prove ownership of
          domains by a DNS record or a file, and runs only passive checks without it, but proving
          ownership doesn&apos;t make it acceptable to add things you have no right to.
        </P>
      </Section>

      <Section title="What Upzy actually does to a target">
        <P>
          Apart from the deeper checks described below, which need verified ownership, everything is
          passive: it looks at what any visitor or resolver can already see.
        </P>
        <UL>
          <li>
            <strong>Uptime monitors</strong> request the address you give at the interval you pick
            (one minute at the fastest) with a normal HTTP request, and may also open a TCP
            connection, resolve a DNS name or read the TLS certificate.
          </li>
          <li>
            <strong>Advanced monitors</strong> send what the account owner configured: extra
            headers, a request body, and up to five requests in a row (for example, log in, then
            call an endpoint with the token it returned). They run only at the monitor&apos;s
            interval, send only to the address the owner entered, and use only credentials the owner
            supplied for their own service. <strong>Heartbeat monitors</strong> send nothing: they
            wait for the owner&apos;s own job to call Upzy.
          </li>
          <li>
            <strong>Security scans</strong> run about once a day per asset: one anonymous page
            request (headers, cookies, redirects), one plain-HTTP request to see whether it upgrades
            to HTTPS, TLS handshakes (including whether the oldest protocol versions are still
            accepted), DNS lookups (SPF, DMARC, CAA, CNAMEs, DNSSEC), the domain&apos;s public
            registration record, and lookups of public vulnerability data about the software the
            site reveals.
          </li>
          <li>
            <strong>Deeper checks</strong> run only on assets whose ownership you have proved by DNS
            record or file. They request a short list of well-known paths that should never be
            public (such as /.env and /.git/HEAD) and test whether about a dozen risky service ports
            (databases, remote desktop, Telnet) accept a connection. They connect and read nothing
            further, and they never save what a file contained, only that it was reachable.
          </li>
          <li>
            <strong>Subdomain discovery</strong> reads public certificate transparency logs. Hosts
            found are only suggestions and are not scanned until you accept them.
          </li>
        </UL>
        <P>
          Upzy does not try to log in, guess passwords, exploit vulnerabilities or send payloads
          designed to trigger flaws, and it does not scan ports or probe paths on sites you have not
          verified. Requests come from our servers and identify themselves as{" "}
          <a href="/bot" className="underline underline-offset-4">
            UpzyBot
          </a>
          .
        </P>
      </Section>

      <Section title="Not allowed">
        <UL>
          <li>
            Monitoring or scanning systems you don&apos;t own and have no permission to check.
          </li>
          <li>
            Using Upzy to attack, overload or harass anyone, including by pointing many fast
            monitors at one site, or trying to get around the limits we apply.
          </li>
          <li>
            Trying to reach internal or private networks through Upzy (addresses such as localhost,
            10.x.x.x or cloud metadata services). These are blocked, and attempts may lead to
            suspension.
          </li>
          <li>
            Publishing status pages that impersonate another organization, mislead people about an
            incident, host phishing or malware, or contain illegal content.
          </li>
          <li>
            Using subscriber email addresses for anything other than that status page&apos;s
            updates, or adding addresses of people who didn&apos;t ask to be on a list.
          </li>
          <li>
            Sharing accounts to get around limits, reselling access to Upzy, or accessing other
            organizations&apos; data.
          </li>
          <li>Breaking the law, or helping someone else to.</li>
        </UL>
      </Section>

      <Section title="If your site is being checked and you didn't expect it">
        <P>
          Requests from Upzy carry the name UpzyBot, and you can tell your server or firewall to
          refuse them. To have a site removed from every Upzy account, or to report misuse, write to{" "}
          <Contact /> with the address involved. We will look into it promptly and remove it if the
          person who added it can&apos;t show they are allowed to.
        </P>
      </Section>

      <Section title="Found a security problem in Upzy?">
        <P>
          Please tell us at <Contact /> before telling anyone else, give us a reasonable time to fix
          it, and don&apos;t access other people&apos;s data or disrupt the service while testing.
          We appreciate the report and won&apos;t take action against good-faith research that
          follows this.
        </P>
      </Section>

      <Section title="What we may do">
        <P>
          If something here is broken we may pause monitors or scans, remove content, or suspend an
          account, and we may report unlawful activity to the authorities. We&apos;ll explain why
          where we reasonably can, and give you the chance to put things right unless the risk to
          others is serious.
        </P>
      </Section>
    </LegalPage>
  );
}
