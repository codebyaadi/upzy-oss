# Upzy contracts

JSON Schema (draft 2020-12) for what the API, probe agents and scanners exchange. **Generated** from
`packages/validator` by `bun run schemas`; do not edit by hand. CI fails when these files are out of date.

Agent protocol version: **2**, scanner protocol version: **1**. A change an older program cannot read bumps it.

| File | Direction | What it is |
| ---- | --------- | ---------- |
| `agent-hello.schema.json` | agent to server | `POST /agent/hello`: who the agent is |
| `agent-pull.schema.json` | agent to server | `POST /agent/jobs/pull`: how many checks it can take |
| `agent-job.schema.json` | server to agent | one check to run (each item of `jobs` in the pull reply) |
| `agent-result.schema.json` | agent to server | `POST /agent/jobs/{jobId}/result`: what it measured |
| `finding.schema.json` | scanner to server | one security finding |
| `scanner-hello.schema.json` | scanner to server | `POST /scanner/hello`: who the scanner is and what it runs |
| `scanner-pull.schema.json` | scanner to server | `POST /scanner/jobs/pull`: how many scans it can take |
| `scanner-job.schema.json` | server to scanner | one verified asset to scan, with its rate limit and time limit |
| `scanner-result.schema.json` | scanner to server | `POST /scanner/jobs/{jobId}/result`: findings and the provenance of the scan |
