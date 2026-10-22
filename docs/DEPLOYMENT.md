# Deploying Upzy

> Deploying on AWS? The same Compose stack runs on one EC2 instance. The `aws` Compose profile adds an `offsite` service that copies the nightly dumps to S3 (see `BACKUP_S3_URI` in `deploy/.env.example`).

This is the plan for running Upzy in production: where, how, and how the pieces connect. The files it refers to are in `deploy/`, `docker/` and `.github/workflows/deploy.yml`.

**Recommendation: one small VPS running Docker Compose, with Caddy for HTTPS.** It is the cheapest setup that runs every part of Upzy correctly, it has the fewest moving parts to get wrong, and it can be split up later without rewriting anything. Section 2 compares it with the alternatives.

---

## 1. What runs, and how it connects

```
                         Internet
                            |
                 :80 / :443 | (Let's Encrypt certificates, automatic)
                      +-----v-----+
                      |   Caddy   |
                      +--+-----+--+
        app.example.com  |     |  api.example.com
                  +------v-+ +-v------+
   browser -----> |  web   | |  api   | <----- browser (fetch + session cookie, CORS)
                  | Next.js| | Elysia |
                  +--------+ +---+----+
                                 |  SQL
                           +-----v------+        +-----------------------------+
                           |  Postgres  | <----- |  worker (no ports)          |
                           |  18 + vec  |  jobs  |  scheduler, prober, notifier|
                           +-----^------+        |  scanner, AI agent          |
                                 |               +---+-----------+-------+-----+
                            nightly dump             |           |       |
                            (backup)         probes/scans   SMTP server  AI provider
                                             (the internet) (alerts)     (the org's own key)
```

