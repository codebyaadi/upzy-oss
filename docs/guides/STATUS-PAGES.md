# Status pages and custom domains

A status page is a public page (`/status/<address>`) that shows whether chosen monitors are up, their 90-day uptime and recent incidents. Create one under **Status pages** in the app. It is off until you switch on **Published**.

## What the public sees

Only what you choose to show: the public names you give each component, whether it is up, uptime percentages, and incidents as "<Name> was unavailable" with a start time and a length. Never monitor addresses, ids, incident titles, error text or anything about your organization. A component counts as down only while an incident is open (or the monitor is failing outside a maintenance window), so one failed check never appears.

Each component shows one of **Operational**, **Degraded performance** (slow for several checks in a row), **Under maintenance** (a scheduled window covers it) or **Unavailable**. The banner follows the worst state: an outage outranks slowness, and slowness outranks planned maintenance. Scheduled maintenance, now or within two weeks, is listed under the banner with its name and times. See [Monitors](MONITORS.md#maintenance-windows) for how windows work and what stays internal.

## Posting incident updates

Open an incident and use **Updates for customers** to post a message with a stage (Investigating, Identified, Monitoring or Update). Updates show under that incident on every public status page that lists the incident's monitor, newest first, within seconds. Remove one and it disappears just as fast.

Updates are the one place where text you write goes public, so write them for customers. The incident's own title, AI triage and postmortem stay private. The "Resolved" label still comes from the incident closing, so you don't post that yourself.

## Security grade and badges

A page can show the [health grade](HEALTH-AND-FIXES.md) of one of your assets: edit the page and pick an asset under "Show a security grade". It is off by default. The public page then shows "Security grade A" with the date of the last scan. Only the letter and that date are public, never the score, the findings or the asset's name. An asset that has never been scanned shows nothing, and the asset must belong to the same workspace as the page.

Published pages also get two embeddable badges (**Show embeddable badges** on the page's card), as HTML or Markdown, for a README or a site footer:

- `…/public/status/<address>/badge.svg?type=status` shows "status | operational / degraded / outage".
- `…/public/status/<address>/badge.svg?type=security` shows "security | A" and only exists when a grade is switched on.

Badges are images served by Upzy, cached for five minutes, built from a fixed set of words (never your page's text), and link back to the page. An unpublished page has no badge.

## Your client's logo (Agency plan)

On the Agency plan, edit a page and set a **Logo**: the full `https://` address of an image. It shows above the page title. "Powered by Upzy" stays at the bottom of every page. Emails that go to the page's subscribers come from Upzy.

## Email subscribers

Every public status page has a "Get updates by email" form (also on custom domains). A visitor enters an address, gets a confirmation email, and only after pressing **Confirm subscription** on the page it links to do they receive anything. Every email carries a one-click unsubscribe link (and a `List-Unsubscribe` header).

Subscribers get an email when an incident opens on a monitor the page lists, when you post an update, and when it recovers. The email uses the public name of the component, never the incident title or error text, plus the message you wrote for customers. Admins see only how many people subscribed, not their addresses.

Email goes out through the same SMTP settings as everything else (see [EMAIL.md](../self-hosting/EMAIL.md)); until SMTP is set up, confirmation emails can't be delivered.

Limits that protect the people whose addresses get typed in: a page sends at most 30 confirmation emails an hour, never mails the same address again within 10 minutes, accepts up to 2,000 subscribers, and forgets addresses that never confirmed after a week. The confirm and unsubscribe links only show a button; the action happens when the button is pressed, so a mail scanner that opens links can't confirm or cancel anyone.

## Using your own domain

You can serve the page on your own address, for example `status.example.com`.

1. Open the status page in the app, press **Edit**, enter the domain under **Custom domain**, and save.
2. Upzy shows two DNS records to add at your DNS provider:
   - a **TXT** record that proves the domain is yours, for example `_upzy-challenge.status.example.com` with the value shown (`upzy-verify=...`);
   - a **CNAME** record that sends visitors to Upzy: `status.example.com` pointing at your Upzy address (for example `upzy.example.com`).
3. Press **Check DNS**. When the TXT record is found, the domain is marked **Verified**. DNS changes can take a few minutes.
4. Publish the page. The first visit to `https://status.example.com` takes up to a minute while its HTTPS certificate is issued automatically; after that it loads at once.

Only the TXT record can verify a domain, so nobody can take over a name they don't control by merely claiming it. If two pages claim the same name, whichever proves ownership first holds it.

Changing or removing the domain starts over: the old name stops working immediately and a new name needs a new proof.

### Notes

- Use a subdomain (`status.example.com`). A bare domain (`example.com`) can't be a CNAME in most DNS providers.
- If your DNS provider proxies traffic (Cloudflare's orange cloud), set the status record to **DNS only** so the certificate can be issued.
- Pages on custom domains show only the status page itself; every other path on that domain returns 404.
- Certificates come from Let's Encrypt, which limits how many it will issue per week. That is plenty for normal use, but don't add and remove dozens of domains.

## How it works (for operators)

- The web app's `proxy.ts` looks at the `Host` of each request. Requests for Upzy's own address pass through; for any other host, `/` is rewritten to that domain's status page and everything else is a 404.
- Caddy serves HTTPS for those names with **on-demand TLS**. Before requesting a certificate for a name it has never seen, Caddy asks the API (`/internal/tls-check`), which says yes only for a verified, published custom domain, and only to Caddy itself (requests that came through the proxy carry `X-Forwarded-For` and are refused). Without that check anyone could point a domain at your server and make it request certificates.
- Nothing extra is needed in `deploy/.env`. After updating, the Caddyfile is picked up by the auto-updater (or `docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile`).
- Ports 80 and 443 must stay open to the internet (they already are).

## Troubleshooting

| Problem                                                  | Usually                                                                                                                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "Not found yet" after adding the TXT record              | DNS hasn't propagated, the name or value was copied wrongly, or your provider added the domain twice (some append it for you: enter just `_upzy-challenge.status`) |
| Verified, but the page doesn't load                      | the CNAME isn't set or points elsewhere; check `dig +short CNAME status.example.com`                                                                               |
| Browser shows a certificate error on first visit         | wait a minute and reload; if it persists, the name isn't pointing at the server or the page isn't published                                                        |
| "That domain is already verified on another status page" | another page holds the name; remove it there first                                                                                                                 |
