import { describe, expect, test } from "bun:test";

import { FindingDraftSchema, type FindingDraftInput } from "@upzy/validator";

import type { FindingDraft } from "../src";

// Both directions must compile: a field added to one side and not the other is a type error here.
const toContract = (f: FindingDraft): FindingDraftInput => f;
const fromContract = (f: FindingDraftInput): FindingDraft => f;

describe("FindingDraft matches the shared contract", () => {
  test("a finding a check produces satisfies the schema other scanners are built against", () => {
    const f: FindingDraft = {
      checkKey: "cve.vulnerable_component",
      severity: "high",
      title: "nginx 1.18.0 has 2 known vulnerabilities",
      description: "d",
      remediation: "r",
      subject: "nginx@1.18.0",
      evidence: { total: 2 },
      risk: { kev: true, epss: 0.4 },
    };
    expect(FindingDraftSchema.safeParse(toContract(f)).success).toBe(true);
    expect(fromContract(FindingDraftSchema.parse(f))).toEqual(f);
  });
});
