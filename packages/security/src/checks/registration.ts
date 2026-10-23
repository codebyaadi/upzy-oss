import type { Check, Deps, FindingDraft } from "../types";

const DAY = 86_400_000;

/** RDAP is the machine-readable WHOIS. rdap.org redirects each name to the registry that holds it. */
export const RDAP_URL = (host: string) => `https://rdap.org/domain/${encodeURIComponent(host)}`;

interface Rdap {
  status?: string[];
  events?: { eventAction?: string; eventDate?: string }[];
}

const json = <T>(body: string): T | null => {
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
};

/** When the registration runs out, and a lifecycle state that means it already has. */
export const registrationCheck: Check = {
  family: "registration",
  appliesTo: ["domain"],
  timeoutMs: 20_000,
  async run({ host, deps }) {
    const res = await deps.fetch(RDAP_URL(host), {
      headers: { accept: "application/rdap+json, application/json" },
      maxBodyBytes: 500_000,
    });
    // Not every registry offers RDAP. "Can't tell" is not a finding.
    if (res.status === 404) return [];
    if (res.status !== 200) throw new Error(`RDAP lookup answered ${res.status}`);
    const doc = json<Rdap>(res.body);
    if (!doc) throw new Error("RDAP lookup returned something unreadable");

    const out: FindingDraft[] = [];
    const states = (doc.status ?? []).map((s) => s.toLowerCase());
    const lapsed = states.find((s) => s.includes("redemption") || s.includes("pending delete"));
    if (lapsed) {
      out.push({
        checkKey: "registration.lapsed",
        severity: "critical",
        title: "The domain registration has lapsed",
        description: `The registry lists this domain as "${lapsed}". It is past its end date and may be deleted and registered by someone else.`,
        remediation:
          "Renew the domain with your registrar now. Many registrars charge a redemption fee at this stage.",
        evidence: { status: lapsed },
      });
      return out;
    }

    const raw = doc.events?.find((e) => e.eventAction === "expiration")?.eventDate;
    const expires = raw ? new Date(raw) : null;
    if (!expires || Number.isNaN(expires.getTime())) return out;
    const days = Math.floor((expires.getTime() - Date.now()) / DAY);
    if (days < 30) {
      out.push({
        checkKey: "registration.expiring",
        severity: days < 0 ? "critical" : days < 14 ? "high" : "medium",
        title:
          days < 0
            ? `The domain expired ${-days} day(s) ago`
            : `The domain registration expires in ${days} day(s)`,
        description:
          "When a domain expires its website, email and everything else on it stop working, and it can be taken by someone else.",
        remediation:
          "Renew the domain with your registrar and turn on auto-renew. Check that the card on file is valid and that renewal notices reach a mailbox someone reads.",
        evidence: { expires: expires.toISOString(), daysLeft: days },
      });
    }
    return out;
  },
};

const DOH = (host: string, type: string, cd = false) =>
  `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}${cd ? "&cd=1" : ""}`;

interface DohAnswer {
  Status: number;
  Answer?: { type: number }[];
}

async function doh(deps: Deps, host: string, type: string, cd = false): Promise<DohAnswer> {
  const res = await deps.fetch(DOH(host, type, cd), {
    headers: { accept: "application/dns-json" },
    maxBodyBytes: 100_000,
  });
  const doc = res.status === 200 ? json<DohAnswer>(res.body) : null;
  if (!doc || typeof doc.Status !== "number") throw new Error("DNSSEC lookup failed");
  return doc;
}

/** Whether the domain is signed, and whether the signatures still validate. */
export const dnssecCheck: Check = {
  family: "dnssec",
  appliesTo: ["domain"],
  timeoutMs: 20_000,
  async run({ host, deps }) {
    const ds = await doh(deps, host, "DS");
    const signed = ds.Status === 0 && (ds.Answer ?? []).some((a) => a.type === 43);
    if (!signed) {
      return [
        {
          checkKey: "dnssec.not_enabled",
          severity: "info",
          title: "DNSSEC is not enabled",
          description:
            "DNSSEC lets resolvers check that answers for this domain were not forged on the way. Without it, a poisoned DNS answer can send visitors to the wrong server.",
          remediation:
            "Turn on DNSSEC at your DNS host, then add the DS record it gives you at your registrar. Many hosts (Cloudflare, Route 53, Google Cloud DNS) do the signing for you.",
        },
      ];
    }
    // Signed, so a validating resolver that gets SERVFAIL while a non-validating one answers means broken signatures.
    const checked = await doh(deps, host, "A");
    if (checked.Status !== 2) return [];
    const unchecked = await doh(deps, host, "A", true);
    if (unchecked.Status !== 0) return [];
    return [
      {
        checkKey: "dnssec.validation_failed",
        severity: "high",
        title: "DNSSEC signatures do not validate",
        description:
          "The domain has a DS record but its answers fail validation. Resolvers that check DNSSEC, including many big networks and public DNS, treat the domain as unreachable.",
        remediation:
          "Check that the DS record at your registrar matches the key your DNS host signs with, and that the signatures have not expired. If you moved DNS providers, remove the old DS record or add the new one.",
      } satisfies FindingDraft,
    ];
  },
};
