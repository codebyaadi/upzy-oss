import type { Check, FindingDraft } from "../types";

const DAY = 86_400_000;

export const tlsCheck: Check = {
  family: "tls",
  appliesTo: ["domain", "subdomain", "url"],
  async run({ host, deps }) {
    let info;
    try {
      info = await deps.tls(host);
    } catch (e) {
      // Nothing listening on 443 is a finding. Timeouts and resets are inconclusive.
      if ((e as { code?: string }).code === "ECONNREFUSED") {
        return [
          {
            checkKey: "tls.not_available",
            severity: "medium",
            title: "HTTPS is not available",
            description:
              "Nothing accepts connections on port 443, so traffic to this host cannot be encrypted.",
            remediation:
              "Serve the site over HTTPS with a certificate from a trusted CA (Let's Encrypt is free).",
          },
        ];
      }
      throw e;
    }

    const out: FindingDraft[] = [];
    if (info.validTo) {
      const days = Math.floor((info.validTo.getTime() - Date.now()) / DAY);
      if (days < 0) {
        out.push({
          checkKey: "tls.cert_expired",
          severity: "critical",
          title: "TLS certificate has expired",
          description: `The certificate expired ${-days} day(s) ago. Browsers show a full-page warning.`,
          remediation:
            "Renew the certificate immediately and automate renewal (e.g. certbot, your CDN or host).",
          evidence: { validTo: info.validTo.toISOString() },
        });
      } else if (days < 30) {
        out.push({
          checkKey: "tls.cert_expiring",
          severity: days < 14 ? "high" : "medium",
          title: `TLS certificate expires in ${days} day(s)`,
          description: "An expired certificate takes the site down for most visitors.",
          remediation: "Renew the certificate now and set up automatic renewal.",
          evidence: { validTo: info.validTo.toISOString(), daysLeft: days },
        });
      }
    }

    // An expired certificate is already reported above; avoid a duplicate "untrusted" finding for it.
    if (
      !info.authorized &&
      info.authorizationError &&
      info.authorizationError !== "CERT_HAS_EXPIRED"
    ) {
      const hostname = info.authorizationError === "ERR_TLS_CERT_ALTNAME_INVALID";
      out.push({
        checkKey: "tls.cert_untrusted",
        subject: info.authorizationError,
        severity: "high",
        title: hostname
          ? "TLS certificate does not match the hostname"
          : "TLS certificate is not trusted",
        description: hostname
          ? "The certificate was issued for a different name, so browsers will warn visitors."
          : `Clients cannot verify the certificate chain (${info.authorizationError}). Browsers will warn visitors.`,
        remediation:
          "Install a certificate from a trusted CA that covers this hostname, including the full intermediate chain.",
        evidence: { error: info.authorizationError },
      });
    }

    if (info.keyType === "RSA" && info.keyBits !== null && info.keyBits < 2048) {
      out.push({
        checkKey: "tls.weak_key",
        severity: "high",
        title: `Certificate uses a weak ${info.keyBits}-bit RSA key`,
        description: "RSA keys below 2048 bits can be factored with feasible resources.",
        remediation:
          "Reissue the certificate with a 2048-bit (or larger) RSA key, or an ECDSA P-256 key.",
        evidence: { bits: info.keyBits },
      });
    }

    if (info.protocol === "TLSv1" || info.protocol === "TLSv1.1") {
      out.push({
        checkKey: "tls.deprecated_protocol",
        severity: "medium",
        title: `Server negotiated ${info.protocol}`,
        description: "TLS 1.0 and 1.1 are deprecated and have known weaknesses.",
        remediation: "Disable TLS 1.0/1.1 and allow only TLS 1.2 and 1.3.",
        evidence: { protocol: info.protocol },
      });
    }
    return out;
  },
};
