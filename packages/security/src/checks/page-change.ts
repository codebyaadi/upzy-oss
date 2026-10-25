import { BASELINE, type PageState } from "../page-state";
import type { Check, FindingDraft } from "../types";

const KINDS = [
  {
    key: "scripts",
    state: "scriptHosts",
    checkKey: "content.new_third_party_script",
    severity: "medium",
    title: (h: string) => `A new third-party script is loading from ${h}`,
    description: (h: string) =>
      `This page started loading JavaScript from ${h} after Upzy first looked at it. A script from another site runs with full access to the page, so one nobody meant to add is a common sign of a hacked site or a compromised vendor (card skimmers work this way).`,
    remediation: (h: string) =>
      `If your team added ${h} on purpose, ignore this finding. If not, find where the page includes it (the template, a tag manager, a plugin), remove it, and change the credentials that can edit the site.`,
  },
  {
    key: "forms",
    state: "formHosts",
    checkKey: "content.new_external_form_target",
    severity: "medium",
    title: (h: string) => `A form on this page now sends data to ${h}`,
    description: (h: string) =>
      `A form on this page started submitting to ${h}, another site, after Upzy first looked at it. Whatever visitors type into it (logins, card numbers) goes there. Attackers change a form's destination to steal data.`,
    remediation: (h: string) =>
      `If the form is meant to post to ${h} (a payment or newsletter provider), ignore this finding. If not, restore its action and look for how the page was changed.`,
  },
  {
    key: "frames",
    state: "frameHosts",
    checkKey: "content.new_third_party_frame",
    severity: "low",
    title: (h: string) => `A new embedded frame is loading from ${h}`,
    description: (h: string) =>
      `This page started embedding content from ${h} after Upzy first looked at it. Hidden frames are used to run malicious pages or ads inside a trusted site.`,
    remediation: (h: string) =>
      `If you embedded ${h} on purpose (a video, a map, a widget), ignore this finding. Otherwise find where it is included and remove it.`,
  },
] as const;

/**
 * Reports third-party scripts, frames and form targets that appeared on the page after Upzy first saw it. The first
 * scan only records what is there, so nothing is reported for a page's existing dependencies. A finding stays open while
 * the host is still on the page, and can be ignored when the change was intended.
 */
export const pageChangeCheck: Check = {
  family: "content",
  appliesTo: ["domain", "subdomain", "url"],
  async run({ page }) {
    if (!page) return [];
    const out: FindingDraft[] = [];
    for (const k of KINDS) {
      const state = page.state[k.state as keyof PageState] as Record<string, string>;
      for (const host of page.current[k.key]) {
        const firstSeen = state[host];
        if (!firstSeen || firstSeen === BASELINE) continue;
        out.push({
          checkKey: k.checkKey,
          subject: host,
          severity: k.severity,
          title: k.title(host),
          description: k.description(host),
          remediation: k.remediation(host),
          evidence: { host, firstSeen },
        });
      }
    }
    return out;
  },
};
