import type { Stack } from "@upzy/security/fixes";

import type { ToolInfo } from "@/lib/tools";

/**
 * How-to guides. The words are written here; the instructions and code for each platform come from the same library
 * the dashboard uses to tell people how to fix a finding (@upzy/security fixes), so a guide can never drift from what
 * Upzy tells you in the app.
 */
export interface Guide {
  slug: string;
  /** The search-result title, without the site name. */
  title: string;
  description: string;
  /** The finding this guide fixes: its check key in the scanner. */
  checkKey: string;
  /** "header": instructions for each web server and host. "single": one set of instructions (DNS, certificates). */
  kind: "header" | "single";
  /** The free tool that checks it. */
  tool: ToolInfo["id"];
  intro: string;
  /** What to know before starting. */
  why: string[];
  mistakes: string[];
  faq: { q: string; a: string }[];
}

/** Platforms a header guide shows, in the order people most often need them. */
export const STACKS: { id: string; label: string; stack: Stack }[] = [
  {
    id: "nginx",
    label: "nginx",
    stack: { platform: "unknown", server: "nginx", framework: "unknown" },
  },
  {
    id: "apache",
    label: "Apache",
    stack: { platform: "unknown", server: "apache", framework: "unknown" },
  },
  {
    id: "caddy",
    label: "Caddy",
    stack: { platform: "unknown", server: "caddy", framework: "unknown" },
  },
  {
    id: "cloudflare",
    label: "Cloudflare",
    stack: { platform: "cloudflare", server: "unknown", framework: "unknown" },
  },
  {
    id: "vercel",
    label: "Vercel",
    stack: { platform: "vercel", server: "unknown", framework: "unknown" },
  },
  {
    id: "netlify",
    label: "Netlify",
    stack: { platform: "netlify", server: "unknown", framework: "unknown" },
  },
  {
    id: "nextjs",
    label: "Next.js",
    stack: { platform: "unknown", server: "unknown", framework: "nextjs" },
  },
  {
    id: "express",
    label: "Express",
    stack: { platform: "unknown", server: "unknown", framework: "express" },
  },
];

