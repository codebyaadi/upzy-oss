import type { Check, FindingDraft } from "../types";

const join = (records: string[][]) => records.map((r) => r.join("").trim());

export interface StsPolicy {
  version?: string;
  mode?: string;
  mx: string[];
  maxAge?: number;
}

/** Reads the key: value lines of an MTA-STS policy file (RFC 8461). */
export function parsePolicy(text: string): StsPolicy {
  const policy: StsPolicy = { mx: [] };
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (key === "version") policy.version = value;
    else if (key === "mode") policy.mode = value.toLowerCase();
    else if (key === "mx") policy.mx.push(value.toLowerCase());
    else if (key === "max_age" && /^\d+$/.test(value)) policy.maxAge = Number(value);
  }
  return policy;
}

/** A policy `mx` entry matches a host exactly, or `*.example.com` matches one label in front of example.com. */
export function mxMatches(pattern: string, host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  const p = pattern.toLowerCase().replace(/\.$/, "");
  if (!p.startsWith("*.")) return p === h;
  const suffix = p.slice(1); // ".example.com"
  return (
    h.endsWith(suffix) && !h.slice(0, -suffix.length).includes(".") && h.length > suffix.length
  );
}

/**
 * MTA-STS tells other mail servers to deliver to this domain only over verified TLS, which stops a network attacker
 * downgrading the connection and reading mail. TLS-RPT sends reports of failures. Only domains that receive mail are
 * looked at.
 */
export const mtaStsCheck: Check = {
  family: "email",
  appliesTo: ["domain"],
  async run({ host, deps }) {
    const mx = await deps.resolveMx(host);
    if (mx.length === 0 || (mx.length === 1 && mx[0]!.exchange === "")) return [];

    const records = join(await deps.resolveTxt(`_mta-sts.${host}`)).filter((t) =>
      /^v=STSv1\b/i.test(t),
    );
    if (records.length === 0)
      return [
        {
          checkKey: "email.mta_sts_missing",
          severity: "low",
          title: "No MTA-STS policy",
          description:
            "Without MTA-STS, a network attacker can strip encryption from mail sent to this domain and read it.",
          remediation: `Publish a policy at https://mta-sts.${host}/.well-known/mta-sts.txt and a TXT record \`_mta-sts.${host}\` with \`v=STSv1; id=<a new value each time the policy changes>\`. Start with \`mode: testing\`.`,
        },
      ];

    const out: FindingDraft[] = [];
    const policyUrl = `https://mta-sts.${host}/.well-known/mta-sts.txt`;
    let policy: StsPolicy | undefined;
    let problem: string | undefined;
    try {
      // Policies must not be fetched through redirects (RFC 8461).
      const res = await deps.fetch(policyUrl, {
        maxRedirects: 0,
        maxBodyBytes: 65_536,
        timeoutMs: 8000,
      });
      if (res.status !== 200) problem = `The policy address answered ${res.status}`;
      else {
        policy = parsePolicy(res.body);
        if (policy.version !== "STSv1") problem = "The policy does not start with version: STSv1";
        else if (!policy.mode || !["enforce", "testing", "none"].includes(policy.mode))
          problem = "The policy has no valid mode";
        else if (policy.mode !== "none" && policy.mx.length === 0)
          problem = "The policy lists no mx hosts";
        else if (policy.maxAge === undefined) problem = "The policy has no max_age";
      }
    } catch (e) {
      problem = `The policy could not be fetched (${e instanceof Error ? e.message : "error"})`;
    }

    if (problem || !policy) {
      out.push({
        checkKey: "email.mta_sts_policy_invalid",
        severity: "medium",
        title: "MTA-STS is published but its policy cannot be used",
        description: `The DNS record says this domain has an MTA-STS policy, but ${policyUrl} is not usable, so senders ignore MTA-STS (or, once they cached a policy, mail may be refused).`,
        remediation:
          "Serve a valid policy over HTTPS at that exact address, with no redirect: `version: STSv1`, `mode`, one `mx:` line per mail host, and `max_age`.",
        evidence: { policyUrl, reason: problem },
      });
    } else {
      if (policy.mode === "testing" || policy.mode === "none")
        out.push({
          checkKey: "email.mta_sts_not_enforced",
          severity: "low",
          title: `MTA-STS is in ${policy.mode} mode`,
          description:
            "The policy is published but senders are told not to enforce it, so downgrade attacks still work.",
          remediation:
            "After TLS reports (TLS-RPT) show no failures for a couple of weeks, change `mode` to `enforce` and publish a new `id`.",
          evidence: { mode: policy.mode },
        });
      if (policy.mode !== "none") {
        const uncovered = mx
          .map((m) => m.exchange.toLowerCase().replace(/\.$/, ""))
          .filter((h) => !policy!.mx.some((p) => mxMatches(p, h)));
        if (uncovered.length)
          out.push({
            checkKey: "email.mta_sts_mx_mismatch",
            severity: policy.mode === "enforce" ? "high" : "medium",
            title: "MTA-STS policy does not list all mail servers",
            description: `These MX hosts are not covered by the policy: ${uncovered.join(", ")}.${policy.mode === "enforce" ? " In enforce mode senders refuse to deliver to them, so mail is being lost." : ""}`,
            remediation:
              "Add an `mx:` line for each of them (or a `*.provider.com` pattern) and publish a new `id`.",
            evidence: { uncovered, policyMx: policy.mx },
          });
      }
    }

    const rpt = join(await deps.resolveTxt(`_smtp._tls.${host}`)).filter((t) =>
      /^v=TLSRPTv1\b/i.test(t),
    );
    if (rpt.length === 0)
      out.push({
        checkKey: "email.tls_rpt_missing",
        severity: "low",
        title: "No TLS-RPT record",
        description:
          "Without TLS-RPT you get no reports of senders that could not deliver mail securely, so MTA-STS problems go unnoticed.",
        remediation: `Publish a TXT record \`_smtp._tls.${host}\` with \`v=TLSRPTv1; rua=mailto:tls-reports@${host}\`.`,
      });
    return out;
  },
};
