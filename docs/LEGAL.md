# Legal pages

Upzy ships five public pages, linked from the landing page footer and the sign-up form:

| Page             | Address           | What it is for                                                              |
| ---------------- | ----------------- | --------------------------------------------------------------------------- |
| Terms of Service | `/terms`          | the agreement for using the service                                         |
| Privacy Policy   | `/privacy`        | what data is handled, by whom, for how long, and the user's rights          |
| Acceptable Use   | `/acceptable-use` | what Upzy sends to a target, what may be scanned, how to report misuse      |
| AI data use      | `/ai-data`        | exactly what goes to the AI provider the customer chose, and the safeguards |
| UpzyBot          | `/bot`            | for people who find the crawler in their logs                               |

The user agent Upzy sends links to `/bot` on your own address (`UpzyBot/1.0 (+https://<your app domain>/bot)`), so anyone who sees it in their logs can find out who is asking and how to stop it.

## Set these before inviting anyone

In `/opt/upzy/deploy/.env` on the server (they are read when a page is requested, so no rebuild is needed; run `docker compose up -d web` after changing them):

```env
LEGAL_ENTITY=Your Legal Name or Company
CONTACT_EMAIL=you@example.com
LEGAL_JURISDICTION=India
```

- `LEGAL_ENTITY` is who "we" is. It defaults to `codebyaadi`.
- `CONTACT_EMAIL` is shown for privacy requests, abuse reports and security reports. Use a mailbox you actually read. Without it the pages point to the GitHub profile.
- `LEGAL_JURISDICTION` is optional. When set, the Terms gain a governing-law clause; when not, they don't name one.

## What the text relies on

The pages describe what the software really does, and must be kept true when it changes:

- AI is off by default and runs only on the customer's own key; secrets are redacted before sending.
- Passwords are hashed, channel secrets and provider keys are encrypted with AES-256-GCM.
- Monitor check history is deleted after 90 days (`CHECK_RETENTION_DAYS`); keep the Privacy Policy line in step if you change it.
- Backups expire after 30 days; status page subscribers who never confirm are removed after 7 days.
- No analytics or advertising cookies; one session cookie, a sidebar preference and local storage for the selected workspace and theme.
- Scans are passive: no logins, no guessing, no port scans, no exploitation. If active checks are ever added, update Acceptable Use, UpzyBot and the Terms first.
- Subprocessors named in the Privacy Policy: AWS, the email delivery provider, Dodo Payments (only for people who buy a plan), Let's Encrypt, public data sources, and the customer's AI provider. Add any new one there.

There is no self-service account or organization deletion yet, so the Privacy Policy tells people to write to the contact address; deleting an organization cascades to its data.

## Review

These pages are a sound starting point written from the product's behaviour, not legal advice. Have a lawyer in your jurisdiction review them before you rely on them, especially the liability limits, the governing-law clause, data-protection obligations that apply to you (GDPR, India's DPDP Act, and so on) and whether you need a data processing agreement for business customers.
