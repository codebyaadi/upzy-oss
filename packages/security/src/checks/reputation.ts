import type { Check, FindingDraft } from "../types";

const THREATS: Record<string, string> = {
  MALWARE: "malware",
  SOCIAL_ENGINEERING: "phishing or deceptive content",
  UNWANTED_SOFTWARE: "unwanted software",
  POTENTIALLY_HARMFUL_APPLICATION: "potentially harmful applications",
};

/** Google Safe Browsing. Needs GOOGLE_SAFE_BROWSING_KEY; without a key it reports nothing. */
export const reputationCheck: Check = {
  family: "reputation",
  appliesTo: ["domain", "subdomain", "url"],
  timeoutMs: 20_000,
  async run({ url, deps }) {
    if (!deps.safeBrowsingKey) return [];
    const res = await deps.fetch(
      `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${encodeURIComponent(deps.safeBrowsingKey)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client: { clientId: "upzy", clientVersion: "1" },
          threatInfo: {
            threatTypes: Object.keys(THREATS),
            platformTypes: ["ANY_PLATFORM"],
            threatEntryTypes: ["URL"],
            threatEntries: [{ url }],
          },
        }),
        maxBodyBytes: 100_000,
      },
    );
    // Don't echo the response: an error body can repeat the request, key included.
    if (res.status !== 200) throw new Error(`Safe Browsing answered ${res.status}`);
    let matches: { threatType?: string }[] = [];
    try {
      matches = (JSON.parse(res.body) as { matches?: { threatType?: string }[] }).matches ?? [];
    } catch {
      throw new Error("Safe Browsing returned something unreadable");
    }
    const types = [...new Set(matches.map((m) => m.threatType ?? ""))].filter((t) => t in THREATS);
    return types.map((t): FindingDraft => ({
      checkKey: "reputation.flagged_unsafe",
      subject: t,
      severity: "critical",
      title: `Google Safe Browsing flags this site for ${THREATS[t]}`,
      description:
        "Chrome, Firefox and Safari show a full-page red warning to visitors of flagged sites, and search engines may drop them. It often means the site was hacked.",
      remediation:
        "Find and remove what was injected (check recently changed files, plugins and admin accounts, and change passwords), then request a review in Google Search Console under Security issues.",
      evidence: { threatType: t },
    }));
  },
};
