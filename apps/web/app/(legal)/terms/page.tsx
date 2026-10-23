import type { Metadata } from "next";

import { Contact, LegalPage, P, Section, UL } from "@/components/legal/legal-page";
import { legal } from "@/lib/legal";
import { pageMetadata } from "@/lib/seo";

export const dynamic = "force-dynamic";
export const metadata: Metadata = pageMetadata({
  title: "Terms of Service",
  description: "The terms of service for using Upzy.",
  path: "/terms",
});

export default function Terms() {
  const { entity, jurisdiction } = legal();
  return (
    <LegalPage
      title="Terms of Service"
      intro={`These terms are the agreement between you and ${entity} ("we", "us") for using Upzy. By creating an account or using the service you accept them. If you don't, please don't use Upzy.`}
    >
      <Section title="1. What Upzy is">
        <P>
          Upzy watches whether your websites and services are up, checks their public security
          posture (certificates, headers, email authentication, DNS), alerts you, lets you publish
          status pages, and can optionally use AI, with your own provider key, to explain what it
          finds.
        </P>
      </Section>

      <Section title="2. Your account">
        <UL>
          <li>Give accurate details and keep your password and sessions secure.</li>
          <li>
            You are responsible for what happens under your account and for the people you invite to
            your organization, including their roles.
          </li>
          <li>
            You must be old enough to form a binding contract where you live, and at least 16.
          </li>
        </UL>
      </Section>

      <Section title="3. You must be allowed to monitor and scan what you add">
        <P>
          You confirm that you own, or have permission to monitor and security-scan, every address,
          domain and subdomain you add to Upzy. The{" "}
          <a href="/acceptable-use" className="underline underline-offset-4">
            Acceptable Use policy
          </a>{" "}
          explains exactly what Upzy sends to them and what is not allowed.
        </P>
      </Section>

      <Section title="4. Your data and your content">
        <UL>
          <li>
            You keep all rights to your data: monitors, results, findings, status page text and
            anything else you put in.
          </li>
          <li>
            You give us permission to process it only to run the service for you, as described in
            the{" "}
            <a href="/privacy" className="underline underline-offset-4">
              Privacy Policy
            </a>
            .
          </li>
          <li>
            A status page is public once you publish it. You are responsible for what it says and
            for the messages you post to your subscribers.
          </li>
          <li>
            If people subscribe to your status page, their email addresses are used only to send
            them its updates. You must not export or use them for anything else.
          </li>
        </UL>
      </Section>

      <Section title="5. AI features">
        <P>
          AI features are off until an administrator of your organization turns them on, and they
          run only on a provider key that you supply. Your use of that provider is under your own
          agreement with them, and they bill you directly. AI output can be wrong or incomplete: it
          is a suggestion for you to check, never advice you should follow blindly. See{" "}
          <a href="/ai-data" className="underline underline-offset-4">
            AI data use
          </a>{" "}
          for exactly what is sent.
        </P>
      </Section>

      <Section title="6. Acceptable use">
        <P>
          You agree to follow the{" "}
          <a href="/acceptable-use" className="underline underline-offset-4">
            Acceptable Use policy
          </a>
          . We may remove content, pause monitors or scans, or suspend an account that breaks it,
          and will tell you why where we reasonably can.
        </P>
      </Section>

      <Section title="7. The service is provided as is">
        <P>
          Upzy is early software run by a small team. We work to keep it reliable, but we don&apos;t
          promise it will always be available, that every outage or vulnerability will be detected,
          or that an alert will always arrive. Don&apos;t make it the only safeguard for something
          that would cause serious harm if it failed, and keep a second way of knowing when your
          systems are down.
        </P>
        <P>
          We may change, add or remove features. If we make a change that significantly hurts how
          you use Upzy, we will give you reasonable notice.
        </P>
      </Section>

      <Section title="8. Plans and payment">
        <UL>
          <li>
            Upzy has a free plan and paid plans, listed with their limits on the{" "}
            <a href="/pricing" className="underline underline-offset-4">
              pricing page
            </a>
            . New accounts start with a 14-day trial of the Pro plan, with no card, and then stay on
            the free plan unless you choose a paid one.
          </li>
          <li>
            Payments are taken by our payment provider, Dodo Payments, which acts as the seller of
            record and handles card details and sales taxes such as VAT. We never see your card
            number.
          </li>
          <li>
            Subscriptions renew automatically each month or year until you cancel from Billing in
            the app. Cancelling stops the next renewal; you keep the plan until the period you paid
            for ends. Refunds are handled under the payment provider&apos;s terms and our discretion
            for billing errors.
          </li>
          <li>
            If a payment fails your plan stays on for a short grace period, then returns to the free
            plan. Limits only stop you adding more monitors, scanned domains, status pages or faster
            checks; they never switch off monitoring or alerts that already exist.
          </li>
          <li>
            We may change prices or plans. Changes apply to your next renewal and we will tell you
            beforehand.
          </li>
        </UL>
      </Section>

      <Section title="9. Ending things">
        <P>
          You can stop using Upzy at any time and ask us to delete your account and data (see the
          Privacy Policy). We may suspend or end your access if you break these terms or the
          Acceptable Use policy, if you put the service or other people at risk, or if we have to
          close the service, in which case we will give notice and a chance to take what you need.
        </P>
      </Section>

      <Section title="10. Our liability">
        <P>
          To the extent the law allows, the service comes without warranties of any kind, and we are
          not liable for indirect or consequential losses such as lost revenue, lost profit or lost
          data, or for outages or missed alerts. Our total liability for any claim relating to Upzy
          is limited to the greater of what you paid us in the 12 months before the claim and
          US$100. Nothing here limits liability that cannot be limited by law, such as for fraud or
          for death or personal injury caused by negligence.
        </P>
      </Section>

      <Section title="11. Changes to these terms">
        <P>
          We may update these terms. For material changes we will tell you by email or in the app
          before they apply. If you keep using Upzy after that, you accept the new terms. The date
          at the top shows when they last changed.
        </P>
      </Section>

      {jurisdiction && (
        <Section title="12. Governing law">
          <P>
            These terms are governed by the laws of {jurisdiction}, and its courts have
            jurisdiction, without affecting any rights you have under mandatory consumer law where
            you live.
          </P>
        </Section>
      )}

      <Section title={jurisdiction ? "13. Contact" : "12. Contact"}>
        <P>
          Questions about these terms: <Contact />
        </P>
      </Section>
    </LegalPage>
  );
}
