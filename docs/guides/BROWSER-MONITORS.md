# Browser monitors

A browser monitor opens a page in a real browser, does what a visitor would do, and checks what appears. Use it for what a plain HTTP check can't see: a page that only works after its scripts run, a login, a checkout that has to reach the next step.

It is **optional**. It needs a separate container with a browser in it, so it is off until the person running the server turns it on. Where it is off, the type isn't offered in the app and the API refuses to create one.

## For people using Upzy

**New monitor → Browser (page or login).** The **Target** opens first. Then add steps, in order:

| Step                          | What it does                                                            |
| ----------------------------- | ----------------------------------------------------------------------- |
| Click                         | Clicks the first element that matches the selector.                     |
| Type into a field             | Types text. Use `{{secret.NAME}}` for a password.                       |
| Press a key                   | Enter, Tab or Escape.                                                   |
| Wait for something to appear  | Waits up to 10 seconds for an element to be visible.                    |
| Expect this text              | Passes when the text is on the page (or inside a selector you give).    |
| Expect the address to contain | Passes when the page's address contains the text, such as `/dashboard`. |
| Open another page             | Goes to a public web address.                                           |
| Wait a moment                 | Pauses 0.1 to 5 seconds.                                                |

Selectors are CSS (`#email`, `button[type=submit]`), `text=Sign in`, or `role=button[name="Save"]`.

A step that can't be done within 10 seconds fails the check, and the message says which one: `Step 3 (expect the address to contain "/dashboard") failed: the address is …`. An error status on the first page (HTTP 4xx or 5xx) fails it too. The whole check is stopped after 60 seconds.

- **Passwords:** add a secret (for example `TEST_PASSWORD`) and type `{{secret.TEST_PASSWORD}}`. Secrets are encrypted, can't be read back, and are removed from any message before it is stored. Use a dedicated test account with no real permissions, not a person's login.
- **Interval:** every 5 minutes or slower. Browser checks are slow and use a lot of memory.
- **Plan:** Free 0, Starter 2, Pro 5, Agency 20.
- It works like every other monitor from here on: it goes down after the number of failed checks you chose, opens an incident, alerts your channels and resolves itself.
- It is checked from the main server only (no regions).

There is no scripting. A step is one of the choices above, so nothing a monitor contains can run code on Upzy's machines.

## For the person running the server

The browser runs in its own container, `ghcr.io/<UPZY_IMAGE_REPO>-browser`, built from `docker/Dockerfile.browser` on Playwright's image. Be aware it is **large (about 2.5 GB)** and each check uses several hundred MB of memory; plan for 2 GB of RAM headroom. On a small instance, add swap or run it on a second machine.

1. Choose a random token and add to `.env`:

   ```env
   COMPOSE_PROFILES=browser
   BROWSER_TOKEN=<a long random string>
   BROWSER_WS_ENDPOINT=ws://browser:3000/<the same token>
   WORKER_ROLES=scheduler,prober,notifier,scanner,agent,correlator,browser
   ```

2. `docker compose up -d`. The server's auto-update keeps the browser image current along with the rest, but only when the `browser` profile is on.

3. Check **New monitor**: the Browser type appears once the API sees `BROWSER_WS_ENDPOINT`.

### How it is kept contained

A browser loads whatever a page tells it to, so the setup is built to assume the page is hostile.

- **No Upzy in the browser container.** It has no database access, no secrets and no volumes. It shares one network with the worker and nothing else. It drops all capabilities, can't gain privileges, and has memory and process limits. The address contains the token, so only the worker can start a browser.
- **Public addresses only, enforced on the connection.** The worker starts a small proxy for each check and the browser sends all of its traffic through it, `localhost` included. The proxy resolves each host itself, refuses anything that is not a public address (private ranges, loopback, link-local such as cloud metadata) and connects to the address it checked, so redirects, images, scripts, WebSockets and DNS rebinding all get the same treatment. The proxy only works with that check's one-time credentials. HTTPS is tunnelled, not opened.
- **Data, not code.** Steps are a fixed set of actions validated on the way in; there is no way to run JavaScript or Playwright code.
- **One browser per check**, a fresh context that is thrown away: no cookies or storage carry over. Downloads, permission prompts and service workers are off.

Things this does not cover: WebRTC can send UDP outside the proxy. If you want to block it, deny UDP egress from the `browser` network in your firewall. Page content is not scanned for malware.

### Version match

The browser container and the worker must run the same Playwright version. `apps/worker/package.json` pins `playwright-core` to an exact version and `docker/Dockerfile.browser` pins the same one; a test fails if they differ. When updating, change both together.

### Trying it without Docker

```sh
node node_modules/playwright-core/cli.js install chromium-headless-shell
node node_modules/playwright-core/cli.js run-server --port 3999 --host 127.0.0.1 --path /token
BROWSER_WS_ENDPOINT=ws://127.0.0.1:3999/token bun run dev
```

The real-browser tests run the same way: `BROWSER_TEST_ENDPOINT=ws://127.0.0.1:3999/token bun test apps/worker/test/browser.test.ts` (they are skipped without it).
