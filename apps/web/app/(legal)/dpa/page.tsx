import type { Metadata } from "next";

import { Contact, LegalPage, P, Section, UL } from "@/components/legal/legal-page";
import { legal } from "@/lib/legal";
import { pageMetadata } from "@/lib/seo";

export const dynamic = "force-dynamic";
export const metadata: Metadata = pageMetadata({
  title: "Data Processing Agreement",
  description:
    "The data processing terms for business customers: what Upzy processes for you, the sub-processors it uses, security measures, and how to get a countersigned copy.",
  path: "/dpa",
});

export default function Dpa() {
  const { entity, jurisdiction } = legal();
  return (
    <LegalPage
      title="Data Processing Agreement"
      intro={`This agreement applies when ${entity} ("we", "Upzy") processes personal data on behalf of a business that uses Upzy ("you", the customer). It forms part of the Terms of Service and applies automatically once you use the service; email us if you want a countersigned copy.`}
    >
      <Section title="1. Roles and scope">
        <UL>
          <li>
            For the personal data you put into Upzy, such as your team members&apos; email
            addresses, status page subscribers, and anything found in monitored systems, you are the
            controller and we are the processor. We process it only to provide the service and on
            your documented instructions, which are the Terms, this agreement and your use of the
            settings in the app.
          </li>
          <li>
            For our own account, billing and security records about you (the data described in the
            Privacy Policy), we are an independent controller.
          </li>
          <li>
            If we think an instruction breaks data protection law, we will tell you and may pause
            that part of the processing.
          </li>
        </UL>
      </Section>

      <Section title="2. What we process">
        <UL>
          <li>
            <strong>Subjects:</strong> your team members and invited users, status page subscribers,
            and any individual whose data appears in the targets you monitor or scan.
          </li>
          <li>
            <strong>Data:</strong> names, email addresses, roles and sign-in details; subscriber
            email addresses; alert channel details you provide; monitoring results, incidents and
            scan findings; and content you type, such as incident notes.
          </li>
          <li>
            <strong>Purpose and duration:</strong> providing, securing and supporting the service,
            for as long as your account exists, plus the deletion period in section 8.
          </li>
          <li>
            The service is not intended to hold special categories of data, and you should not put
            them in free-text fields.
          </li>
        </UL>
      </Section>

      <Section title="3. Our obligations">
        <UL>
          <li>Keep the data confidential and limit access to people who need it to run Upzy.</li>
          <li>Apply the security measures in section 5.</li>
          <li>
            Not sell the data, use it to train models, or use it for our own marketing. AI features
            run only on your own provider key, as described in the AI data use page.
          </li>
          <li>
            Help you answer requests from people exercising their rights. Most can be done in the
            app (editing, exporting, deleting); for the rest, write to us and we will respond within
            a reasonable time.
          </li>
          <li>
            Help with your data protection impact assessments and consultations with regulators,
            where they relate to the service, if you ask.
          </li>
          <li>
            Give you the information you reasonably need to confirm we meet this agreement, and
            allow an audit once a year (remote, by questionnaire first) with fair notice, at your
            cost, without exposing other customers&apos; data.
          </li>
        </UL>
      </Section>

      <Section title="4. Sub-processors">
        <P>
          You agree to the sub-processors below. We will update this list before adding or replacing
          one. If you object on reasonable data protection grounds, tell us and we will work with
          you, or you can end your subscription and delete your data.
        </P>
        <UL>
          <li>
            <strong>Amazon Web Services:</strong> hosting, database and encrypted backups.
          </li>
          <li>
            <strong>Email delivery provider</strong> (Resend, or the operator&apos;s own SMTP
            server): alerts, invitations, account emails and status updates.
          </li>
          <li>
            <strong>Dodo Payments:</strong> payment and tax, only if you buy a plan. It acts as
            seller of record and as its own controller of payment details.
          </li>
          <li>
            <strong>Let&apos;s Encrypt:</strong> certificates for custom status page domains. It
            receives the domain name only.
          </li>
          <li>
            <strong>Your own AI provider and alert destinations</strong> (Slack, Discord, Microsoft
            Teams, PagerDuty, Opsgenie, GitHub or your webhooks): these are services you choose and
            connect, and they receive data under your own account and terms, not as our
            sub-processors.
          </li>
        </UL>
        <P>
          Where we use a sub-processor, we bind it to protections no weaker than these, and remain
          responsible for it.
        </P>
      </Section>

      <Section title="5. Security measures">
        <UL>
          <li>Everything travels over HTTPS.</li>
          <li>
            Two-factor sign-in with an authenticator app is available to every user, and an
            organization can require it for all of its members.
          </li>
          <li>
            Passwords are hashed. Provider keys, tokens and channel secrets are encrypted at rest
            with AES-256-GCM and never shown again after you save them.
          </li>
          <li>
            Every query is scoped to your organization; roles limit who can change what, and an
            organization can restrict a person to only the workspaces they need.
          </li>
          <li>
            Outgoing requests to monitored targets are blocked from reaching private networks.
          </li>
          <li>Backups are encrypted and stored where the server cannot delete them.</li>
          <li>
            Dependencies are scanned for known vulnerabilities on every change, and the code is open
            for inspection.
          </li>
        </UL>
      </Section>

      <Section title="6. Personal data breaches">
        <P>
          If we become aware of a breach of security affecting your personal data, we will tell you
          without undue delay, and in any case within 72 hours of becoming aware, with what we know
          about what happened, the data affected and what we are doing about it, and we will keep
          you updated as we learn more.
        </P>
      </Section>

      <Section title="7. International transfers">
        <P>
          Data is hosted in the region the operator chose for the service. If personal data from the
          EEA, UK or Switzerland is transferred to a country without an adequacy decision, the
          parties rely on the standard contractual clauses (controller to processor) and the UK
          addendum, which are incorporated here by reference and apply to those transfers. We will
          sign them separately on request.
        </P>
      </Section>

      <Section title="8. Return and deletion">
        <P>
          You can export or delete your data in the app at any time. When you delete an organization
          or your account, it is removed from the live service straight away, and from encrypted
          backups within about 30 further days. After the agreement ends we delete the remaining
          personal data unless the law requires us to keep it, and we will confirm deletion if you
          ask.
        </P>
      </Section>

      <Section title="9. General">
        <UL>
          <li>
            Each party&apos;s liability under this agreement is subject to the limits in the Terms
            of Service.
          </li>
          <li>
            If this agreement and the Terms conflict about personal data, this agreement prevails.
          </li>
          {jurisdiction && <li>This agreement is governed by the law of {jurisdiction}.</li>}
          <li>
            We may update this agreement for legal or service reasons, and will tell you about
            changes that matter before they take effect.
          </li>
        </UL>
      </Section>

      <Section title="Get a countersigned copy">
        <P>
          Write to <Contact /> with your company&apos;s legal name, address and the person who
          should sign, and we will send a signed copy. This page is a standard template and not
          legal advice; if your organization needs different terms, tell us.
        </P>
        <P>
          See also the{" "}
          <a href="/privacy" className="underline underline-offset-4">
            Privacy Policy
          </a>{" "}
          and{" "}
          <a href="/ai-data" className="underline underline-offset-4">
            AI data use
          </a>
          .
        </P>
      </Section>
    </LegalPage>
  );
}
