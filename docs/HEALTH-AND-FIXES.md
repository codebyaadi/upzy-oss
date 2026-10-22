# Health score and "fix for my stack"

## Health score

Every scanned asset gets one grade, A to F, with a score out of 100 (Assets page: the letter next to the name; click "Show health score" for the breakdown, a 90-day trend and the fixes).

It is computed from facts Upzy already has, not by AI:

| Category     | What counts                                                                         | Weight |
| ------------ | ----------------------------------------------------------------------------------- | ------ |
| Security     | headers, TLS, takeover risk, known vulnerabilities                                  | 50     |
| Availability | 30-day uptime of the monitors that watch the same host (left out if there are none) | 20     |
| Email trust  | SPF and DMARC (domains only)                                                        | 20     |
| Hygiene      | certificate expiry, CAA, version banners                                            | 10     |

Each category starts at 100 and loses points per open finding (critical 40, high 25, medium 12, low 5, info 0). The score is the weighted average of the categories that apply.

Two rules keep the letter honest: an open **critical** finding caps the score at 59, an open **high** one at 79, and an open **medium** one at 89, so an A means nothing above "low" is open. Ignored and resolved findings don't count. An asset that has never been scanned has no grade yet.

A point is stored for each asset once a day (the latest of the day) to draw the trend.

## Fix for my stack

On every scan Upzy reads the response headers it already fetched and works out what the site runs on: the platform in front (Cloudflare, Vercel, Netlify, CloudFront, GitHub Pages, Fly, Azure, Heroku), the web server (nginx, Apache, Caddy, IIS, LiteSpeed) and the framework (Next.js, Express, WordPress, PHP, ASP.NET). Only header names and well-known markers are read; nothing is stored beyond those three labels.

A finding then shows instructions written for that stack, with copy-ready snippets: a Cloudflare Transform Rule, a `vercel.json` entry, a Netlify `_headers` file, `add_header` lines for nginx, `Header always set` for Apache, a Caddy `header` block, `next.config.ts`, Express middleware, DNS records for SPF/DMARC/CAA, certbot commands, and so on. When the platform and the server differ (Cloudflare in front of nginx) both snippets are shown. When the stack can't be detected, the common servers are shown. GitHub Pages can't set headers, and the instructions say so and point to a CDN.

These instructions are deterministic templates: they work without AI and cost nothing. If AI is on for the organization, the explanation is also told which stack was detected. The Assets health panel offers one snippet that adds every missing header at once. A Content-Security-Policy is suggested in report-only mode first, because an enforced policy written blind breaks sites.

Findings with no template (known vulnerable components) keep the built-in remediation text.

## Verify fix

On an open finding, **Verify fix** re-runs only that finding's check family (headers, TLS, email, DNS, takeover or CVE) right away, instead of waiting for tomorrow's scan. If the problem is gone the finding turns resolved and you see a "Fixed" message; if it's still there you're told so; if the check couldn't run (a DNS timeout, say) the reason is shown and nothing changes. It sends the same requests a scheduled scan does, only for that family, and is limited to one re-check per finding every 15 seconds. A CDN or browser cache can serve old headers for a few minutes after a change.
