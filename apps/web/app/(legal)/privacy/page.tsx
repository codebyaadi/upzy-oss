import type { Metadata } from "next";

import { Contact, LegalPage, P, Section, UL } from "@/components/legal/legal-page";
import { legal } from "@/lib/legal";
import { pageMetadata } from "@/lib/seo";

export const dynamic = "force-dynamic";
export const metadata: Metadata = pageMetadata({
  title: "Privacy Policy",
  description:
    "How Upzy handles your data: what we collect, why, how long we keep it, and your rights.",
  path: "/privacy",
});

export default function Privacy() {
  const { entity } = legal();
  return (
    <LegalPage
      title="Privacy Policy"
      intro={`This explains what personal data Upzy handles, why, who else sees it, and what you can ask us to do. ${entity} is responsible for it (the "controller"). We don't sell data, run ads, or use tracking or analytics cookies.`}
    >
      <Section title="What we collect">
        <UL>
          <li>
            <strong>Your account:</strong> name, email address, a hashed password (we never store
            the password itself), whether the email is confirmed, and your role in each
            organization.
          </li>
          <li>
            <strong>Your plan:</strong> which plan you are on, its status and renewal date, and the
            payment provider's customer and subscription references (never card details).
          </li>
          <li>
            <strong>What you set up:</strong> organizations and members, monitors (names, addresses,
            settings, headers and request bodies you configure), alert rules, and notification
            destinations (email addresses, Slack or Discord webhook URLs, webhook addresses and
            signing secrets, which are encrypted at rest), and any secrets you give a monitor, such
            as an API token, which are encrypted at rest and never shown again. A heartbeat monitor
            also holds the secret address your job pings.
          </li>
          <li>
            <strong>Monitoring results:</strong> each check&apos;s time, status, response time and
            error text, and the incidents built from them.
          </li>
          <li>
            <strong>Security scan data:</strong> your assets, findings, and the evidence behind
            them: response headers, DNS and TLS details and software names and versions found on
            your own sites, plus a label for what the site runs on (for example &ldquo;Cloudflare in
            front of nginx&rdquo;).
          </li>
          <li>
            <strong>Status pages:</strong> the page text, component names and the incident updates
            you publish, and the email addresses of people who subscribe (confirmed or still waiting
            for confirmation).
          </li>
          <li>
            <strong>AI settings:</strong> if you turn AI on, your provider key (encrypted), the
            models you chose, and usage counts, token counts and estimated cost per day. The text AI
            writes for you (explanations, drafts, summaries) is kept where you see it in the app. We
            don&apos;t keep a log of your prompts.
          </li>
          <li>
            <strong>Activity log:</strong> for changes made in an organization, who did it, what,
            when, and the IP address and browser they used. Request bodies are reduced to field
            names, so secrets never reach it.
          </li>
          <li>
            <strong>Technical data:</strong> your IP address in server logs and short-lived,
            in-memory counters used to limit abuse.
          </li>
        </UL>
      </Section>

      <Section title="Cookies and local storage">
        <P>
          Upzy uses one session cookie to keep you signed in, a small cookie remembering whether the
          sidebar is folded, and browser storage remembering your selected workspace and dark-mode
          choice. These are needed for the app to work or are conveniences you set yourself; there
          are no advertising or analytics cookies. Public status pages set no cookies.
        </P>
      </Section>

      <Section title="Why we use it">
        <UL>
          <li>
            To provide the service you asked for: monitoring, scanning, alerts, status pages
            (contract).
          </li>
          <li>
            To keep Upzy secure and prevent abuse, such as rate limiting, the activity log and
            enforcing the Acceptable Use policy (our legitimate interest).
          </li>
          <li>
            To send you account and security emails such as confirmations and password resets
            (contract).
          </li>
          <li>
            To email status page subscribers the updates they asked for, only after they confirm
            (consent, which they can withdraw at any time with the link in every email).
          </li>
        </UL>
      </Section>

      <Section title="Who else handles data">
        <P>We use these to run Upzy; each receives only what it needs.</P>
        <UL>
          <li>
            <strong>Amazon Web Services:</strong> hosting, database and encrypted backups.
          </li>
          <li>
            <strong>An email delivery provider</strong> chosen by the operator of the service, for
            alerts, invitations, account emails and status updates. It sees the recipient address
            and the message.
          </li>
          <li>
            <strong>Dodo Payments,</strong> only if you buy a plan: the seller of record that takes
            payment and handles tax. It receives your name, email address and organization name for
            the purchase, and keeps your card details; we get back only the subscription&apos;s
            plan, status and dates.
          </li>
          <li>
            <strong>Let&apos;s Encrypt:</strong> only the domain name, when a status page uses your
            own domain.
          </li>
          <li>
            <strong>Public data sources</strong> we query while scanning, such as certificate
            transparency logs (crt.sh), vulnerability databases (NVD, OSV), CISA&apos;s exploited
            vulnerabilities list, EPSS and DNS resolvers. They receive hostnames and software names
            and versions that are already public, never your account data.
          </li>
          <li>
            <strong>Your AI provider,</strong> only if you turn AI on, using your own key and
            account. See{" "}
            <a href="/ai-data" className="underline underline-offset-4">
              AI data use
            </a>
            .
          </li>
        </UL>
        <P>
          We may disclose data if the law requires it, or to protect people from serious harm. We
          will tell you first unless we are not allowed to.
        </P>
      </Section>

      <Section title="How long we keep it">
        <UL>
          <li>
            Account and organization data: while your account is active, and until you ask us to
            delete it.
          </li>
          <li>
            Monitoring history (the result of each individual check): 90 days. Incidents and
            security findings are part of your account data and are kept as described above.
          </li>
          <li>
            When you delete your account or an organization in the app (Account page), it is removed
            from the live service straight away; if you ask us to do it instead, within 30 days.
            Encrypted backups are replaced on a 30-day cycle, so copies disappear from them within
            about 30 further days.
          </li>
          <li>
            Status page subscribers: an address that never confirms is removed after a week, and an
            address that unsubscribes is deleted immediately.
          </li>
          <li>
            Cached lookups of public data (vulnerability details and similar) expire on their own
            within days.
          </li>
        </UL>
      </Section>

      <Section title="How we protect it">
        <UL>
          <li>Everything travels over HTTPS.</li>
          <li>
            Passwords are hashed; provider keys and channel secrets are encrypted at rest with
            AES-256-GCM.
          </li>
          <li>Every query is scoped to your organization, and roles limit who can change what.</li>
          <li>
            Untrusted text is never executed, and AI is kept away from secrets (see AI data use).
          </li>
          <li>Backups are encrypted and stored where the server cannot delete them.</li>
        </UL>
        <P>
          No system is perfectly secure. If we learn of a breach affecting your data we will tell
          you promptly.
        </P>
      </Section>

      <Section title="Your rights">
        <P>
          You can ask us to give you a copy of your personal data, correct it, delete it, restrict
          or object to how we use it, or move it to another service, and you can withdraw consent at
          any time. Most of this you can do yourself in the app (edit your details, remove monitors
          and assets, unsubscribe from a status page, delete your account or an organization you own
          under Account). For anything else, write to <Contact />. If you think we have handled your
          data wrongly you can also complain to your local data protection authority.
        </P>
        <P>
          <strong>If you subscribed to a status page:</strong> the organization running that page
          chose to send you updates, and we send them for it. Use the unsubscribe link in any email
          to be removed at once.
        </P>
      </Section>

      <Section title="Where data is stored">
        <P>
          Data is stored in the region the operator picked for hosting, which may be outside your
          country. When data crosses borders we rely on the safeguards our providers offer, such as
          standard contractual clauses.
        </P>
      </Section>

      <Section title="Children">
        <P>
          Upzy is for people aged 16 and over. We don&apos;t knowingly collect data from children.
        </P>
      </Section>

      <Section title="Changes and contact">
        <P>
          If we change this policy in a way that matters we will tell you by email or in the app
          before it applies. Questions or requests: <Contact />
        </P>
      </Section>
    </LegalPage>
  );
}
