# Client reports

An agency's clients rarely log in to a monitoring tool. A client report is the email that shows them the work: how much of the month their site was up, what went wrong, and how secure it is. It's part of the **Agency plan**.

## Setting one up

Open **Client reports** in the sidebar (admins only) while the client's workspace is selected.

1. Switch reports on and choose **monthly** (the 1st, covering the month before) or **weekly** (Monday, covering Monday to Sunday).
2. List the recipients, one address per line, up to 10.
3. Save, then press **Send me a test report** to see exactly what your client will get.

Reports go out at 07:00 UTC after a period ends. Each period is sent once.

## What's in it

- Overall uptime for the period, and per service.
- How many incidents opened and resolved, and the total downtime.
- The security grade, and how many issues were fixed, are new and are still open.
- A link to the live status page, if one is published.
- "Prepared by" your organization's name.

It deliberately leaves out what was found (finding titles and details), monitor addresses and error messages. It contains no AI-written text, only numbers computed from your data.

## Opting out

Every report has an unsubscribe link, and the recipient can opt out alone with one click. An address that has opted out stays opted out even if you list it again, so you can't re-add it by accident. You'll see which recipients unsubscribed on the page.

## Running it yourself

- Reports are sent through the same email settings as everything else ([EMAIL.md](EMAIL.md)).
- `CLIENT_REPORTS=off` on the worker sends none. They also stay off without `BETTER_AUTH_SECRET`, which signs the unsubscribe links.
- With billing switched off (self-hosted), every organization can use reports.
- If an organization's plan stops including reports, nothing is sent and no period is lost: the next report after it upgrades again is sent normally.
