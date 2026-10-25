# Connect an AI assistant (MCP)

Upzy has a read-only [Model Context Protocol](https://modelcontextprotocol.io) server. Connect Claude Code (or any MCP client) and ask things like "which monitors are down?", "what broke last night?" or "which findings should I fix first?".

It can only **read**. It cannot create, change, pause or delete anything.

## 1. Create a key

In Upzy, open **Security** (from your avatar menu) and find **AI assistant access (MCP)**. Only organization admins can create keys.

- Give the key a name you will recognise ("Claude Code on my laptop").
- Choose what it may read:

| Scope            | Lets it use                                                              |
| ---------------- | ------------------------------------------------------------------------ |
| `monitors:read`  | workspaces, monitors and their status, reliability numbers, certificates |
| `incidents:read` | open and past incidents                                                  |
| `security:read`  | assets and security findings                                             |

Copy the key when it appears. It starts with `upzy_mcp_` and is shown **once**; Upzy keeps only a hash. Keys expire after 90 days, and you can revoke one at any time from the same page.

A key acts as the person who made it. If you can only see some workspaces, so can your key. If you leave the organization, your keys stop working.

## 2. Connect Claude Code

```bash
claude mcp add --transport http upzy https://YOUR-API-ADDRESS/mcp --header "Authorization: Bearer upzy_mcp_..."
```

Use your API address (for example `https://upzy-api.example.com`). Then ask Claude Code about your monitoring; `/mcp` shows the tools it found.

Any client that speaks MCP over HTTP (Streamable HTTP, JSON responses) works the same way: `POST /mcp` with `Authorization: Bearer <key>`.

## What it can do

| Tool                   | Scope            | What it returns                                            |
| ---------------------- | ---------------- | ---------------------------------------------------------- |
| `listWorkspaces`       | `monitors:read`  | the organization's workspaces                              |
| `listMonitors`         | `monitors:read`  | monitors with current status, filterable                   |
| `monitorStats`         | `monitors:read`  | uptime, response times, incidents and downtime over N days |
| `expiringCertificates` | `monitors:read`  | certificates expiring soon                                 |
| `listIncidents`        | `incidents:read` | incidents, newest first                                    |
| `getIncident`          | `incidents:read` | one incident with its latest checks and any analysis       |
| `listFindings`         | `security:read`  | security findings, ranked by risk                          |
| `getFinding`           | `security:read`  | one finding with evidence and remediation advice           |
| `listAssets`           | `security:read`  | the sites and domains being scanned                        |

A key only sees the tools its scopes allow. Results refer to records by short ids such as `m3` or `i2`, valid for the connection that received them.

## Safety

- **Read-only.** There is no tool that changes anything.
- **Scoped and tenant-bound.** Every query is limited in SQL to the key's organization and to the workspaces its owner may see.
- **Text from outside is data.** Monitor names, error messages and finding evidence are passed to the assistant marked as untrusted, so a hostile page cannot give it instructions through Upzy.
- **Revocable and expiring.** Revoke a key and it stops working immediately.
- Rate limited to 120 requests a minute per client address.

Treat a key like a password: keep it out of repositories and shared chats. If one leaks, revoke it.
