import type { Check, FindingDraft } from "../types";
import { dkimFindings } from "./dkim";

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
    } else if (dmarc.length > 1) {
      // RFC 7489 section 6.6.3: with more than one record receivers apply no DMARC at all, so the other checks
      // below would be judging a record nobody reads.
      out.push({
        checkKey: "email.dmarc_multiple",
        severity: "medium",
        title: "Multiple DMARC records",
        description:
          "More than one DMARC record is invalid (RFC 7489): receivers then ignore DMARC entirely, so spoofed mail is not handled by your policy.",
        remediation: "Merge them into a single `v=DMARC1` record and delete the others.",
        evidence: { count: dmarc.length },
      });
    } else {
      const record = dmarc[0]!;
      const tags = new Map<string, string>();
      for (const part of record.split(";")) {
        const i = part.indexOf("=");
        if (i > 0) tags.set(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim());
      }
      const policy = tags.get("p")?.toLowerCase();
      if (policy === undefined || !["none", "quarantine", "reject"].includes(policy)) {
        out.push({
          checkKey: "email.dmarc_invalid_policy",
          severity: "medium",
          title: policy === undefined ? "DMARC record has no policy" : "DMARC policy is not valid",
          description:
            policy === undefined
              ? "The record has no `p=` tag, so receivers cannot tell what to do with mail that fails."
              : `The policy \`p=${policy}\` is not one of none, quarantine or reject, so receivers cannot use it.`,
          remediation: "Set `p=none`, `p=quarantine` or `p=reject`.",
          evidence: { record, ...(policy !== undefined ? { policy } : {}) },
        });
      } else if (policy === "none") {
        out.push({
          checkKey: "email.dmarc_monitor_only",
          severity: "low",
          title: "DMARC policy is monitor-only (p=none)",
          description: "Spoofed mail is reported but still delivered.",
          remediation: "Move to `p=quarantine`, then `p=reject`, once legitimate senders pass.",
          evidence: { record },
        });
      }
      if (!/(^|[\s,])mailto:[^\s,;]+/i.test(tags.get("rua") ?? "")) {
        out.push({
          checkKey: "email.dmarc_no_reports",
          severity: "low",
          title: "DMARC sends no reports",
          description:
            "Without an `rua=mailto:` address you get no reports of who is sending mail as your domain, so you cannot tell what a stricter policy would block.",
          remediation: "Add `rua=mailto:dmarc@your-domain` (or a DMARC report service's address).",
          evidence: { record, ...(policy !== undefined ? { policy } : {}) },
        });
      }
    }

    out.push(...(await dkimFindings(host, mx, deps)));
    return out;
  },
};
