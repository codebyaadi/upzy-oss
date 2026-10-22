import { BlockedTargetError } from "@upzy/probes";

import type { Check, FindingDraft } from "../types";

const HSTS_MIN_AGE = 15_552_000; // 180 days

const MIXED_CONTENT = /<(?:script|iframe|link)\b[^>]*\b(?:src|href)=["']http:\/\/[^"']+/i;

function parseCookie(raw: string) {
  const [pair = "", ...attrs] = raw.split(";").map((p) => p.trim());
  const flags = new Set(attrs.map((a) => a.split("=")[0]!.toLowerCase()));
  return {
    name: pair.split("=")[0]!,
    secure: flags.has("secure"),
    httpOnly: flags.has("httponly"),
    sameSite: flags.has("samesite"),
  };
}

export const headersCheck: Check = {
  family: "headers",
  appliesTo: ["domain", "subdomain", "url"],
  async run({ url, host, deps }) {
    const out: FindingDraft[] = [];
    const res = await deps.fetch(url);
    const h = res.headers;
    const https = res.finalUrl.startsWith("https:");

    if (https) {
      const hsts = h["strict-transport-security"];
      if (!hsts) {
        out.push({
          checkKey: "headers.hsts_missing",
          severity: "medium",
          title: "HSTS header is missing",
          description:
            "Without Strict-Transport-Security, browsers can be tricked into using plain HTTP on first visit, which allows downgrade and interception attacks.",
          remediation:
            "Send `Strict-Transport-Security: max-age=31536000; includeSubDomains` on all HTTPS responses.",
        });
      } else {
        const maxAge = Number(/max-age=(\d+)/i.exec(hsts)?.[1] ?? 0);
        if (maxAge < HSTS_MIN_AGE) {
          out.push({
            checkKey: "headers.hsts_weak",
            severity: "low",
            title: "HSTS max-age is too short",
            description: `HSTS is enabled but only for ${Math.round(maxAge / 86400)} days, so the protection lapses quickly.`,
            remediation: "Raise max-age to at least 15552000 (180 days), ideally 31536000.",
            evidence: { header: hsts },
          });
        }
      }
    }

    const csp = h["content-security-policy"];
    if (!csp) {
      out.push({
        checkKey: "headers.csp_missing",
        severity: "medium",
        title: "Content-Security-Policy header is missing",
        description:
          "A CSP limits where scripts and other resources can load from, which is the main browser-side defence against cross-site scripting.",
        remediation:
          "Start with `Content-Security-Policy-Report-Only: default-src 'self'`, fix violations, then enforce it.",
      });
    }

    if (!h["x-frame-options"] && !/frame-ancestors/i.test(csp ?? "")) {
      out.push({
        checkKey: "headers.clickjacking_missing",
        severity: "low",
        title: "Page can be embedded in other sites (clickjacking)",
        description:
          "Neither X-Frame-Options nor a CSP frame-ancestors directive is set, so other sites can frame this page and trick users into clicking.",
        remediation:
          "Send `Content-Security-Policy: frame-ancestors 'self'` (or `X-Frame-Options: SAMEORIGIN`).",
      });
    }

    if (h["x-content-type-options"]?.toLowerCase() !== "nosniff") {
      out.push({
        checkKey: "headers.nosniff_missing",
        severity: "low",
        title: "X-Content-Type-Options: nosniff is missing",
        description:
          "Browsers may guess a response's content type and execute uploaded files as scripts.",
        remediation: "Send `X-Content-Type-Options: nosniff`.",
      });
    }

    if (!h["referrer-policy"]) {
      out.push({
        checkKey: "headers.referrer_policy_missing",
        severity: "info",
        title: "Referrer-Policy header is missing",
        description:
          "Full URLs, including query strings, may leak to third-party sites through the Referer header.",
        remediation: "Send `Referrer-Policy: strict-origin-when-cross-origin`.",
      });
    }

    if (!h["permissions-policy"]) {
      out.push({
        checkKey: "headers.permissions_policy_missing",
        severity: "info",
        title: "Permissions-Policy header is missing",
        description:
          "Powerful browser features (camera, microphone, geolocation) are not explicitly restricted.",
        remediation:
          "Send `Permissions-Policy: camera=(), microphone=(), geolocation=()` and allow only what you use.",
      });
    }

    const disclosed = [h["server"], h["x-powered-by"]].filter(
      (v): v is string => !!v && /\d+\.\d+/.test(v),
    );
    if (disclosed.length > 0) {
      out.push({
        checkKey: "headers.version_disclosed",
        severity: "low",
        title: "Server software version is disclosed",
        description: "Version banners help attackers pick exploits for known vulnerabilities.",
        remediation:
          "Remove version details from the Server and X-Powered-By headers (e.g. `server_tokens off;` in nginx).",
        evidence: { values: disclosed },
      });
    }

    for (const raw of res.setCookies) {
      const c = parseCookie(raw);
      const missing = [
        https && !c.secure && "Secure",
        !c.httpOnly && "HttpOnly",
        !c.sameSite && "SameSite",
      ].filter(Boolean) as string[];
      if (missing.length > 0) {
        out.push({
          checkKey: "headers.cookie_flags",
          subject: c.name,
          severity: missing.includes("Secure") || missing.includes("HttpOnly") ? "medium" : "low",
          title: `Cookie "${c.name}" is missing ${missing.join(", ")}`,
          description:
            "Cookies without these attributes can be sent over plain HTTP, read by scripts, or attached to cross-site requests.",
          remediation:
            "Set `Secure; HttpOnly; SameSite=Lax` (or Strict) on session and other sensitive cookies.",
          evidence: { cookie: c.name, missing },
        });
      }
    }

    if (https && MIXED_CONTENT.test(res.body)) {
      out.push({
        checkKey: "headers.mixed_content",
        severity: "low",
        title: "Page loads scripts or styles over plain HTTP",
        description:
          "An HTTPS page references active content over HTTP, which an attacker on the network can modify.",
        remediation:
          "Load every script, stylesheet and frame over HTTPS (or protocol-relative URLs).",
      });
    }

    // Does plain HTTP upgrade to HTTPS? A closed port 80 is fine.
    try {
      const plain = await deps.fetch(`http://${host}/`);
      if (plain.finalUrl.startsWith("http:") && plain.status < 400) {
        out.push({
          checkKey: "headers.no_https_redirect",
          severity: "medium",
          title: "HTTP does not redirect to HTTPS",
          description:
            "Visitors who type the bare domain or follow an old http:// link stay on an unencrypted connection.",
          remediation: "Redirect all HTTP requests to HTTPS with a 301 and enable HSTS.",
        });
      }
    } catch (e) {
      if (e instanceof BlockedTargetError) throw e;
    }
    return out;
  },
};
