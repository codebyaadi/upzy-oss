import type { Metadata } from "next";

import { Contact, LegalPage, P, Section, UL } from "@/components/legal/legal-page";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "AI data use" };

export default function AiData() {
  return (
    <LegalPage
      title="AI data use"
      intro="Upzy's AI features are optional, off by default, and run only on an API key that your organization provides. This page lists exactly what is sent to the AI provider you choose, and what keeps it safe."
    >
      <Section title="You are in control">
        <UL>
          <li>AI is off for every organization until an administrator turns it on in Settings.</li>
          <li>
            There is no shared Upzy key. Nothing is sent to any AI provider unless your organization
            has saved its own key for it (Groq, OpenAI, Anthropic, Google Gemini or OpenRouter) and
            AI is switched on.
          </li>
          <li>
            You pick the provider and model. Requests go to that provider under your own account and
            terms, and it bills you directly. Upzy shows usage and estimated cost.
          </li>
          <li>
            An administrator can delete the key or switch AI off at any time, and everything keeps
            working without it: monitoring, alerts, scans and the built-in fix instructions never
            depend on AI.
          </li>
        </UL>
      </Section>

      <Section title="What is sent, feature by feature">
        <UL>
          <li>
            <strong>Finding explanations:</strong> the finding&apos;s title, description and
            evidence (such as headers or DNS values from your own site), the asset&apos;s name, and
            the detected stack.
          </li>
          <li>
            <strong>Incident analysis and group summaries:</strong> facts Upzy collected about the
            incident: check results, DNS and TLS details, timing, and which other incidents opened
            around the same time.
          </li>
          <li>
            <strong>Postmortem drafts:</strong> the incident facts, plus any notes you type in.
          </li>
          <li>
            <strong>Monitor suggestions from plain text:</strong> the sentence you wrote.
          </li>
          <li>
            <strong>Weekly digest:</strong> counts and summaries for the week, not raw data.
          </li>
          <li>
            <strong>New-subdomain labels:</strong> what one anonymous request to the host showed
            (status code, page title, server name, redirect target).
          </li>
          <li>
            <strong>Copilot chat:</strong> your questions, and the results of read-only lookups in
            your own organization&apos;s data that the assistant asks for to answer them.
          </li>
        </UL>
        <P>
          Never sent: your password or session, other organizations&apos; data, or other
          members&apos; email addresses. The copilot can only read: it cannot change, delete or send
          anything.
        </P>
      </Section>

      <Section title="Safeguards">
        <UL>
          <li>
            <strong>Redaction before sending:</strong> credentials, tokens, cookies, email addresses
            and long random-looking strings are replaced with placeholders. Redaction catches common
            patterns and is not perfect, so don&apos;t type secrets into free-text fields.
          </li>
          <li>
            <strong>Untrusted text is treated as data:</strong> content from external systems (page
            titles, headers, DNS records) is marked as untrusted, stripped of hidden characters, and
            the model is told never to follow instructions found in it.
          </li>
          <li>
            <strong>Suggestions, not actions:</strong> AI output is shown for you to review. It
            never changes your monitors, alerts or settings on its own, and answers that refer to
            specific records only cite ones Upzy actually returned.
          </li>
          <li>
            <strong>Your key is encrypted</strong> at rest, only its last four characters are ever
            displayed, and it is used only for your organization&apos;s requests.
          </li>
          <li>
            <strong>Limits:</strong> a daily token budget per organization and rate limits cap how
            much can be used.
          </li>
        </UL>
      </Section>

      <Section title="What happens to the data afterwards">
        <UL>
          <li>
            <strong>Upzy</strong> doesn&apos;t use your data to train models. It keeps usage counts,
            token counts and estimated cost, plus the results shown in the app, and may cache a
            result for up to a week so the same question isn&apos;t paid for twice. It does not keep
            a log of prompts.
          </li>
          <li>
            <strong>Your AI provider</strong> handles requests under the terms of your account with
            them. Whether they retain or train on API data depends on that agreement, so check it
            before turning AI on, especially for sensitive systems.
          </li>
        </UL>
      </Section>

      <Section title="Questions">
        <P>
          Ask us anything about this at <Contact />. See also the{" "}
          <a href="/privacy" className="underline underline-offset-4">
            Privacy Policy
          </a>
          .
        </P>
      </Section>
    </LegalPage>
  );
}
