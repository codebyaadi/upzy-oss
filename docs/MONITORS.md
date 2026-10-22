# Monitors

Upzy has seven kinds of monitor. Four check a thing from outside (HTTP, TCP, DNS, SSL), and two are built for apps and their backends: **API checks** (richer HTTP, and multi-step flows) and **heartbeats**. A mobile app is "up" when the backend it talks to is, so these are how you watch one.

| Type          | What it does                                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| HTTP          | Requests a URL, expects a 2xx/3xx (or the statuses you list), optionally a word on the page and checks on the JSON it returns |
| API flow      | Up to five requests in order, each able to use values read from the one before                                                |
| Heartbeat     | Waits for your job to call a web address; alerts when it goes quiet                                                           |
| TCP, DNS, SSL | A port that must accept connections, a name that must resolve, a certificate that must be valid                               |

## HTTP monitors with headers, a body and JSON checks

Under **Advanced** on an HTTP monitor:

- **Method:** GET, POST or HEAD. A POST can send a body (sent as JSON if it looks like JSON, otherwise as text). HEAD has no body to check.
- **Headers:** up to ten, sent with every check (`Accept`, `X-App-Version`, `Authorization`...). `Host`, `Content-Length`, `Connection`, `User-Agent` and `Proxy-*` are set by Upzy and can't be overridden: Upzy always identifies itself as UpzyBot.
- **Checks on the JSON response:** each is a path, a comparison and a value, and all must pass. Paths use dots and `[0]` for lists, e.g. `data.items[0].status`. Comparisons: equals, doesn't equal, contains (text, or an item of a list), exists, is missing, greater than, less than. Example: `status` equals `ok`, and `queue.depth` is less than `1000`. If the response isn't JSON the check says so.
- **Secrets:** see below.

When a check fails the message names the path and what was expected, e.g. `Expected data.status to equal ok, but it is degraded`. It shows the actual value only for short numbers and text, never for objects.

## Secrets

Anything you shouldn't have lying in a header (an API token, a password) goes in **Secrets**, as `API_TOKEN` and a value. Use it anywhere in a header, body or address as `{{secret.API_TOKEN}}`, e.g. `Authorization: Bearer {{secret.API_TOKEN}}`.

- Stored **encrypted** (AES-256-GCM, with `UPZY_ENCRYPTION_KEY`), only decrypted by the worker for the moment of a check, and **never returned by the API or shown in the UI again**. Editing a monitor shows the names; leave a value blank to keep it, type one to replace it, remove a row to delete it.
- Scrubbed from error messages: if an error would contain a secret's value (or a value read from an earlier step), it is replaced by `***` before it is stored.
- A `{{secret.NAME}}` that isn't defined is refused when you save, so a typo can't turn into a literal `{{...}}` being sent.
- Because the encryption key protects them, **keep `UPZY_ENCRYPTION_KEY` backed up**: lose it and every secret has to be entered again.

Use a credential made for monitoring (a read-only token, a test account), not a personal one.

## API flows

A flow is up to five requests run in order, for the things a single request can't check: log in, then call an endpoint with the token it returned.

Each step has a name, a method (GET or POST), an address, headers, an optional body, checks on the response, and **values to read for later steps** (`token = data.token`). Later steps use them as `{{token}}`:

1. `POST https://api.example.com/login`, body `{"user":"probe","password":"{{secret.PASSWORD}}"}`, read `token = data.token`.
2. `GET https://api.example.com/me`, header `Authorization: Bearer {{token}}`, check `email` exists.

The first failing step ends the run and the error says which: `Step 2 (Fetch profile): unexpected status 500`. A step passes on a 2xx/3xx unless you set other statuses. The whole flow has 30 seconds. Variables can appear in the path and query of an address, never in the host. A flow counts as one monitor.

Every address must be a public one (the same SSRF protection as every other monitor), and none may contain credentials.

## Heartbeats

For jobs you can't check from outside: a nightly backup, a queue worker, a cron job, the thing that sends push notifications. Create a heartbeat and say how often the job should check in and how late it may be (the grace, by default 10% of the period). Upzy gives you a **ping address**; the job calls it when it finishes:

```bash
# cron, only when the job succeeded:
0 * * * * /path/to/job.sh && curl -fsS -m 10 --retry 3 https://<api domain>/ping/<token> >/dev/null

# also tell us when it fails, so you're alerted at once instead of after the grace:
/path/to/job.sh && curl -fsS -m 10 --retry 3 https://<api domain>/ping/<token> || curl -fsS -m 10 https://<api domain>/ping/<token>/fail
```

- Any method works (GET, POST, HEAD). `/fail` reports a failure; the next ordinary ping clears it.
- If no ping arrives within the period plus the grace, an incident opens: `No ping for 3 hours (expected every 60 minutes, plus 6 minutes grace)`. The next ping resolves it within seconds.
- A new heartbeat isn't late until its first period is over, and resuming a paused one starts the clock again.
- The ping address is the only credential: anyone who has it can report as your job. It is shown to members and admins only, and **Create a new address** replaces it (the old one stops working at once).
- A heartbeat appears on status pages, in alerts and in incidents like any other monitor. It has no uptime percentage of its own (only changes of state are recorded), but status page uptime is computed from incidents as for every monitor.
- Heartbeats are on every plan. They count towards the plan's monitor limit, but the 5-minute minimum interval of the free plan doesn't apply: they are passive.

## Limits worth knowing

- Checks run from one location (no multi-region yet).
- Redirects are followed (up to five) for GET and HEAD, never for POST.
- Responses are read up to 1 MB.
- A monitor's address can't be changed after creation (create a new one); everything else can, from **Edit**.