export const GUIDES: Guide[] = [
  {
    slug: "how-to-add-hsts-header",
    title: "How to add the HSTS header (Strict-Transport-Security)",
    description:
      "Add the Strict-Transport-Security header so browsers only ever use HTTPS for your site. Copy-paste config for nginx, Apache, Caddy, Cloudflare, Vercel, Netlify, Next.js and Express.",
    checkKey: "headers.hsts_missing",
    kind: "header",
    tool: "headers",
    intro:
      "HSTS is a response header that tells a browser: from now on, only talk to this site over HTTPS, for this long. Without it, the first visit (or any visit after the browser forgets) can start on plain HTTP, which is where an attacker on the same network can intercept or downgrade the connection.",
    why: [
      "It closes the gap between typing example.com and being redirected to https://example.com, which is the moment a downgrade attack works.",
      "Once a browser has seen the header, it refuses to load the site over HTTP at all until the time runs out.",
      "It costs one line of configuration and nothing at runtime.",
    ],
    mistakes: [
      "Sending it before HTTPS works everywhere. With includeSubDomains, any subdomain that is still HTTP-only becomes unreachable in browsers that saw the header.",
      "Using a very short max-age. A value of a few minutes protects almost nothing. Use at least 15552000 (180 days), ideally 31536000 (one year).",
      "Adding the preload directive without reading the preload list rules. Getting onto the list is easy; getting off it takes months.",
      "Sending it over HTTP. Browsers ignore it there, so set it on HTTPS responses.",
    ],
    faq: [
      {
        q: "What value should I use?",
        a: "Strict-Transport-Security: max-age=31536000; includeSubDomains. Start with a short max-age such as 300 while you test, then raise it to a year once everything works over HTTPS.",
      },
      {
        q: "Do I still need the HTTP to HTTPS redirect?",
        a: "Yes. HSTS only takes effect after a browser has seen the header once over HTTPS, so the redirect handles that first visit.",
      },
      {
        q: "How do I check it worked?",
        a: "Run the domain through the free security headers checker, or open your browser's developer tools, look at any response on the Network tab, and find the Strict-Transport-Security header.",
      },
    ],
  },
  {
    slug: "how-to-add-content-security-policy",
    title: "How to add a Content-Security-Policy header",
    description:
      "Start a Content-Security-Policy in report-only mode so it never breaks your site, then tighten it. Config for nginx, Apache, Caddy, Cloudflare, Vercel, Netlify, Next.js and Express.",
    checkKey: "headers.csp_missing",
    kind: "header",
    tool: "headers",
    intro:
      "A Content-Security-Policy tells the browser which places scripts, styles, images and frames may load from. If an attacker manages to inject a script into one of your pages, a good policy stops the browser running it. It is the strongest single header you can add, and the one most often got wrong.",
    why: [
      "It limits the damage of cross-site scripting bugs, which are among the most common web vulnerabilities.",
      "It also stops your pages loading content from places you didn't intend, such as an unknown third-party script.",
      "Report-only mode lets you learn what your site loads before anything is blocked.",
    ],
    mistakes: [
      "Turning on an enforced policy written from memory. It will block your own analytics, fonts or payment widget. Start with Content-Security-Policy-Report-Only and read the console.",
      "Leaving 'unsafe-inline' and 'unsafe-eval' in forever. They are fine as a first step, but they remove most of the protection. Move to nonces or hashes when you can.",
      "Forgetting that every third-party script needs to be listed: analytics, chat widgets, tag managers, embedded video.",
      "Setting it only on some pages. Set it on every response.",
    ],
    faq: [
      {
        q: "What is report-only mode?",
        a: "The browser checks every load against your policy and reports violations in the developer console, but blocks nothing. Once the console is quiet while you use the site, rename the header to Content-Security-Policy to enforce it.",
      },
      {
        q: "Can I get reports sent to me?",
        a: "Yes. Add a report-to or report-uri directive pointing at an endpoint that collects them. Several hosted services exist for this. It's optional: the browser console is enough for a small site.",
      },
      {
        q: "Is X-Frame-Options still needed?",
        a: "The frame-ancestors directive in a Content-Security-Policy does the same job, but sending X-Frame-Options as well covers older browsers.",
      },
    ],
  },
  {
    slug: "how-to-prevent-clickjacking-x-frame-options",
    title: "How to prevent clickjacking with X-Frame-Options",
    description:
      "Stop other sites putting yours in an invisible frame. Add X-Frame-Options or frame-ancestors on nginx, Apache, Caddy, Cloudflare, Vercel, Netlify, Next.js and Express.",
    checkKey: "headers.clickjacking_missing",
    kind: "header",
    tool: "headers",
    intro:
      "Clickjacking is when another site loads yours in a hidden frame and tricks a visitor into clicking something on it, such as a confirm button, while they think they are clicking something harmless. The X-Frame-Options header, or the frame-ancestors directive of a Content-Security-Policy, tells the browser not to allow it.",
    why: [
      "Anything a logged-in visitor can do with a click, an attacker can try to trick them into doing.",
      "The fix is one header, and almost no site legitimately needs to be framed by strangers.",
    ],
    mistakes: [
      "Using DENY when you frame your own pages (an admin preview, an embedded widget). Use SAMEORIGIN, which allows your own site.",
      "Using ALLOW-FROM. It is obsolete and ignored by modern browsers. Use frame-ancestors in a Content-Security-Policy if you must allow a specific other site.",
      "Setting it on the home page only. Set it on every response.",
    ],
    faq: [
      {
        q: "SAMEORIGIN or DENY?",
        a: "SAMEORIGIN unless you are sure nothing, including your own site, ever frames your pages. It protects against other sites while keeping your own features working.",
      },
      {
        q: "What if a partner needs to embed my page?",
        a: "Skip X-Frame-Options for that page and use a Content-Security-Policy with frame-ancestors listing exactly the sites you trust.",
      },
    ],
  },
  {
    slug: "how-to-add-x-content-type-options-nosniff",
    title: "How to add X-Content-Type-Options: nosniff",
    description:
      "Stop browsers guessing file types. Add X-Content-Type-Options: nosniff on nginx, Apache, Caddy, Cloudflare, Vercel, Netlify, Next.js and Express.",
    checkKey: "headers.nosniff_missing",
    kind: "header",
    tool: "headers",
    intro:
      "Browsers sometimes ignore the type a server says a file has and guess from its content, so a file served as plain text or an image can end up run as a script. X-Content-Type-Options: nosniff tells the browser to trust the declared type and not guess.",
    why: [
      "It closes a class of attacks where an uploaded file is tricked into running as a script.",
      "It is one fixed value with no tuning, so it is the easiest header to add.",
    ],
    mistakes: [
      "Adding it while some files are served with the wrong type. With nosniff, a stylesheet served as text/plain stops applying. Check your site still looks right.",
      "Typing the value differently. The only valid value is nosniff.",
    ],
    faq: [
      {
        q: "Will it break my site?",
        a: "Only if a script or stylesheet is served with the wrong content type. If something stops loading, look at the type the server sends for it and correct that.",
      },
    ],
  },
  {
    slug: "how-to-add-referrer-policy-header",
    title: "How to add a Referrer-Policy header",
    description:
      "Control how much of your URLs is sent to other sites. Add a Referrer-Policy header on nginx, Apache, Caddy, Cloudflare, Vercel, Netlify, Next.js and Express.",
    checkKey: "headers.referrer_policy_missing",
    kind: "header",
    tool: "headers",
    intro:
      "When someone clicks a link from your site to another, the browser tells that other site which page they came from. Sometimes the address contains private things, such as a reset token, an order number or an internal path. Referrer-Policy sets how much is shared.",
    why: [
      "It stops private parts of your URLs leaking to other sites, including the analytics and ad scripts you embed.",
      "strict-origin-when-cross-origin is a sensible default: other sites see only your domain, and nothing at all if the link goes from HTTPS to HTTP.",
    ],
    mistakes: [
      "Choosing no-referrer when your own analytics or affiliate tracking relies on the referrer.",
      "Putting secrets in URLs at all. The header limits the leak, but a token in a URL is still better moved to a header or a form body.",
    ],
    faq: [
      {
        q: "Which value should I use?",
        a: "strict-origin-when-cross-origin. It is also what current browsers do by default, so adding it explicitly mostly makes the behaviour reliable across browsers.",
      },
    ],
  },
  {
    slug: "how-to-add-permissions-policy-header",
    title: "How to add a Permissions-Policy header",
    description:
      "Switch off browser features your site doesn't use, like the camera and location. Add a Permissions-Policy header on nginx, Apache, Caddy, Cloudflare, Vercel, Netlify, Next.js and Express.",
    checkKey: "headers.permissions_policy_missing",
    kind: "header",
    tool: "headers",
    intro:
      "Permissions-Policy lets a page say which powerful browser features, such as the camera, microphone and geolocation, it and the content embedded in it may use. Turning off what you don't need means a compromised script or an embedded third party can't use them either.",
    why: [
      "It limits what injected or embedded code can ask the visitor for.",
      "Features listed with empty parentheses are off for everyone, including embedded frames.",
    ],
    mistakes: [
      "Switching off a feature your site uses, such as geolocation on a store locator. List only what you never use.",
      "Using the old Feature-Policy header name. It was renamed; use Permissions-Policy.",
    ],
    faq: [
      {
        q: "What does the example turn off?",
        a: "camera=(), microphone=(), geolocation=() disables the camera, the microphone and location for your pages and everything embedded in them. Add more features, such as payment=(), the same way.",
      },
    ],
  },
  {
    slug: "how-to-set-up-spf-record",
    title: "How to set up an SPF record",
    description:
      "Publish an SPF record so only your mail servers can send email as your domain. What to put in it, how to avoid the common mistakes, and how to check it.",
    checkKey: "email.spf_missing",
    kind: "single",
    tool: "email",
    intro:
      "SPF is a DNS record that lists the servers allowed to send email for your domain. Receiving mail servers look it up and treat messages from anywhere else as suspicious. Without it, anyone can send email that claims to come from you, and your real mail is more likely to land in spam.",
    why: [
      "It makes spoofing your domain harder, which protects your customers from phishing that looks like you.",
      "Mailbox providers such as Gmail and Microsoft favour mail from domains that publish SPF, together with DKIM and DMARC.",
    ],
    mistakes: [
      "Having two SPF records. A domain may have only one; with two, receivers ignore both. Merge them into one record.",
      "Ending in +all or ?all, which allow everyone. Use ~all (soft fail) or -all (reject).",
      "Forgetting a sender: your newsletter tool, support desk or invoicing app. Each needs its include: entry or its mail will fail.",
      "Going over 10 DNS lookups. Each include: counts, and past 10 the whole record fails. Remove services you no longer use.",
    ],
    faq: [
      {
        q: "~all or -all?",
        a: "Start with ~all while you confirm every sender is listed, then move to -all when you are sure. Combined with DMARC, either gives receivers a clear signal.",
      },
      {
        q: "Is SPF enough?",
        a: "No. SPF checks the hidden envelope sender. DMARC ties it to the From address people see, and DKIM signs the message. Set up SPF, then DMARC.",
      },
      {
        q: "My domain doesn't send email. Do I still need it?",
        a: "Yes, a record of v=spf1 -all says no server may send as your domain, which stops it being used for spoofing.",
      },
    ],
  },
  {
    slug: "how-to-set-up-dmarc",
    title: "How to set up DMARC, step by step",
    description:
      "Publish a DMARC record, read the reports, and move from monitoring to reject without breaking your own email. The records to add and the order to do it in.",
    checkKey: "email.dmarc_missing",
    kind: "single",
    tool: "email",
    intro:
      "DMARC tells receiving mail servers what to do with email that claims to be from your domain but fails SPF and DKIM checks, and asks them to send you reports about it. It is the record that actually stops spoofing, and it is also how you find out which services send mail as you.",
    why: [
      "Without DMARC, SPF and DKIM only inform the receiver; nothing says what to do when they fail.",
      "The reports show every service sending as your domain, including ones you forgot about.",
      "Gmail and Yahoo expect a DMARC record from domains that send in bulk.",
    ],
    mistakes: [
      "Starting at p=reject. Begin with p=none, which blocks nothing, and read the reports for a few weeks.",
      "Using a report address nobody reads. Use a mailbox you check, or a DMARC report service that summarises them.",
      "Moving to quarantine or reject before every legitimate sender passes SPF or DKIM. Fix those first.",
    ],
    faq: [
      {
        q: "What are the steps?",
        a: "Publish p=none with a reporting address. Read the reports for two to four weeks and fix any legitimate sender that fails. Move to p=quarantine, ideally with pct=25 then 100. When nothing legitimate is caught, move to p=reject.",
      },
      {
        q: "Where does the record go?",
        a: "It is a TXT record on _dmarc.yourdomain.com, for example _dmarc.example.com.",
      },
    ],
  },
  {
    slug: "how-to-fix-expiring-ssl-certificate",
    title: "How to fix an expiring or expired SSL certificate",
    description:
      "Renew an SSL/TLS certificate and make renewal automatic so it can't expire again. What to do on managed hosts like Vercel and Cloudflare, and on your own server with Let's Encrypt.",
    checkKey: "tls.cert_expiring",
    kind: "single",
    tool: "ssl",
    intro:
      "An expired certificate makes browsers show a full-page warning, and most visitors leave. Almost every expiry is a renewal that was manual, or an automatic one that quietly stopped working. The fix is to renew now and then make sure renewal can't be forgotten.",
    why: [
      "A certificate that is only a few weeks from expiry is a warning, not yet an outage. Fixing it now costs minutes; fixing it after expiry costs customers.",
      "Free certificates from Let's Encrypt last 90 days by design, which is why renewal has to be automatic.",
    ],
    mistakes: [
      "Renewing by hand and putting a reminder in a calendar. Reminders get missed; use automatic renewal.",
      "Assuming automatic renewal works without checking. Run the dry run (certbot renew --dry-run) and watch for errors, or monitor the certificate's expiry.",
      "Renewing the certificate but not restarting or reloading the server, so it keeps serving the old one.",
      "Forgetting a second place the certificate is used, such as a mail server, a load balancer or an old subdomain.",
    ],
    faq: [
      {
        q: "How can I find out before it expires next time?",
        a: "Monitor it. Upzy checks your certificate every day and alerts you well before it lapses, and the free SSL checker shows the expiry date on demand.",
      },
      {
        q: "Does my host handle this?",
        a: "Vercel, Netlify, Cloudflare, CloudFront and GitHub Pages issue and renew certificates for you. If you see a warning there, the domain is usually not attached to the project, or its DNS points somewhere else.",
      },
    ],
  },
  {
    slug: "how-to-hide-server-version",
    title: "How to hide your web server and framework version",
    description:
      "Stop your server announcing its name and version in every response. Turn off server_tokens in nginx, ServerTokens in Apache, and X-Powered-By in Express and Next.js.",
    checkKey: "headers.version_disclosed",
    kind: "single",
    tool: "headers",
    intro:
      "By default many servers announce exactly what they run, for example nginx/1.18.0 or Express, in a header on every response. That helps an attacker pick the right known vulnerability. Hiding it removes the free hint; it does not replace keeping software up to date.",
    why: [
      "Automated scanners match version strings against lists of known vulnerabilities.",
      "Removing the banner takes one setting and never affects visitors.",
    ],
    mistakes: [
      "Treating it as a fix for an outdated server. It is only a small hardening step; update the software too.",
      "Hiding the header in one place while another layer (a CDN, a reverse proxy) adds its own. Check the final response.",
    ],
    faq: [
      {
        q: "Does hiding the version make me secure?",
        a: "No. It removes information that makes an attacker's job easier, but the real protection is patching. Think of it as not leaving a label on the door.",
      },
    ],
  },
];

export const guideBySlug = (slug: string) => GUIDES.find((g) => g.slug === slug);
export const guidesForTool = (tool: ToolInfo["id"]) => GUIDES.filter((g) => g.tool === tool);
