# Upzy documentation

**Using Upzy** (`guides/`)

| Guide                                                | What it covers                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------- |
| [Getting started](guides/ONBOARDING.md)              | The first half minute: add a site, get monitors and a security scan |
| [Monitors](guides/MONITORS.md)                       | HTTP, TCP, DNS, SSL, API flows, heartbeats, maintenance windows     |
| [Browser monitors](guides/BROWSER-MONITORS.md)       | Real-browser checks of a page or a login (optional container)       |
| [Multi-region checks](guides/MULTI-REGION.md)        | Check from several places; down when most agree                     |
| [Status pages](guides/STATUS-PAGES.md)               | Public pages, custom domains, subscribers                           |
| [Alert integrations](guides/INTEGRATIONS.md)         | Slack, Discord, Teams, PagerDuty, Opsgenie, GitHub, webhooks        |
| [Health score and fixes](guides/HEALTH-AND-FIXES.md) | The score and the fix for your stack                                |
| [Client reports](guides/REPORTS.md)                  | Scheduled reports for agencies' clients                             |
| [Limiting access](guides/ACCESS.md)                  | Restrict people to some workspaces                                  |
| [Two-factor sign-in](guides/TWO-FACTOR.md)           | Authenticator apps and the organization rule                        |
| [Single sign-on](guides/SSO.md)                      | OpenID Connect for an organization                                  |

**Running your own install** (`self-hosting/`)

| Guide                                    | What it covers                                      |
| ---------------------------------------- | --------------------------------------------------- |
| [Deployment](self-hosting/DEPLOYMENT.md) | Docker Compose, Caddy, backups, updates, operations |
| [Email](self-hosting/EMAIL.md)           | Resend or SMTP, templates, unsubscribe              |

Security reports: see [SECURITY.md](../SECURITY.md).
