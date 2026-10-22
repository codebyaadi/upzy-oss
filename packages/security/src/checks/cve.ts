import type { Check, FindingDraft } from "../types";
import { assessComponents, detectComponents } from "../vuln";
import type { Assessment } from "../vuln/types";

const TOP = 10;

const CAVEAT =
  "This is based on the version the server or page reports. Distributions often backport security fixes without changing the version, so confirm against your vendor's advisory before treating it as confirmed.";

function toFinding({ component, vulns, severity }: Assessment): FindingDraft {
  const kevCount = vulns.filter((v) => v.kev).length;
  const fixedIn = vulns
    .map((v) => v.fixedIn)
    .filter((f): f is string => !!f)
    .sort()
    .at(-1);
  const n = vulns.length;
  const maxEpss = Math.max(0, ...vulns.map((v) => v.epss ?? 0));

  return {
    checkKey: "cve.vulnerable_component",
    subject: `${component.product}@${component.version}`,
    severity,
    title: `${component.display} ${component.version} has ${n} known vulnerabilit${n === 1 ? "y" : "ies"}${kevCount ? ` (${kevCount} exploited in the wild)` : ""}`,
    description: `${component.display} ${component.version} was detected (${component.detectedFrom}) and matches ${n} published vulnerabilit${n === 1 ? "y" : "ies"}.${kevCount ? ` ${kevCount} of them ${kevCount === 1 ? "is" : "are"} listed in CISA's Known Exploited Vulnerabilities catalogue, meaning attackers are actively using ${kevCount === 1 ? "it" : "them"}.` : ""} ${CAVEAT}`,
    remediation: fixedIn
      ? `Upgrade ${component.display} to ${fixedIn} or later (the newest fix listed across these advisories), or the latest supported release.`
      : `Upgrade ${component.display} to the latest supported release, or apply your vendor's security patches. If you cannot upgrade, hide the version banner and review the listed advisories for mitigations.`,
    evidence: {
      product: component.display,
      version: component.version,
      detectedFrom: component.detectedFrom,
      total: n,
      kevCount,
      // The most urgent first. The rest are still counted in `total`.
      cves: vulns.slice(0, TOP).map((v) => ({
        id: v.id,
        severity: v.severity,
        cvss: v.cvss,
        kev: v.kev,
        epss: v.epss,
        fixedIn: v.fixedIn,
        summary: v.summary,
      })),
    },
    risk: { kev: kevCount > 0, epss: maxEpss },
  };
}

/**
 * Detects versioned software on the page (server headers, CMS generator tag, front-end libraries)
 * and reports the known CVEs that apply, prioritised by KEV and EPSS. One finding per component.
 */
export const cveCheck: Check = {
  family: "cve",
  appliesTo: ["domain", "subdomain", "url"],
  // NVD is rate limited to one request every few seconds without an API key.
  timeoutMs: 180_000,
  async run({ url, deps }) {
    const page = await deps.fetch(url);
    const components = detectComponents(page);
    if (components.length === 0) return [];
    return (await assessComponents(deps.vuln, components)).map(toFinding);
  },
};
