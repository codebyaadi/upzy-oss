import { BlockedTargetError } from "@upzy/probes";

import { matchProvider } from "../takeover-signatures";
import type { Check, FindingDraft } from "../types";

export const caaCheck: Check = {
  family: "dns",
  appliesTo: ["domain"],
  async run({ host, deps }) {
    const caa = await deps.resolveCaa(host);
    if (caa.length > 0) return [];
    return [
      {
        checkKey: "dns.caa_missing",
        severity: "info",
        title: "No CAA record",
        description:
          "Any certificate authority may issue certificates for this domain. A CAA record limits issuance to the CAs you choose.",
        remediation: 'Add a CAA record such as `0 issue "letsencrypt.org"` for the CA you use.',
      },
    ];
  },
};

export const takeoverCheck: Check = {
  family: "takeover",
  appliesTo: ["domain", "subdomain"],
  async run({ host, deps }) {
    const [target] = await deps.resolveCname(host);
    if (!target) return [];

    const out: FindingDraft[] = [];
    const addresses = await deps.resolveAddresses(target);
    if (addresses.length === 0) {
      out.push({
        checkKey: "takeover.dangling_cname",
        severity: "high",
        title: `CNAME points to a name that does not exist (${target})`,
        description:
          "The CNAME target no longer resolves. If it is on a service where names can be registered, an attacker can claim it and serve content on your domain.",
        remediation:
          "Delete the CNAME record if the service is no longer used, or recreate the resource it points to.",
        evidence: { cname: target },
      });
      return out;
    }

    const provider = matchProvider(target);
    if (provider) {
      try {
        const res = await deps.fetch(`http://${host}/`, { maxBodyBytes: 100_000 });
        if (res.body.includes(provider.fingerprint)) {
          out.push({
            checkKey: "takeover.vulnerable_service",
            subject: provider.provider,
            severity: "critical",
            title: `Subdomain takeover possible via ${provider.provider}`,
            description: `${host} is a CNAME to ${provider.provider} but the service reports no site is configured. Anyone can claim it and host content on your domain.`,
            remediation: `Remove the CNAME for ${host}, or claim the resource on ${provider.provider} so it is under your control.`,
            evidence: { cname: target, provider: provider.provider },
          });
        }
      } catch (e) {
        if (e instanceof BlockedTargetError) throw e;
      }
    }
    return out;
  },
};
