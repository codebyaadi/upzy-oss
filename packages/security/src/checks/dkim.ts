import { createPublicKey } from "node:crypto";

import type { Deps, FindingDraft } from "../types";

/*
 * DKIM keys live at <selector>._domainkey.<domain>, and the selector is chosen by whoever sends the mail, so it cannot
 * be discovered from outside. This probes the selectors the big providers and common sending services use. Finding no
 * key therefore proves little, which is why an unrecognised provider is reported as information only.
 */

const COMMON_SELECTORS = [
  "default",
  "dkim",
  "mail",
  "k1",
  "k2",
  "s1",
  "s2",
  "mandrill",
  "resend",
  "fm1",
  "fm2",
  "fm3",
  "protonmail",
  "protonmail2",
  "protonmail3",
];

export type DkimProvider = "google" | "microsoft";

/** The mail provider named by the MX records, when it is one whose selectors are fixed. */
export function dkimProvider(mx: { exchange: string }[]): {
  provider: DkimProvider | null;
  selectors: string[];
} {
  const hosts = mx.map((m) => m.exchange.toLowerCase().replace(/\.$/, ""));
  if (hosts.some((h) => /(^|\.)(google|googlemail)\.com$/.test(h)))
    return { provider: "google", selectors: ["google"] };
  if (hosts.some((h) => h.endsWith(".mail.protection.outlook.com")))
    return { provider: "microsoft", selectors: ["selector1", "selector2"] };
  return { provider: null, selectors: [] };
}

interface DkimKey {
  selector: string;
  /** Key type from k=, "rsa" when absent. */
  type: string;
  /** Base64 of the public key. Empty when the key was revoked (p=). */
  key: string;
  flags: string[];
}

function parseRecord(selector: string, record: string): DkimKey | null {
  const tags = new Map<string, string>();
  for (const part of record.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) tags.set(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim());
  }
  // Not a DKIM record unless it says so or carries a key tag (v= is optional in RFC 6376).
  if (!tags.has("p") && tags.get("v")?.toUpperCase() !== "DKIM1") return null;
  return {
    selector,
    type: (tags.get("k") ?? "rsa").toLowerCase(),
    key: (tags.get("p") ?? "").replace(/\s+/g, ""),
    flags: (tags.get("t") ?? "")
      .toLowerCase()
      .split(":")
      .map((f) => f.trim())
      .filter(Boolean),
  };
}

/** Modulus size of an RSA public key given as base64 (SubjectPublicKeyInfo, or a bare PKCS#1 key). Null if unreadable. */
export function rsaBits(base64: string): number | null {
  let der: Buffer;
  try {
    der = Buffer.from(base64, "base64");
  } catch {
    return null;
  }
  for (const type of ["spki", "pkcs1"] as const) {
    try {
      const bits = createPublicKey({ key: der, format: "der", type }).asymmetricKeyDetails
        ?.modulusLength;
      if (bits) return bits;
    } catch {
      // try the next encoding
    }
  }
  return null;
}

export async function dkimFindings(
  host: string,
  mx: { exchange: string }[],
  deps: Pick<Deps, "resolveTxt">,
): Promise<FindingDraft[]> {
  const { provider, selectors: fixed } = dkimProvider(mx);
  const selectors = [...new Set([...fixed, ...COMMON_SELECTORS])];

  let unsure = false;
  const probed = await Promise.all(
    selectors.map(async (selector) => {
      try {
        const txt = await deps.resolveTxt(`${selector}._domainkey.${host}`);
        // A long key is split into several strings of one record; they are joined without a separator.
        return txt
          .map((r) => parseRecord(selector, r.join("")))
          .filter((k): k is DkimKey => k !== null);
      } catch {
        // A timeout or SERVFAIL says nothing about whether the key exists.
        unsure = true;
        return [];
      }
    }),
  );
  const all = probed.flat();
  const live = all.filter((k) => k.key !== "");
  const revoked = all.filter((k) => k.key === "").map((k) => k.selector);

  const out: FindingDraft[] = [];

  if (live.length === 0) {
    // Without every lookup answering, "no key" could just be a network hiccup.
    if (unsure) return out;
    if (provider) {
      out.push({
        checkKey: "email.dkim_missing",
        severity: "low",
        title: `No DKIM key found for ${provider === "google" ? "Google Workspace" : "Microsoft 365"} mail`,
        description:
          "This domain's mail is hosted by a provider that signs outgoing mail with a DKIM key you publish in DNS, but no key was found at its usual selector. Without it, receivers cannot verify the mail really came from you, and DMARC cannot pass on a DKIM match. If you set DKIM up with a selector name of your own, Upzy cannot see it and this may be a false alarm.",
        remediation:
          provider === "google"
            ? "Generate a DKIM key in the Google Admin console and publish it in DNS, then turn on signing."
            : "Enable DKIM signing for the domain in Microsoft Defender and publish the two CNAME records it shows.",
        evidence: { provider, selectors: fixed, ...(revoked.length ? { revoked } : {}) },
      });
    } else {
      out.push({
        checkKey: "email.dkim_not_found",
        severity: "info",
        title: "No DKIM key found at common selectors",
        description:
          "Upzy looked for a DKIM key at the selectors most mail services use and found none. This is not necessarily a problem: DKIM selectors can't be listed from outside, so your provider may use one Upzy can't see. If you are not sure your mail is signed, send a message to a Gmail address and check 'Show original' for dkim=pass.",
        remediation:
          "Check your mail provider's documentation for how to enable DKIM signing and which DNS record to publish.",
        evidence: { selectors, ...(revoked.length ? { revoked } : {}) },
      });
    }
    return out;
  }

  for (const k of live) {
    if (k.type === "rsa") {
      const bits = rsaBits(k.key);
      if (bits !== null && bits <= 1024) {
        out.push({
          checkKey: "email.dkim_weak_key",
          subject: k.selector,
          severity: bits < 1024 ? "medium" : "low",
          title: `DKIM key "${k.selector}" is only ${bits} bits`,
          description:
            bits < 1024
              ? "RSA keys under 1024 bits can be broken with modest resources, which would let someone sign mail as your domain."
              : "1024-bit RSA keys are the weakest size still widely accepted, and RFC 8301 recommends 2048 bits.",
          remediation:
            "Generate a 2048-bit key in your mail provider, publish it under a new selector, switch signing to it, then remove the old record.",
          evidence: { selector: k.selector, bits },
        });
      }
    }
    if (k.flags.includes("y")) {
      out.push({
        checkKey: "email.dkim_testing",
        subject: k.selector,
        severity: "low",
        title: `DKIM key "${k.selector}" is in testing mode`,
        description:
          "The key's record has t=y, which tells receivers it is only being tested. RFC 6376 says mail signed with a testing key should be treated as unsigned.",
        remediation: "Remove `t=y` from the record once signing works.",
        evidence: { selector: k.selector },
      });
    }
  }
  return out;
}
