import z from "zod";

import {
  AGENT_PROTOCOL,
  AgentHelloSchema,
  AgentJobSchema,
  AgentPullSchema,
  AgentResultSchema,
} from "./agent";
import { FindingDraftSchema } from "./finding";

/**
 * The contracts other programs (the Go agent, the Go scanner) are built against, as JSON Schema files in `schemas/`.
 * They are generated from the Zod schemas, never edited by hand: `bun run schemas` rewrites them and
 * `bun run schemas:check` (run in CI) fails when they are out of date.
 *
 * Messages an agent sends are described as the server accepts them (`input`: fields with defaults are optional);
 * messages the server sends are described as it produces them (`output`).
 */
const CONTRACTS = [
  { file: "agent-hello", title: "AgentHello", schema: AgentHelloSchema, io: "input" },
  { file: "agent-pull", title: "AgentPull", schema: AgentPullSchema, io: "input" },
  { file: "agent-job", title: "AgentJob", schema: AgentJobSchema, io: "output" },
  { file: "agent-result", title: "AgentResult", schema: AgentResultSchema, io: "input" },
  { file: "finding", title: "FindingDraft", schema: FindingDraftSchema, io: "input" },
] as const;

/** File name (relative to `schemas/`) to file contents, for every contract. Stable: the same code gives the same text. */
export function generateSchemas(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of CONTRACTS) {
    const json = z.toJSONSchema(c.schema, { io: c.io, target: "draft-2020-12" });
    out[`${c.file}.schema.json`] =
      JSON.stringify({ $id: `${c.file}.schema.json`, title: c.title, ...json }, null, 2) + "\n";
  }
  out["README.md"] = [
    "# Upzy contracts",
    "",
    "JSON Schema (draft 2020-12) for what the API, probe agents and scanners exchange. **Generated** from",
    "`packages/validator` by `bun run schemas`; do not edit by hand. CI fails when these files are out of date.",
    "",
    `Agent protocol version: **${AGENT_PROTOCOL}**. A change an older agent cannot read bumps it.`,
    "",
    "| File | Direction | What it is |",
    "| ---- | --------- | ---------- |",
    "| `agent-hello.schema.json` | agent to server | `POST /agent/hello`: who the agent is |",
    "| `agent-pull.schema.json` | agent to server | `POST /agent/jobs/pull`: how many checks it can take |",
    "| `agent-job.schema.json` | server to agent | one check to run (each item of `jobs` in the pull reply) |",
    "| `agent-result.schema.json` | agent to server | `POST /agent/jobs/{jobId}/result`: what it measured |",
    "| `finding.schema.json` | scanner to server | one security finding |",
    "",
  ].join("\n");
  return out;
}
