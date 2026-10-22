/** The free checkers (apps/api /tools/:id). `id` is what the API calls it; `slug` is the page address. */
export interface ToolInfo {
  id: "headers" | "ssl" | "email";
  slug: string;
  name: string;
  /** Page title and search result title. */
  title: string;
  /** One sentence: what it tells you. */
  summary: string;
  description: string;
  placeholder: string;
  checks: string[];
  faq: { q: string; a: string }[];
}

export const TOOLS: ToolInfo[] = [
  {
    id: "headers",
    slug: "security-headers",
    name: "Security headers checker",
    title: "Free security headers checker",
    summary: "Grades the HTTP headers that protect your visitors, and shows the fix for your host.",
    description:
      "Check your website's security headers for free: HSTS, Content-Security-Policy, X-Frame-Options and more, with a grade and copy-paste fixes for nginx, Cloudflare, Vercel and others. No sign-up.",
    placeholder: "example.com",
    checks: [
      "Strict-Transport-Security (HSTS), so browsers always use HTTPS",
      "Content-Security-Policy, the strongest defence against injected scripts",
      "Clickjacking protection (X-Frame-Options or frame-ancestors)",
      "X-Content-Type-Options, Referrer-Policy and Permissions-Policy",
      "Cookie flags (Secure, HttpOnly, SameSite) and version banners that give attackers a head start",
    ],
    faq: [
      {
        q: "What are security headers?",
        a: "Short instructions your server sends with every page that tell the browser to switch on built-in protections: always use HTTPS, never run scripts from unexpected places, never let another site frame yours. They cost nothing and stop whole classes of attack.",
      },
      {
        q: "Which one matters most?",
        a: "Strict-Transport-Security and Content-Security-Policy. HSTS is a one-line change. A good Content-Security-Policy takes more care, so start with a report-only policy and tighten it.",
      },
      {
        q: "Does this scan my whole site?",
        a: "No. It requests your home page once, the way a browser would, and reads the response headers. Nothing is stored.",
      },
    ],
  },
  {
    id: "ssl",
    slug: "ssl-checker",
    name: "SSL certificate checker",
    title: "Free SSL certificate checker",
    summary: "Checks that your certificate is valid, trusted and not about to expire.",
    description:
      "Check any website's SSL/TLS certificate for free: expiry date, trust chain, hostname match, key strength and protocol version. No sign-up.",
    placeholder: "example.com",
    checks: [
      "Whether the certificate has expired, or expires within 30 days",
      "Whether browsers trust it, including the intermediate chain",
      "Whether it covers the hostname you typed",
      "Key strength (RSA below 2048 bits is flagged)",
      "Whether the server still negotiates the deprecated TLS 1.0 or 1.1",
    ],
    faq: [
      {
        q: "Why do certificates expire so often?",
        a: "Free certificates from Let's Encrypt last 90 days on purpose, so renewal has to be automatic. A forgotten renewal is the most common cause of a site suddenly showing a full-page warning.",
      },
      {
        q: "Can Upzy warn me before it expires?",
        a: "Yes. Add the domain to Upzy and it re-checks the certificate every day and alerts you well before it lapses.",
      },
      {
        q: "What does 'not trusted' mean?",
        a: "Browsers couldn't build a chain from your certificate to a certificate authority they know. Usually the intermediate certificate is missing from the server's configuration, or the certificate is self-signed.",
      },
    ],
  },
  {
    id: "email",
    slug: "email-security",
    name: "SPF and DMARC checker",
    title: "Free SPF and DMARC checker",
    summary: "Checks that nobody can send email pretending to be your domain.",
    description:
      "Check your domain's SPF and DMARC records for free and see how to stop spoofed email: what's missing, what's too weak, and the DNS record to add. No sign-up.",
    placeholder: "yourcompany.com",
    checks: [
      "An SPF record listing who may send mail for your domain",
      "An SPF policy that actually rejects strangers (-all or ~all, not +all or ?all)",
      "A DMARC record, and whether its policy enforces anything",
      "Only for domains that receive email, so a website-only domain isn't nagged",
    ],
    faq: [
      {
        q: "Why does this matter if I only send a little email?",
        a: "Without SPF and DMARC anyone can send email that looks exactly like it came from you. It's how invoice scams and phishing against your customers work. Mailbox providers also trust you less, so your real mail lands in spam more often.",
      },
      {
        q: "What should my DMARC policy be?",
        a: "Start with p=none and a reporting address so you can see who sends as you. Once your own mail passes, move to p=quarantine and then p=reject.",
      },
      {
        q: "Does this check DKIM?",
        a: "Not yet. DKIM selectors differ per provider, so a reliable check needs to know the selector. SPF and DMARC are the records to fix first.",
      },
    ],
  },
];

export const toolBySlug = (slug: string) => TOOLS.find((t) => t.slug === slug);
