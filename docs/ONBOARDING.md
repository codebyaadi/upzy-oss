# Getting started

A new organization lands on **Get started** (also linked from the empty Monitors and Assets pages). The person enters a website and Upzy does the rest in about half a minute:

1. **An uptime monitor** on the address entered (every 5 minutes, two failures to open an incident).
2. **A certificate monitor** on the host (checked hourly, with alerts well before expiry).
3. **A passive security scan** of the domain, which produces the [health score](HEALTH-AND-FIXES.md). The top three findings are listed with links to instructions for the detected stack.
4. **An optional ownership proof** (a DNS TXT record) with a "Check now" button. Passive checks don't need it.

The page then points to the usual next steps: alerts, a status page, the health score breakdown and AI help.

## What gets created

| Entered                   | Uptime monitor            | Security scan covers                              |
| ------------------------- | ------------------------- | ------------------------------------------------- |
| `acme.com`                | `https://acme.com/`       | domain `acme.com` (includes email and CAA checks) |
| `www.acme.com`            | `https://www.acme.com/`   | domain `acme.com`                                 |
| `app.acme.com`            | `https://app.acme.com/`   | subdomain `app.acme.com`                          |
| `https://acme.com/health` | `https://acme.com/health` | domain `acme.com`                                 |

Registrable domains are worked out with a short list of two-level suffixes (`co.uk`, `com.au`, ...), not the full public suffix list. Only public websites are accepted: IP addresses, `localhost`, internal names and other schemes are refused.

## Safe to repeat

Whatever already exists is reused: the same domain, the same monitor addresses. Pressing the button twice, or adding a site later, never duplicates anything. If the domain was scanned more than five minutes ago, repeating it asks for a fresh scan. A site covered by an already-verified parent domain is verified immediately.

Progress is kept in the address bar, so a refresh in the middle picks up where it was. Nothing is changed on the site being watched.
