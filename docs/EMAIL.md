# Email

Upzy sends email for invitations, password resets, the weekly digest and email alerts. It uses any SMTP server, set with two lines in `deploy/.env` on the server:

```
SMTP_URL=smtps://USER:PASSWORD@HOST:465
MAIL_FROM="Upzy <alerts@your-domain.com>"
```

After editing, restart the two containers that read them: `docker compose up -d api worker`. Then open **Account menu → Email settings** in the app and press **Send a test email to me**. It shows where mail is going (never the password) and whether the server could send.

If `SMTP_URL` is empty, nothing is sent and the app keeps working: webhook, Slack and Discord alerts are unaffected, and sign-up isn't blocked by an unconfirmed address.

## Which provider

|                                      | Gmail              | Brevo                           | Resend              | Amazon SES                                   |
| ------------------------------------ | ------------------ | ------------------------------- | ------------------- | -------------------------------------------- |
| Set-up time                          | 5 minutes          | 15 minutes                      | 15 minutes          | 30 minutes, plus a day for production access |
| Sends from                           | your Gmail address | your domain                     | your domain         | your domain                                  |
| Free allowance (check current terms) | about 500 a day    | a daily allowance               | a monthly allowance | pay as you go, very cheap                    |
| Best for                             | trying it out      | a free start on your own domain | developer-friendly  | already on AWS                               |

Proton Mail only offers SMTP on its business plans, or through the Proton Bridge desktop app, so it isn't practical for a server.

### Gmail

1. Turn on 2-step verification: myaccount.google.com/security.
2. Create an App Password: myaccount.google.com/apppasswords (16 characters, remove the spaces).
3. In `.env` (the `@` in your address becomes `%40`):
   ```
   SMTP_URL=smtps://you%40gmail.com:APP_PASSWORD@smtp.gmail.com:465
   MAIL_FROM="Upzy <you@gmail.com>"
   ```
   Gmail rewrites the sender to your Gmail address, so `MAIL_FROM` should be that address.

### Brevo

1. Create an account, add and verify your sending domain (Senders, Domains and IPs), and add the DNS records it shows (SPF and DKIM).
2. SMTP & API → SMTP: copy the login and generate an SMTP key.
3. `SMTP_URL=smtps://LOGIN:SMTP_KEY@smtp-relay.brevo.com:465`, `MAIL_FROM="Upzy <alerts@your-domain.com>"`.

### Resend

1. Add and verify your domain (it gives you the DNS records), then create an API key.
2. `SMTP_URL=smtps://resend:API_KEY@smtp.resend.com:465`, `MAIL_FROM="Upzy <alerts@your-domain.com>"`.

### Amazon SES

In the SES console: verify the domain, request production access (the sandbox only sends to verified addresses), create SMTP credentials, and URL-encode the user and password.

## DNS records for your own domain

Whichever provider you use, it shows records to add at your DNS host. They matter: without them, mail from `alerts@your-domain.com` often lands in spam.

- **SPF** (a TXT record on the domain): the provider tells you the exact `include:` value. If you already have an SPF record, add the include to it; a domain may have only one.
- **DKIM** (CNAME or TXT records): copy them exactly.
- **DMARC** (a TXT record at `_dmarc.your-domain.com`), a safe start: `v=DMARC1; p=none; rua=mailto:you@your-domain.com`.

## Troubleshooting

| The test says                         | Usually                                                                           |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| `Invalid login` / `535`               | wrong user or password; for Gmail it must be an App Password, not your normal one |
| `Connection timeout` / `ECONNREFUSED` | wrong host or port; use 465 with `smtps://`, or 587 with `smtp://`                |
| `self-signed certificate`             | the provider's certificate isn't trusted; use the provider's real hostname        |
| it says sent but nothing arrives      | check spam; missing SPF/DKIM; `MAIL_FROM` not on a verified domain                |
| `Sender address rejected`             | `MAIL_FROM` must be an address the provider lets you send from                    |
| nothing sent, no error                | `SMTP_URL` is empty on the worker too: `docker compose logs worker --tail 30`     |
