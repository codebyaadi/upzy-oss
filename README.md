# Upzy

Uptime monitoring and external attack-surface security for small teams.

**What works today**

- **Uptime monitoring:** HTTP, TCP, DNS and SSL checks, incidents opened after N consecutive failures, resolved automatically.
- **Alerts:** email, Slack, Discord and HMAC-signed webhooks for incidents and new critical/high security findings.
- **Security scanning (passive):** TLS, security headers and cookies, SPF/DMARC, CAA, subdomain-takeover detection, and known CVEs for detected software (NVD/OSV, ranked with CISA KEV and EPSS).
- **Attack-surface discovery:** subdomains from certificate-transparency logs, offered as suggestions you accept or dismiss.
- **AI (opt-in per organization):** plain-English explanations with fix snippets for findings, a "describe a monitor" assistant, and a Monday weekly digest, on the AI provider key each organization brings (Groq, OpenAI, Anthropic, Gemini or OpenRouter). Upzy ships with no AI key of its own. It only ever drafts or explains; a person confirms every change. Inputs are redacted and fenced as untrusted data, output is schema-validated, and each organization has a daily token budget.
- **Dashboard:** monitors, incidents, assets, findings and alert rules.
- **Teams:** invite people by email with roles (viewer < member < admin < owner), enforced by the API on every route; an audit log of every change (including refused attempts) with CSV export; password reset and email verification. Optional "Continue with GitHub" sign-in (set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`; the OAuth app's callback URL is `<BETTER_AUTH_URL>/api/auth/callback/github`). New accounts made through GitHub still follow `SIGNUP_MODE`.

## Stack

Bun workspaces + Turborepo · Elysia API · Drizzle on Postgres 18 (pgvector image) · better-auth · Next.js 16 + shadcn/ui · oxlint + oxfmt.

```
apps/
  api/      Elysia REST API (exports the App type used by the web client)
  worker/   Background roles: scheduler, prober, notifier, scanner (+ discovery)
  web/      Next.js dashboard and landing page
packages/
  db/ auth/ validator/   schema + migrations, better-auth config, shared Zod schemas
  queue/ probes/         Postgres job queue, SSRF-safe network probes
  security/ notify/ crypto/   scan checks, alert delivery, encryption + signing
  ui/ transactional/     shared components, email templates
docker/     Postgres (pgvector) and Mailpit compose files
```

## Run it locally

Requires [Bun](https://bun.sh) 1.4+ and Docker.

```bash
bun install
cp .env.example .env
# fill in the three secrets:
#   BETTER_AUTH_SECRET=$(openssl rand -base64 32)
#   UPZY_ENCRYPTION_KEY=$(openssl rand -base64 32)
docker compose -f docker/docker-compose.postgres.yml -f docker/docker-compose.mail.yml up -d
bun run db:migrate
bun run dev
```

| Service       | URL                               |
| ------------- | --------------------------------- |
| Web           | http://localhost:3001             |
| API           | http://localhost:3000 (`/health`) |
| Mailpit inbox | http://localhost:8025             |

Sign up in the web app, name your team, add a monitor, and add an email channel (any address: Mailpit catches it).

## Commands

| Command               | What it does                                              |
| --------------------- | --------------------------------------------------------- |
| `bun run dev`         | API, worker and web with reload                           |
| `bun run test`        | All tests. Postgres integration tests need `DATABASE_URL` |
| `bun run check-types` | TypeScript across the workspace                           |
| `bun run lint`        | oxlint                                                    |
| `bun run format`      | oxfmt (`format:check` in CI)                              |
| `bun run db:generate` | Generate a migration from schema changes                  |
| `bun run db:migrate`  | Apply migrations                                          |

CI (`.github/workflows`) runs format, lint, types, migrations (including a re-run and a drift check), the full test suite against Postgres, and the build. A separate workflow runs gitleaks, OSV-Scanner and CodeQL.

## Things to know

- **AI runs only on your organization's own provider key** (Settings → AI: add a key, pick models, see usage and estimated cost). Keys are checked with a tiny request, encrypted with `UPZY_ENCRYPTION_KEY`, and never shown again. There is no shared server key and no silent fallback to another provider. Groq and OpenRouter have free tiers if you want to try it at no cost.
- Run the AI safety scenarios with `bun run --filter @upzy/ai eval` (live, needs keys) or `eval:dry` (offline).

- **Rate limiting** is per client address and in-memory (strict on sign-in/sign-up). Run it behind a shared store before scaling the API beyond one instance, and set `TRUST_PROXY=true` only behind a trusted proxy.
- **Roles are enforced by the API**; the UI only hides what would be refused.
- **Targets are public only.** Monitors and scans refuse loopback, private, link-local and metadata addresses (resolved and pinned at connect time), so you cannot point Upzy at `localhost`.
- **Discovered subdomains are never scanned automatically.** You accept them first.
- **CVE matching is version-based.** Distributions backport fixes without changing versions, so findings say to confirm against your vendor's advisory.
- **Certificate-transparency sources are flaky.** crt.sh often returns 502; discovery falls back to certspotter, which is less complete. A full outage retries in an hour.
- The first scan of a page with several detected components takes tens of seconds because NVD is rate limited. Results are cached for 24 hours.

## Deploying

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): architecture, where to host it (one small VPS with Docker Compose and Caddy is the recommendation), step-by-step setup, backups, the config reference and the GitHub Actions release workflow. The files are in `deploy/` and `docker/`.

API checks, flows, secrets and heartbeats: [docs/MONITORS.md](docs/MONITORS.md).

Billing with Dodo Payments: [docs/BILLING.md](docs/BILLING.md).

Legal pages (terms, privacy, acceptable use, AI data use): [docs/LEGAL.md](docs/LEGAL.md).

First-run flow: [docs/ONBOARDING.md](docs/ONBOARDING.md).

Health score, fix-for-your-stack and Verify fix: [docs/HEALTH-AND-FIXES.md](docs/HEALTH-AND-FIXES.md).

Status pages, custom domains, incident updates and email subscribers: [docs/STATUS-PAGES.md](docs/STATUS-PAGES.md).
