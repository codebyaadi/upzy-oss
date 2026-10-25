# Upzy contracts

JSON Schema (draft 2020-12) for what the API, probe agents and scanners exchange. **Generated** from
`packages/validator` by `bun run schemas`; do not edit by hand. CI fails when these files are out of date.

Agent protocol version: **1**. A change an older agent cannot read bumps it.

| File | Direction | What it is |
| ---- | --------- | ---------- |
| `agent-hello.schema.json` | agent to server | `POST /agent/hello`: who the agent is |
| `agent-pull.schema.json` | agent to server | `POST /agent/jobs/pull`: how many checks it can take |
| `agent-job.schema.json` | server to agent | one check to run (each item of `jobs` in the pull reply) |
| `agent-result.schema.json` | agent to server | `POST /agent/jobs/{jobId}/result`: what it measured |
| `finding.schema.json` | scanner to server | one security finding |
