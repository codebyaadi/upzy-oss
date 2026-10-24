# Alert integrations

Beyond email, Slack, Discord and signed webhooks, an alert channel can page your on-call tool or open an issue. Add one under **Alerts → Add channel**. Every channel has a **Send a test** button, and every test cleans up after itself: it never leaves an open page or issue behind.

All of them follow the same rules: an alert when a monitor goes down, another when it recovers, and (if the channel's rule includes it) one for each new critical or high security finding. One outage is one alert, and its recovery closes or resolves the same one.

Keys and tokens are encrypted at rest, shown once when you paste them, and never returned by the API.

## Microsoft Teams

1. In Teams, open the channel, then **Workflows** and create "Post to a channel when a webhook request is received" (or add an Incoming Webhook connector if your tenant still has them).
2. Copy the URL it gives you.
3. In Upzy choose **Microsoft Teams** and paste it. Only Microsoft hosts (`webhook.office.com`, `outlook.office.com`, `logic.azure.com`, `powerplatform.com`) are accepted.

The message is a card with the title, what happened, and an "Open in Upzy" button. Down is red, recovery is green, and findings below critical are amber.

## PagerDuty

1. In PagerDuty open the service, then **Integrations**, **Add an integration**, and pick **Events API v2**.
2. Copy its **Integration Key** (32 characters).
3. In Upzy choose **PagerDuty** and paste it.

An outage triggers an event and the recovery resolves it, tied together by the incident, so you never get a second page for the same outage. Findings trigger an event and are not resolved automatically (a fixed finding is closed in Upzy, not in PagerDuty). Severity is `critical` for a down monitor or critical finding, then `error`, `warning` and `info` for lower findings.

## Opsgenie

1. In Opsgenie open the team, then **Integrations**, **Add integration**, and pick **API**.
2. Copy the **API key** and note whether your account is in the US or the EU.
3. In Upzy choose **Opsgenie**, paste the key and pick the region.

An outage creates an alert (priority P1) and the recovery closes it by the same alias. A critical finding is P1, a high one P2, others P3.

## GitHub issues

1. Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens) limited to the one repository, with **Issues: Read and write**.
2. In Upzy choose **GitHub issues**, enter `owner/name` and the token.

An outage opens an issue titled `[Down] <monitor>` labelled `upzy` and `incident`, with a link back to the incident. When the monitor recovers, Upzy comments on that same issue and closes it. Security findings open an issue labelled `upzy` and `security`, and are left for you to close.

If an outage started before the channel was added, its recovery has no issue to close, so nothing happens.

## Good to know

- A provider refusing a request (a wrong key, a deleted repository) is retried, then shown as failed on the incident's delivery list so you can see why.
- Anything your own server can't reach (a Teams tenant that blocks it, for example) fails the same way. Nothing is lost: the incident and its other alerts are unaffected.
- To add a provider that isn't here, use a signed webhook ([README](../../README.md)) and let your own code forward it.
