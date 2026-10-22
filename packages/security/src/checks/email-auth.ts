import type { Check, FindingDraft } from "../types";

const join = (records: string[][]) => records.map((r) => r.join(""));

export const emailCheck: Check = {
  family: "email",
  appliesTo: ["domain"],
  async run({ host, deps }) {
    // Only domains that can receive mail are worth spoofing protection advice.
    const mx = await deps.resolveMx(host);
    if (mx.length === 0 || (mx.length === 1 && mx[0]!.exchange === "")) return [];

    const out: FindingDraft[] = [];
    const spf = join(await deps.resolveTxt(host)).filter((t) => /^v=spf1(\s|$)/i.test(t));
    if (spf.length === 0) {
      out.push({
        checkKey: "email.spf_missing",
        severity: "medium",
        title: "No SPF record",
        description:
          "Without SPF, receivers cannot tell which servers may send mail for this domain, which makes spoofing easier.",
        remediation: "Publish a TXT record such as `v=spf1 include:_spf.your-provider.com -all`.",
      });
    } else if (spf.length > 1) {
      out.push({
        checkKey: "email.spf_multiple",
        severity: "medium",
        title: "Multiple SPF records",
        description:
          "More than one SPF record is invalid (RFC 7208) and causes SPF to fail entirely.",
        remediation: "Merge them into a single `v=spf1` record.",
        evidence: { count: spf.length },
      });
    } else {
      const record = spf[0]!;
      const all = /\s([+?~-]?)all\b/i.exec(record)?.[1];
      if (all === "+" || all === "?" || (all === undefined && /\sall\b/i.test(record))) {
        out.push({
          checkKey: "email.spf_permissive",
          severity: "high",
          title: "SPF allows any server to send mail",
          description:
            "The record ends in `+all` or `?all`, so it offers no protection against spoofing.",
          remediation: "End the record with `-all` (or `~all` while rolling out).",
          evidence: { record },
        });
      } else if (all === undefined && !/\bredirect=/i.test(record)) {
        out.push({
          checkKey: "email.spf_no_all",
          severity: "low",
          title: "SPF record has no default policy",
          description:
            "Without a trailing `all` mechanism, unlisted servers are treated as neutral.",
          remediation: "End the record with `-all` or `~all`.",
          evidence: { record },
        });
      }
    }

    const dmarc = join(await deps.resolveTxt(`_dmarc.${host}`)).filter((t) =>
      /^v=DMARC1\b/i.test(t),
    );
    if (dmarc.length === 0) {
      out.push({
        checkKey: "email.dmarc_missing",
        severity: "medium",
        title: "No DMARC record",
        description:
          "Without DMARC, receivers have no instruction for mail that fails SPF/DKIM, and you get no spoofing reports.",
        remediation:
          "Publish `_dmarc` TXT: `v=DMARC1; p=none; rua=mailto:dmarc@your-domain` and tighten to quarantine/reject once reports look clean.",
      });
    } else {
      const policy = /\bp=(\w+)/i.exec(dmarc[0]!)?.[1]?.toLowerCase();
      if (policy === "none") {
        out.push({
          checkKey: "email.dmarc_monitor_only",
          severity: "low",
          title: "DMARC policy is monitor-only (p=none)",
          description: "Spoofed mail is reported but still delivered.",
          remediation: "Move to `p=quarantine`, then `p=reject`, once legitimate senders pass.",
          evidence: { record: dmarc[0] },
        });
      }
    }
    return out;
  },
};
