# Billing with Dodo Payments

Upzy sells plans through [Dodo Payments](https://dodopayments.com), a merchant of record: Dodo is the seller, takes the payment and handles VAT/GST, so you don't register for tax in each country. Billing is **off by default**. With no Dodo keys set nothing is limited and the Billing page says so, which is right for self-hosting and early access.

## What the plans are

Defined in `packages/billing/src/plans.ts`, used by the server to enforce limits and by the pricing and billing pages to display them.

|                                      | Free  | Starter | Pro   | Agency |
| ------------------------------------ | ----- | ------- | ----- | ------ |
| Price per month (yearly = 10 months) | $0    | $15     | $39   | $99    |
| Monitors                             | 10    | 30      | 100   | 300    |
| Fastest check                        | 5 min | 1 min   | 1 min | 1 min  |
| Scanned domains/URLs                 | 1     | 3       | 10    | 30     |
| Status pages                         | 1     | 1       | 5     | 100    |
| Custom domain on a status page       | no    | yes     | yes   | yes    |
| Your client's logo on a status page  | no    | no      | no    | yes    |
| Scheduled client reports             | no    | no      | no    | yes    |

Team members are unlimited on every plan, and AI features run on the customer's own provider key, so neither is metered. Every new organization gets a **14-day Pro trial with no card**; the clock starts the first time its billing is looked at (so existing organizations get 14 days from when you switch billing on). After it, they are on Free.

A custom logo is checked when the page is shown, so an organization that leaves the Agency plan loses the logo from its pages (the setting is kept, and the logo comes back if it returns). Setting or changing the logo needs the plan; removing it never does. "Powered by Upzy" stays on every page on every plan.

Limits only stop **creating** more (a monitor, a scanned asset, a status page, a faster interval, a custom domain). Existing monitors keep running, alerts keep sending and public status pages stay up, whatever the plan or payment state. A billing problem can never silence an outage alert.

## Set it up

1. **Create an account** at Dodo Payments and finish their business verification. Start in **test mode**.
2. **Create products.** For each plan you want to sell, create a _subscription_ product: Starter, Pro and Agency, each with a monthly and, if you like, a yearly price (set the yearly price to ten times the monthly one to match the "two months free" shown in the app). Copy each product's id (`pdt_...`).
3. **Create an API key** (Developer → API keys) and a **webhook**:
   - URL: `https://<your API domain>/webhooks/dodo` (for example `https://upzy-api.example.com/webhooks/dodo`)
   - Events: all `subscription.*` events (at least `active`, `renewed`, `updated`, `plan_changed`, `past_due`, `on_hold`, `cancelled`, `expired`, `failed`)
   - Copy the signing secret (`whsec_...`).
4. **Set the variables** in `/opt/upzy/deploy/.env`, then `docker compose up -d api`:

   ```env
   DODO_API_KEY=...
   DODO_WEBHOOK_SECRET=whsec_...
   DODO_MODE=test
   DODO_PRODUCT_STARTER_MONTHLY=pdt_...
   DODO_PRODUCT_PRO_MONTHLY=pdt_...
   DODO_PRODUCT_PRO_YEARLY=pdt_...
   ```

   Products you leave out show "Not available yet" on the Billing page. Billing turns on only when **both** the key and the webhook secret are set.

5. **Try a real purchase in test mode** (Dodo gives test card numbers): sign in, open Billing, choose a plan, pay, and watch the page update within seconds. Then cancel from Manage billing and check it falls back to Free.
6. **Go live:** create the same products, key and webhook in live mode, put the live values in `.env` and set `DODO_MODE=live`.

## How it works

- **Buying:** an admin presses Choose on the Billing page. The server creates a Dodo checkout for the right product with the buyer's email and the organization id as metadata, remembers the checkout, and sends the browser to Dodo's page. Dodo returns the buyer to `/settings/billing`.
- **Webhooks:** Dodo calls `/webhooks/dodo`. The signature (Standard Webhooks: HMAC-SHA256 of `id.timestamp.body`) is checked first and requests older than five minutes are refused. Each delivery id is handled once, so retries do nothing. The organization is found from the metadata, else from the subscription id, else from the checkout we saved for that email (in case metadata isn't carried through). Events we can't place or don't use are acknowledged and logged.
- **Plan changes:** `active`/`renewed`/`plan_changed` put the organization on the plan of the product id; a product id we don't recognise never changes the plan. `past_due` keeps the plan during Dodo's grace period; `on_hold`, `cancelled`, `expired` and `failed` move the organization to Free (or the rest of its trial). Cancelling at period end shows "Cancels on …" until it ends.
- **Managing:** Manage billing opens Dodo's customer portal (cards, invoices, plan changes, cancellation).

## Checks and assumptions

- The Dodo calls follow their published API (`POST /checkouts`, `POST /customers/{id}/customer-portal/session`, Standard Webhooks). They were tested against a fake of that API and by sending correctly signed webhooks to a running server, but **not against Dodo's live service**: do the test-mode purchase in step 5 before relying on it.
- If your webhook payloads don't include `metadata`, the first subscription is matched by the buyer's email within three days of starting checkout. The buyer should use the same email as their Upzy account (it is pre-filled).
- Upgrading or downgrading an existing subscription is done in the Dodo portal; the resulting `plan_changed` event updates Upzy.
- Refunds, invoices and tax documents come from Dodo.
