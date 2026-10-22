import { describeStack, type Stack } from "./stack";

export type Language =
  | "nginx"
  | "apache"
  | "caddy"
  | "json"
  | "yaml"
  | "toml"
  | "ini"
  | "dns"
  | "shell"
  | "typescript"
  | "xml"
  | "text";

export interface Snippet {
  label: string;
  language: Language;
  code: string;
}

/** Instructions for one finding on one stack. Deterministic: the same finding and stack always give the same fix. */
export interface Fix {
  /** What these instructions are written for, e.g. "Cloudflare". */
  target: string;
  /** The stack we detected, in words. Shown so a wrong guess is obvious. */
  detected: string;
  steps: string[];
  snippets: Snippet[];
  caveat?: string;
}

export interface FixInput {
  checkKey: string;
  stack: Stack;
  /** The site the finding is about (a hostname). */
  host: string;
  /** Evidence from the finding (cookie names, headers). Observable facts only. */
  evidence?: Record<string, unknown>;
}

interface HeaderSpec {
  name: string;
  value: string;
}

export const HEADER_SPECS: Record<string, HeaderSpec> = {
  "headers.hsts_missing": {
    name: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains",
  },
  "headers.hsts_weak": {
    name: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains",
  },
  // Report-only first: an enforced CSP written blind breaks sites.
  "headers.csp_missing": {
    name: "Content-Security-Policy-Report-Only",
    value: "default-src 'self'",
  },
  "headers.clickjacking_missing": { name: "X-Frame-Options", value: "SAMEORIGIN" },
  "headers.nosniff_missing": { name: "X-Content-Type-Options", value: "nosniff" },
  "headers.referrer_policy_missing": {
    name: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  "headers.permissions_policy_missing": {
    name: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
};

type Target =
  | "cloudflare"
  | "vercel"
  | "netlify"
  | "cloudfront"
  | "github-pages"
  | "nextjs"
  | "express"
  | "nginx"
  | "apache"
  | "caddy"
  | "generic";

const TARGET_LABEL: Record<Target, string> = {
  cloudflare: "Cloudflare",
  vercel: "Vercel",
  netlify: "Netlify",
  cloudfront: "Amazon CloudFront",
  "github-pages": "GitHub Pages",
  nextjs: "Next.js",
  express: "Express",
  nginx: "nginx",
  apache: "Apache",
  caddy: "Caddy",
  generic: "your web server",
};

/**
 * Where the change is easiest to make. A platform in front (Cloudflare, Vercel...) is usually the quickest place;
 * otherwise the framework, then the web server.
 */
export function targetFor(s: Stack): Target {
  if (
    s.platform === "cloudflare" ||
    s.platform === "vercel" ||
    s.platform === "netlify" ||
    s.platform === "cloudfront" ||
    s.platform === "github-pages"
  )
    return s.platform;
  if (s.framework === "nextjs") return "nextjs";
  if (s.framework === "express") return "express";
  if (s.server === "nginx" || s.server === "apache" || s.server === "caddy") return s.server;
  return "generic";
}

const q = (v: string) => v.replace(/"/g, '\\"');

function renderHeaders(target: Target, specs: HeaderSpec[]): Snippet[] {
  const nginx = (): Snippet => ({
    label: "nginx (server or location block)",
    language: "nginx",
    code: specs.map((h) => `add_header ${h.name} "${q(h.value)}" always;`).join("\n"),
  });
  const apache = (): Snippet => ({
    label: "Apache (needs mod_headers)",
    language: "apache",
    code: specs.map((h) => `Header always set ${h.name} "${q(h.value)}"`).join("\n"),
  });
  const caddy = (): Snippet => ({
    label: "Caddyfile",
    language: "caddy",
    code: `header {\n${specs.map((h) => `\t${h.name} "${q(h.value)}"`).join("\n")}\n}`,
  });
  switch (target) {
    case "cloudflare":
      return [
        {
          label:
            "Cloudflare → Rules → Transform Rules → Modify Response Header (Set static), one per line",
          language: "text",
          code: specs.map((h) => `${h.name}: ${h.value}`).join("\n"),
        },
      ];
    case "vercel":
      return [
        {
          label: "vercel.json",
          language: "json",
          code: JSON.stringify(
            {
              headers: [
                {
                  source: "/(.*)",
                  headers: specs.map((h) => ({ key: h.name, value: h.value })),
                },
              ],
            },
            null,
            2,
          ),
        },
      ];
    case "netlify":
      return [
        {
          label: "_headers (in your publish directory)",
          language: "text",
          code: `/*\n${specs.map((h) => `  ${h.name}: ${h.value}`).join("\n")}`,
        },
      ];
    case "cloudfront":
      return [
        {
          label: "CloudFront → Policies → Response headers → Create policy → Custom headers",
          language: "text",
          code: specs.map((h) => `${h.name}: ${h.value}   (Origin override: on)`).join("\n"),
        },
      ];
    case "nextjs":
      return [
        {
          label: "next.config.ts",
          language: "typescript",
          code: `const nextConfig = {\n  async headers() {\n    return [\n      {\n        source: "/(.*)",\n        headers: [\n${specs
            .map((h) => `          { key: "${h.name}", value: "${q(h.value)}" },`)
            .join("\n")}\n        ],\n      },\n    ];\n  },\n};\nexport default nextConfig;`,
        },
      ];
    case "express":
      return [
        {
          label: "Express middleware (before your routes)",
          language: "typescript",
          code: `app.use((req, res, next) => {\n${specs
            .map((h) => `  res.setHeader("${h.name}", "${q(h.value)}");`)
            .join("\n")}\n  next();\n});`,
        },
      ];
    case "nginx":
      return [nginx()];
    case "apache":
      return [apache()];
    case "caddy":
      return [caddy()];
    case "github-pages":
      return [];
    case "generic":
      return [nginx(), apache(), caddy()];
  }
}

const verifyNote =
  "After you deploy, press Verify fix. A CDN or browser cache can serve the old headers for a few minutes.";

function headerFix(input: FixInput, specs: HeaderSpec[]): Fix {
  const target = targetFor(input.stack);
  const detected = describeStack(input.stack);
  if (target === "github-pages")
    return {
      target: TARGET_LABEL[target],
      detected,
      steps: [
        "GitHub Pages doesn't let you set response headers.",
        "To add them, put a CDN such as Cloudflare in front of the site (free plan is enough) and add the headers there as a Transform Rule.",
        ...specs.map((h) => `Header to add: ${h.name}: ${h.value}`),
      ],
      snippets: renderHeaders("cloudflare", specs),
      caveat: verifyNote,
    };
  const snippets = renderHeaders(target, specs);
  // Behind a CDN the origin is another place the same header can be set; show it too when we know it.
  if (
    (target === "cloudflare" || target === "cloudfront") &&
    ["nginx", "apache", "caddy"].includes(input.stack.server)
  )
    snippets.push(...renderHeaders(input.stack.server as Target, specs));
  const csp = specs.some((h) => h.name.startsWith("Content-Security-Policy"));
  return {
    target: TARGET_LABEL[target],
    detected,
    steps: [
      `Add ${specs.length === 1 ? "this header" : "these headers"} to every response from ${input.host}.`,
      ...(csp
        ? [
            "This starts a Content-Security-Policy in report-only mode, which never blocks anything. Watch the browser console for violations, adjust the policy, then rename the header to Content-Security-Policy to enforce it.",
          ]
        : []),
    ],
    snippets,
    caveat: verifyNote,
  };
}

/** One snippet for several missing headers at once, e.g. everything the headers check found on an asset. */
export function headersBundle(stack: Stack, host: string, checkKeys: string[]): Fix | null {
  const seen = new Set<string>();
  const specs: HeaderSpec[] = [];
  for (const k of checkKeys) {
    const s = HEADER_SPECS[k];
    if (s && !seen.has(s.name)) {
      seen.add(s.name);
      specs.push(s);
    }
  }
  return specs.length ? headerFix({ checkKey: "headers.bundle", stack, host }, specs) : null;
}

const apex = (host: string) => host.replace(/^www\./, "");

function dnsFix(input: FixInput, text: { steps: string[]; code: string; label: string }): Fix {
  return {
    target: "DNS",
    detected: describeStack(input.stack),
    steps: text.steps,
    snippets: [{ label: text.label, language: "dns", code: text.code }],
    caveat: "DNS changes can take a few minutes to spread. Press Verify fix afterwards.",
  };
}

export function fixFor(input: FixInput): Fix | null {
  const { checkKey, stack, host } = input;
  const spec = HEADER_SPECS[checkKey];
  if (spec) return headerFix(input, [spec]);
  const target = targetFor(stack);
  const detected = describeStack(stack);
  const root = apex(host);

  switch (checkKey) {
    case "headers.version_disclosed": {
      const snippets: Snippet[] = [];
      if (stack.server === "nginx" || target === "generic")
        snippets.push({
          label: "nginx.conf (http block)",
          language: "nginx",
          code: "server_tokens off;",
        });
      if (stack.server === "apache" || target === "generic")
        snippets.push({
          label: "Apache config",
          language: "apache",
          code: "ServerTokens Prod\nServerSignature Off",
        });
      if (stack.framework === "express")
        snippets.push({
          label: "Express",
          language: "typescript",
          code: 'app.disable("x-powered-by");',
        });
      if (stack.framework === "nextjs")
        snippets.push({
          label: "next.config.ts",
          language: "typescript",
          code: "const nextConfig = { poweredByHeader: false };\nexport default nextConfig;",
        });
      if (stack.framework === "php")
        snippets.push({ label: "php.ini", language: "ini", code: "expose_php = Off" });
      if (stack.server === "iis" || stack.framework === "aspnet")
        snippets.push({
          label: "web.config",
          language: "xml",
          code: '<system.webServer>\n  <httpProtocol>\n    <customHeaders>\n      <remove name="X-Powered-By" />\n    </customHeaders>\n  </httpProtocol>\n  <security>\n    <requestFiltering removeServerHeader="true" />\n  </security>\n</system.webServer>',
        });
      return {
        target: "Your web server",
        detected,
        steps: [
          "Stop the server from announcing its software version. This is set where the software runs (the origin), not at a CDN.",
        ],
        snippets,
        caveat: verifyNote,
      };
    }

    case "headers.cookie_flags": {
      const name =
        typeof input.evidence?.cookie === "string" ? input.evidence.cookie : "your session cookie";
      const snippets: Snippet[] = [];
      if (stack.framework === "express" || stack.framework === "unknown")
        snippets.push({
          label: "Express (express-session)",
          language: "typescript",
          code: 'app.use(session({\n  cookie: { secure: true, httpOnly: true, sameSite: "lax" },\n  // ...\n}));',
        });
      if (stack.framework === "nextjs" || stack.framework === "unknown")
        snippets.push({
          label: "Next.js (cookies().set)",
          language: "typescript",
          code: '(await cookies()).set("session", value, { secure: true, httpOnly: true, sameSite: "lax" });',
        });
      if (
        stack.framework === "php" ||
        stack.framework === "wordpress" ||
        stack.framework === "unknown"
      )
        snippets.push({
          label: "php.ini",
          language: "ini",
          code: "session.cookie_secure = 1\nsession.cookie_httponly = 1\nsession.cookie_samesite = Lax",
        });
      snippets.push({
        label: "What the header should look like",
        language: "text",
        code: `Set-Cookie: ${name}=...; Secure; HttpOnly; SameSite=Lax`,
      });
      return {
        target:
          stack.framework === "unknown"
            ? "Your application"
            : (TARGET_LABEL[stack.framework as Target] ?? "Your application"),
        detected,
        steps: [
          `Cookie "${name}" is set without all of Secure, HttpOnly and SameSite. Set them where your application creates the cookie.`,
          "HttpOnly may need to stay off for a cookie your own front-end script has to read. If so, it is safe to ignore that part for this cookie.",
        ],
        snippets,
        caveat: verifyNote,
      };
    }

    case "headers.no_https_redirect": {
      const by: Partial<Record<Target, Fix["steps"]>> = {
        cloudflare: ['Cloudflare → SSL/TLS → Edge Certificates → turn on "Always Use HTTPS".'],
        vercel: [
          "Vercel redirects HTTP to HTTPS on its own. If you still see HTTP, check that the domain is added to the project and the DNS points at Vercel.",
        ],
        netlify: ['Netlify → Domain management → HTTPS → turn on "Force HTTPS".'],
        cloudfront: [
          'CloudFront → your distribution → Behaviors → Edit → Viewer protocol policy: "Redirect HTTP to HTTPS".',
        ],
        "github-pages": ['Repository → Settings → Pages → tick "Enforce HTTPS".'],
        caddy: [
          "Caddy redirects HTTP to HTTPS automatically for any site with a domain name. Make sure the site address in your Caddyfile is the domain, not :80.",
        ],
      };
      const snippets: Snippet[] = [];
      if (stack.server === "nginx" || target === "generic")
        snippets.push({
          label: "nginx",
          language: "nginx",
          code: `server {\n  listen 80;\n  server_name ${host};\n  return 301 https://$host$request_uri;\n}`,
        });
      if (stack.server === "apache" || target === "generic")
        snippets.push({
          label: "Apache (port 80 virtual host)",
          language: "apache",
          code: `<VirtualHost *:80>\n  ServerName ${host}\n  Redirect permanent / https://${host}/\n</VirtualHost>`,
        });
      return {
        target: TARGET_LABEL[target],
        detected,
        steps: by[target] ?? [
          "Redirect every plain-HTTP request to HTTPS with a 301, then enable HSTS.",
        ],
        snippets,
        caveat: verifyNote,
      };
    }

    case "headers.mixed_content":
      return {
        target: "Your site",
        detected,
        steps: [
          "Open the page, then the browser's developer console: it lists each http:// resource the HTTPS page loads.",
          "Change each of those URLs to https:// (or host the file yourself). Most CMSs have a setting or plugin that rewrites old http:// links.",
        ],
        snippets: [],
        caveat: verifyNote,
      };

    case "tls.deprecated_protocol": {
      const by: Partial<Record<Target, Fix["steps"]>> = {
        cloudflare: ["Cloudflare → SSL/TLS → Edge Certificates → Minimum TLS Version: TLS 1.2."],
        cloudfront: [
          "CloudFront → your distribution → Security → Security policy: TLSv1.2_2021 or newer.",
        ],
        vercel: [
          "Vercel only offers TLS 1.2 and 1.3. If an old protocol is reported, the report is probably about a different host.",
        ],
        netlify: [
          "Netlify only offers TLS 1.2 and 1.3. If an old protocol is reported, the report is probably about a different host.",
        ],
      };
      const snippets: Snippet[] = [];
      if (stack.server === "nginx" || target === "generic")
        snippets.push({
          label: "nginx",
          language: "nginx",
          code: "ssl_protocols TLSv1.2 TLSv1.3;",
        });
      if (stack.server === "apache" || target === "generic")
        snippets.push({
          label: "Apache",
          language: "apache",
          code: "SSLProtocol -all +TLSv1.2 +TLSv1.3",
        });
      if (stack.server === "caddy")
        snippets.push({
          label: "Caddyfile",
          language: "caddy",
          code: "tls {\n\tprotocols tls1.2 tls1.3\n}",
        });
      return {
        target: TARGET_LABEL[target],
        detected,
        steps: by[target] ?? ["Allow only TLS 1.2 and 1.3 and reload the server."],
        snippets,
        caveat: verifyNote,
      };
    }

    case "tls.cert_expiring":
    case "tls.cert_expired":
    case "tls.not_available":
    case "tls.cert_untrusted":
    case "tls.weak_key": {
      const managed = ["cloudflare", "vercel", "netlify", "cloudfront", "github-pages"].includes(
        target,
      );
      const certbot: Snippet = {
        label: "Let's Encrypt with certbot (nginx example; use --apache for Apache)",
        language: "shell",
        code: `sudo certbot --nginx -d ${host} --key-type ecdsa\nsudo certbot renew --dry-run`,
      };
      return {
        target: TARGET_LABEL[target],
        detected,
        steps: managed
          ? [
              `${TARGET_LABEL[target]} issues and renews certificates for you. If this one is a problem, check that ${host} is attached to the project/distribution and that its DNS points there.`,
              checkKey === "tls.weak_key"
                ? "If you uploaded your own certificate, replace it with the platform's managed one."
                : "If you uploaded your own certificate, replace it with the platform's managed one, or renew it.",
            ]
          : [
              "Issue a new certificate and make sure it renews by itself (certbot installs a timer). A certificate you have to remember to renew will expire again.",
              ...(checkKey === "tls.weak_key"
                ? [
                    "Use an ECDSA key or an RSA key of at least 2048 bits when you request the certificate.",
                  ]
                : []),
            ],
        snippets: managed ? [] : [certbot],
        caveat: verifyNote,
      };
    }

    case "dns.caa_missing":
      return dnsFix(input, {
        label: `DNS records for ${root}`,
        code: `${root}.  CAA  0 issue "letsencrypt.org"\n${root}.  CAA  0 iodef "mailto:security@${root}"`,
        steps: [
          "A CAA record limits which certificate authorities may issue certificates for your domain.",
          "Replace letsencrypt.org with the authority you actually use (for example pki.goog, amazon.com, digicert.com, sectigo.com). List every authority you use, one record each, or issuance will fail for the missing one.",
        ],
      });

    case "email.spf_missing":
      return dnsFix(input, {
        label: `TXT record on ${root}`,
        code: `${root}.  TXT  "v=spf1 include:_spf.google.com ~all"`,
        steps: [
          "Add one TXT record that lists who may send mail for your domain.",
          "The include: part depends on your mail provider. Google Workspace is shown; Microsoft 365 uses include:spf.protection.outlook.com, and each sending service (Mailchimp, SendGrid, SES...) has its own include.",
          "End it with ~all (soft fail) or -all (reject) once you are sure the list is complete.",
        ],
      });
    case "email.spf_multiple":
      return dnsFix(input, {
        label: `One merged TXT record on ${root}`,
        code: `${root}.  TXT  "v=spf1 include:provider-one.example include:provider-two.example ~all"`,
        steps: [
          "A domain may have only one SPF record; with two, receivers ignore both. Merge them into a single record that has every include: and one all at the end.",
          "Delete the extra records after you have added the merged one.",
        ],
      });
    case "email.spf_permissive":
    case "email.spf_no_all":
      return dnsFix(input, {
        label: `Replacement SPF record on ${root}`,
        code: `${root}.  TXT  "v=spf1 <your existing include: and ip4: entries> ~all"`,
        steps: [
          checkKey === "email.spf_permissive"
            ? "Your SPF record ends in +all or ?all, which lets anyone send as you. Change the ending to ~all (soft fail), or -all (reject) when you are confident."
            : 'Your SPF record has no "all" at the end, so receivers don\'t know what to do with mail from other senders. Add ~all (soft fail), or -all (reject) when you are confident.',
          "Keep your existing include: and ip4: entries; only the ending changes.",
        ],
      });
    case "email.dmarc_missing":
      return dnsFix(input, {
        label: `TXT record on _dmarc.${root}`,
        code: `_dmarc.${root}.  TXT  "v=DMARC1; p=none; rua=mailto:dmarc@${root}"`,
        steps: [
          "Start in monitoring mode (p=none): nothing is blocked, and you get daily reports of who sends mail as your domain at the address in rua=.",
          "Use an address you can actually read, or a DMARC report service. Once the reports look clean, move to p=quarantine and then p=reject.",
        ],
      });
    case "email.dmarc_monitor_only":
      return dnsFix(input, {
        label: `Updated TXT record on _dmarc.${root}`,
        code: `_dmarc.${root}.  TXT  "v=DMARC1; p=quarantine; pct=25; rua=mailto:dmarc@${root}"`,
        steps: [
          "Your DMARC policy is p=none, which only reports. Move to p=quarantine for a quarter of the mail (pct=25), watch the reports for legitimate senders being caught, then raise pct to 100 and later switch to p=reject.",
        ],
      });

    case "takeover.dangling_cname":
    case "takeover.vulnerable_service":
      return {
        target: "DNS",
        detected,
        steps: [
          `${host} points at a service that no longer has it set up, so someone else could claim it and serve content on your domain.`,
          "Fastest fix: delete the DNS record for this name if you don't use it any more.",
          "If you do need it, go to the service it points at and re-create the site or project for this exact hostname, then confirm it loads.",
        ],
        snippets: [],
        caveat: "Press Verify fix after removing the record or restoring the service.",
      };
  }
  return null;
}