| Connection                         | How                                                   | Notes                                                                                                                                                                            |
| ---------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser to **web**                 | HTTPS `app.example.com`                               | Static pages and client-side code. No secrets.                                                                                                                                   |
| Browser to **api**                 | HTTPS `api.example.com`, `fetch` with credentials     | The two hostnames are _siblings_, so the session cookie is set for `.example.com` (`COOKIE_DOMAIN`) and CORS allows exactly `WEB_ORIGIN`.                                        |
| **web** to **api**                 | Only from the browser                                 | The web container never calls the API itself, so it needs no secrets and no route to Postgres.                                                                                   |
| **api** to **Postgres**            | `DATABASE_URL`, private Docker network                | Postgres is not published on the host.                                                                                                                                           |
| **worker** to **Postgres**         | Same                                                  | The job queue is a Postgres table (`FOR UPDATE SKIP LOCKED`): no Redis, no broker.                                                                                               |
| **worker** to the internet         | Outbound only                                         | Monitor probes and security scans go through the SSRF guard, which refuses private/internal addresses (so a monitor can't be pointed at Postgres or the cloud metadata service). |
| **worker** to email                | `SMTP_URL`                                            | Any SMTP provider. Alerts, invitations and password resets are queued and sent from here.                                                                                        |
| **api / worker** to an AI provider | HTTPS, with the _organization's own_ API key          | Upzy holds no AI key. Customer keys are stored encrypted with `UPZY_ENCRYPTION_KEY`.                                                                                             |
| **Caddy**                          | Terminates TLS, forwards to `web:3001` and `api:3000` | Overwrites `X-Forwarded-For`, which is why `TRUST_PROXY=true` is safe here.                                                                                                      |

The Compose file puts Postgres alone on an `internal` network (no internet access) and gives the API and worker a second network for outbound traffic.

---

## 2. Where to deploy

|                     | **A. One VPS + Compose** (recommended)           | **B. Split managed services**                                                                                  | **C. Kubernetes**                               |
| ------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Shape               | Everything in `deploy/compose.yml` on one server | Web on Vercel (or Cloudflare), API + worker on Fly.io / Railway / Render, Postgres on Neon / Supabase          | Helm/Kustomize on a managed cluster             |
| Rough cost\*        | about 5 to 10 USD/month                          | about 20 to 50 USD/month once the worker and a database are paid for                                           | 70+ USD/month                                   |
| Effort              | Low: one file, one command                       | Medium: four dashboards, four sets of env vars                                                                 | High                                            |
| Fits Upzy's workers | Yes: they are long-running processes             | Worker needs an always-on container (not serverless)                                                           | Yes                                             |
| Main risk           | One machine is a single point of failure         | Postgres must be **version 18** (the schema uses `uuidv7()`); check the provider offers it, or you need a shim | Over-engineered for this size                   |
| Move here when      | (Start here)                                     | You want zero server upkeep and can pay for it                                                                 | You need several regions and teams of operators |

\*Order-of-magnitude estimates, not quotes. Check current provider pricing.

**Why A wins now:** Upzy is a small, always-on system whose heaviest parts (probing, scanning) are simple outbound requests. A 2 vCPU / 2 to 4 GB server handles it, and the images are built in CI, so the server never compiles anything. Providers that work well: Hetzner Cloud, DigitalOcean, Vultr, Linode, or Oracle's always-free ARM instance (the images are multi-arch capable if you build with `platforms: linux/amd64,linux/arm64`; the provided workflow builds amd64 only, add arm64 if you pick an ARM machine).

Things to confirm with whichever provider you pick:

- Outbound ports 443 and 80 are open (probing, AI providers), and 465/587 if you use SMTP over those ports.
- You get a stable public IPv4 (you will want it for DNS, and for allow-listing if a customer restricts who may probe them).
- Port 25 is irrelevant: use an email API provider's SMTP relay (Resend, Brevo, Postmark, Amazon SES), not your own mail server.

**Upgrade path without rewrites** (each is a config change):

1. **Managed Postgres:** point `DATABASE_URL` at it and remove the `postgres`/`backup` services.
2. **Separate worker machine:** run only `worker` with `WORKER_ROLES=...` on another host that can reach Postgres over TLS.
3. **More probe regions:** a tiny VPS in another region running `WORKER_ROLES=prober` with its own `WORKER_REGION`. This needs the database reachable from it (TLS and an IP allow-list); a message bus such as Redpanda is the longer-term answer.
4. **Web on Vercel:** build with `NEXT_PUBLIC_API_URL` set and keep the API on the server. Keep web and API on sibling subdomains so the cookie still works.

---

## 3. Before you start

You need:

- A **domain** you control, and two hostnames under it: `app.<domain>` and `api.<domain>`.
- A **server** (Ubuntu 24.04 LTS or similar), root or sudo, with your SSH key on it.
- An **SMTP relay** account, with SPF and DKIM set up for your sending domain, so alerts land in inboxes.
- A **GitHub repository** for the code (the workflow pushes images to its container registry).

---

## 4. First deployment, step by step

### 4.1 DNS

Create `A` (and `AAAA` if you have IPv6) records pointing at the server's IP:

```
app.example.com   A   203.0.113.10
api.example.com   A   203.0.113.10
```

### 4.2 Prepare the server

```bash
# As root, once. Replace "deploy" with the user name you want.
adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy
mkdir -p /home/deploy/.ssh && cp ~/.ssh/authorized_keys /home/deploy/.ssh/ && chown -R deploy:deploy /home/deploy/.ssh

# Keys only, no root login
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/; s/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl restart ssh

# Firewall: SSH, HTTP, HTTPS. Postgres is never exposed.
ufw default deny incoming && ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443 && ufw --force enable

# Security updates
apt-get update && apt-get install -y unattended-upgrades

# Docker (official convenience script; review it first if you prefer)
curl -fsSL https://get.docker.com | sh
usermod -aG docker deploy
```

> Docker publishes ports by editing iptables directly, which bypasses `ufw`. That is why the Compose file publishes **only** Caddy's 80/443 and nothing else.

### 4.3 Put the deploy files on the server

```bash
# As the deploy user
sudo mkdir -p /opt/upzy && sudo chown deploy:deploy /opt/upzy
git clone https://github.com/<you>/upzy.git /opt/upzy      # or copy just the deploy/ directory
cd /opt/upzy/deploy
cp .env.example .env && chmod 600 .env
```

### 4.4 Fill in `deploy/.env`

Generate the secrets on the server and paste them in:

```bash
openssl rand -hex 24      # POSTGRES_PASSWORD
openssl rand -base64 32   # BETTER_AUTH_SECRET
openssl rand -base64 32   # UPZY_ENCRYPTION_KEY
```

Set `DOMAIN_APP`, `DOMAIN_API`, `COOKIE_DOMAIN` (with the leading dot), `ACME_EMAIL`, `UPZY_IMAGE_REPO`, `SMTP_URL` and `MAIL_FROM`. The full list is in section 7.

> **Back up `UPZY_ENCRYPTION_KEY` somewhere safe (a password manager).** It encrypts notification-channel secrets and every customer's AI API key. If it is lost, those values cannot be recovered and people must re-enter them. Rotating it is not supported yet.

#### Optional: sign in with GitHub

1. At <https://github.com/settings/developers> choose **New OAuth App**.
2. **Homepage URL**: `https://<DOMAIN_APP>`. **Authorization callback URL**: `https://<DOMAIN_API>/api/auth/callback/github` (the API host, not the web host).
3. Generate a client secret, then set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in `deploy/.env` and run `docker compose up -d api`.

The "Continue with GitHub" button appears on the login and sign-up pages by itself; with either variable empty it stays hidden. GitHub does not change who may sign up: a new account created through GitHub follows `SIGNUP_MODE` and the allow-lists exactly like an email sign-up, and a GitHub account whose verified email matches an existing account signs in to that account. Use a separate OAuth app (callback `http://localhost:3000/api/auth/callback/github`) for local development.

### 4.5 Build and publish the images

In the GitHub repository settings:

- **Variables:** `PUBLIC_API_URL` = `https://api.example.com` (this is baked into the browser bundle at build time).
- Allow Actions to publish packages (default for the repo owner).

Then tag a release:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

The **Deploy** workflow builds `ghcr.io/<owner>/<repo>-server` and `...-web`. For a private repository, make the packages readable by the server: create a personal access token with `read:packages` and run `docker login ghcr.io -u <user>` once on the server.

> No registry? Build on the server instead: in `compose.yml` add a `build:` block per image (`context: ..`, `dockerfile: docker/Dockerfile.server` / `Dockerfile.web`, plus the `NEXT_PUBLIC_API_URL` build arg for web) and run `docker compose build`. It needs about 4 GB of RAM while building.

### 4.6 Start it

```bash
cd /opt/upzy/deploy
docker compose pull
docker compose up -d
docker compose ps          # every service "healthy" or "running"; migrate "exited (0)"
docker compose logs -f api worker
```

Order of events: Postgres becomes healthy, `migrate` applies the SQL migrations and exits, then `api` and `worker` start, and Caddy requests certificates the first time someone visits.

### 4.7 Check it

```bash
curl https://api.example.com/health      # {"status":"ok","database":"up"}
```

Open `https://app.example.com`, sign up, create an organization, add a monitor. Sign-up emails arrive only if SMTP works: check `docker compose logs worker` for `[email] sent`. Then open **Settings → AI**, add your own provider key if you want the AI features.

### 4.8 Turn on automatic releases (optional)

In the repository, set variable `DEPLOY_ENABLED=true`, create an environment named `production`, and add secrets `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY` (a deploy-only key whose public half is in the server user's `authorized_keys`). After that, pushing a tag builds, pushes and rolls out.

---

## 5. Day-to-day operations

**Release:** push a tag. Rollback: set `IMAGE_TAG=<previous sha>` in `deploy/.env` and `docker compose up -d`. Migrations only move forward, so before a release that changes the schema, take a manual backup (below). A rollback after a schema change may need the matching restore.

**Backups:** the `backup` service writes `deploy/backups/upzy-YYYY-MM-DD.sql.gz` nightly and keeps 14. That protects against mistakes, not against losing the server, so copy them off the machine, e.g. a nightly `rclone`/`rsync` of `deploy/backups` to object storage. Manual dump and restore:

```bash
docker compose exec -T postgres pg_dump -U upzy upzy | gzip > manual-$(date +%F).sql.gz
# Restore into an empty database (stop api and worker first):
docker compose stop api worker
gunzip -c manual-2026-10-16.sql.gz | docker compose exec -T postgres psql -U upzy -d upzy
docker compose start api worker
```

Test a restore once, on a scratch machine, before you need it.

**Logs:** `docker compose logs -f --tail=200 api worker`. Compose's default log driver does not rotate; add to `/etc/docker/daemon.json` `{"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"3"}}` and restart Docker.

**Watching Upzy itself:** a monitoring tool that monitors itself goes silent exactly when it fails. Add an external check on `https://api.example.com/health` from a different provider (a free uptime service is enough) that alerts you by a channel other than Upzy.

**Updating the OS:** `unattended-upgrades` handles security patches; reboot occasionally (`docker compose` restarts everything: all services use `restart: unless-stopped`).

**Capacity:** the main limit is the worker's probe concurrency (20 at a time) and AI calls (one at a time, `AI_RPM_LIMIT` per minute). If checks start to lag, move the worker to its own machine first.

---

## 6. Security checklist

- [ ] SSH: keys only, root login off, `ufw` allows only 22/80/443.
- [ ] `deploy/.env` is mode 600 and not in git (`.env` is git-ignored; only `.env.example` is committed).
- [ ] Secrets are random and unique; `UPZY_ENCRYPTION_KEY` is backed up.
- [ ] Postgres has no published port (`docker compose ps` shows none for it).
- [ ] The better-auth API reference page is off in production (it returns 404).
- [ ] `COOKIE_DOMAIN` is your registrable domain with a leading dot; cookies are `Secure` because `BETTER_AUTH_URL` is https.
- [ ] Sign-ups are locked (`SIGNUP_MODE=invite`, the default) and your email is in `SIGNUP_ALLOWED_EMAILS`.
- [ ] Backups are copied off the server and a restore has been rehearsed.
- [ ] SPF, DKIM and DMARC are set for `MAIL_FROM`'s domain.
- [ ] GitHub: the `production` environment requires a reviewer, and the deploy key can only log in as the deploy user.

---

## 7. Configuration reference

Compose reads `deploy/.env` and passes the right subset to each container.

| Variable                                    | Used by                       | Required       | Meaning                                                                                                                                    |
| ------------------------------------------- | ----------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `DOMAIN_APP`, `DOMAIN_API`                  | Caddy, api, web, worker       | yes            | Public hostnames (`app.example.com`, `api.example.com`). They become `WEB_ORIGIN`, `BETTER_AUTH_URL` and `APP_URL` automatically.          |
| `COOKIE_DOMAIN`                             | api                           | yes            | Shares the session cookie across the two subdomains: `.example.com`. Leave empty only if you serve both from one hostname.                 |
| `ACME_EMAIL`                                | Caddy                         | yes            | Contact for Let's Encrypt.                                                                                                                 |
| `UPZY_IMAGE_REPO`, `IMAGE_TAG`              | Compose                       | yes            | Which images to run: `ghcr.io/<UPZY_IMAGE_REPO>-server:<IMAGE_TAG>` and `-web`.                                                            |
| `POSTGRES_PASSWORD`                         | postgres, api, worker, backup | yes            | Database password (the user and database are both `upzy`).                                                                                 |
| `BETTER_AUTH_SECRET`                        | api                           | yes            | Signs sessions. At least 32 characters.                                                                                                    |
| `UPZY_ENCRYPTION_KEY`                       | api, worker                   | yes            | 32 bytes, base64. Encrypts channel secrets and customers' AI keys.                                                                         |
| `SMTP_URL`, `MAIL_FROM`                     | worker                        | for email      | Empty `SMTP_URL` disables email delivery (alerts then go only to webhooks/Slack/Discord channels).                                         |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`  | api                           | no             | Turns on "Continue with GitHub" (see 4.4). Both are needed; empty hides the button.                                                        |
| `NVD_API_KEY`                               | worker                        | no             | Raises the CVE-lookup rate limit.                                                                                                          |
| `AI_RPM_LIMIT`, `AI_ORG_DAILY_TOKEN_BUDGET` | api, worker                   | no             | Limits only. There is no AI provider key on the server.                                                                                    |
| `WORKER_ROLES`, `WORKER_REGION`             | worker                        | no             | Which jobs this worker runs and how it labels checks.                                                                                      |
| `TRUST_PROXY`                               | api                           | set by Compose | `true` behind Caddy, so rate limits and the audit log see real client IPs. Never set it without a proxy that overwrites `X-Forwarded-For`. |
| `NEXT_PUBLIC_API_URL`                       | web (**build time**)          | yes, in CI     | Set as the `PUBLIC_API_URL` repository variable. Changing it needs a rebuilt web image.                                                    |

**Config changes made for deployment** (already in the repo):

- `COOKIE_DOMAIN` support in `packages/auth` (cross-subdomain session cookie, `Secure` cookies when the URL is https).
- The auth API reference page is disabled when `NODE_ENV=production`.
- `packages/db/src/migrate.ts`: applies migrations without drizzle-kit, used by the `migrate` service.
- `apps/web/next.config.ts`: `output: "standalone"` when `NEXT_STANDALONE=true` (set by the Dockerfile).

---

## 8. Trying the production setup on your own machine

You can run the exact production stack locally, with Caddy using its own local certificate authority for `*.localhost` names:

```bash
docker build -f docker/Dockerfile.server -t ghcr.io/me/upzy-server:smoke .
docker build -f docker/Dockerfile.web --build-arg NEXT_PUBLIC_API_URL=https://api.localhost -t ghcr.io/me/upzy-web:smoke .
cd deploy
cat > .env <<EOF
DOMAIN_APP=app.localhost
DOMAIN_API=api.localhost
COOKIE_DOMAIN=.localhost
ACME_EMAIL=me@example.com
UPZY_IMAGE_REPO=me/upzy
IMAGE_TAG=smoke
POSTGRES_PASSWORD=$(openssl rand -hex 12)
BETTER_AUTH_SECRET=$(openssl rand -base64 32)
UPZY_ENCRYPTION_KEY=$(openssl rand -base64 32)
EOF
docker compose up -d --pull never
```

---

## 9. Known limits of this setup

- **One server is one failure domain.** A reboot or provider incident pauses checks and alerts until it is back. Mitigation: the external health check above, and the upgrade path in section 2.
- **Rate limiting is per API process** (in memory). With one API container that is correct; with several you would want a shared store.
- **No central log or metrics system.** Use `docker compose logs`; add a log shipper when you need one.
- **Email deliverability is the most common production surprise.** Verify SPF/DKIM/DMARC and send yourself a test alert before relying on it.
- **Migrations are forward-only.** Rollbacks across a schema change need a restore.
