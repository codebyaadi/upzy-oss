import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  AgentHelloSchema,
  AgentJobSchema,
  AgentPullSchema,
  AgentResultSchema,
  FindingDraftSchema,
  generateSchemas,
} from "../src";

const dir = join(import.meta.dir, "../../../schemas");

describe("generated JSON Schema contracts", () => {
  test("the files in schemas/ are what the Zod schemas generate (run `bun run schemas` if this fails)", () => {
    const wanted = generateSchemas();
    for (const [name, text] of Object.entries(wanted)) {
      expect(existsSync(join(dir, name))).toBe(true);
      expect(readFileSync(join(dir, name), "utf8").replace(/\r\n/g, "\n")).toBe(text);
    }
    expect(readdirSync(dir).sort()).toEqual(Object.keys(wanted).sort());
  });

  test("generation is deterministic", () => {
    expect(generateSchemas()).toEqual(generateSchemas());
  });

  test("each schema is valid JSON Schema 2020-12 that names its type and requires what Zod requires", () => {
    const wanted = generateSchemas();
    const required = (file: string) =>
      (JSON.parse(wanted[file]!) as { required?: string[] }).required ?? [];
    expect(required("agent-result.schema.json").sort()).toEqual(["responseMs", "status"]);
    expect(required("agent-job.schema.json").sort()).toEqual(
      ["config", "jobId", "monitorId", "target", "type"].sort(),
    );
    // A request field with a default is optional for the sender.
    expect(required("agent-pull.schema.json")).toEqual([]);
    expect(required("agent-hello.schema.json")).toEqual(["version"]);
    for (const [name, text] of Object.entries(wanted))
      if (name.endsWith(".json")) {
        const j = JSON.parse(text);
        expect(j.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
        expect(j.$id).toBe(name);
      }
  });
});

describe("the contracts accept and refuse what they should", () => {
  test("a result", () => {
    expect(AgentResultSchema.safeParse({ status: "up", responseMs: 90 }).success).toBe(true);
    expect(AgentResultSchema.safeParse({ status: "down", responseMs: null }).success).toBe(true);
    expect(AgentResultSchema.safeParse({ status: "unknown", responseMs: 1 }).success).toBe(false);
    expect(AgentResultSchema.safeParse({ status: "up" }).success).toBe(false);
  });

  test("hello and pull", () => {
    expect(AgentHelloSchema.parse({ version: "1.0.0" }).protocol).toBe(2);
    expect(AgentPullSchema.parse({}).max).toBe(10);
    expect(AgentPullSchema.safeParse({ max: 500 }).success).toBe(false);
  });

  test("a job", () => {
    const job = {
      jobId: crypto.randomUUID(),
      monitorId: crypto.randomUUID(),
      type: "http",
      target: "https://example.com",
      config: {},
    };
    expect(AgentJobSchema.safeParse(job).success).toBe(true);
    expect(AgentJobSchema.safeParse({ ...job, type: "synthetic" }).success).toBe(false);
  });

  test("a finding", () => {
    const f = {
      checkKey: "headers.hsts_missing",
      severity: "medium",
      title: "t",
      description: "d",
      remediation: "r",
    };
    expect(FindingDraftSchema.safeParse(f).success).toBe(true);
    expect(FindingDraftSchema.safeParse({ ...f, checkKey: "nodot" }).success).toBe(false);
    expect(FindingDraftSchema.safeParse({ ...f, risk: { epss: 2 } }).success).toBe(false);
  });
});
