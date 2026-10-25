import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { AgentSealedSchema } from "@upzy/validator";

import { newAgentKeyPair, openSealed, sealSecrets } from "../src/lib/agent-seal";

const JOB = "0d6c2b8e-6a53-4a45-9c1e-3a8f0b8d2f10";
const secrets = { API_TOKEN: "s3cret-value", PASSWORD: "p@ss w0rd ✓" };

describe("secrets sealed to an agent", () => {
  test("only the agent that holds the private key can open them", () => {
    const agent = newAgentKeyPair();
    const sealed = sealSecrets(secrets, agent.publicKey, JOB);
    expect(AgentSealedSchema.safeParse(sealed).success).toBe(true);
    expect(JSON.stringify(sealed)).not.toContain("s3cret-value");
    expect(openSealed(sealed, agent.privateKey, JOB)).toEqual(secrets);
    expect(() => openSealed(sealed, newAgentKeyPair().privateKey, JOB)).toThrow();
  });

  test("a sealed box cannot be replayed under another job, or altered", () => {
    const agent = newAgentKeyPair();
    const sealed = sealSecrets(secrets, agent.publicKey, JOB);
    expect(() =>
      openSealed(sealed, agent.privateKey, "11111111-1111-4111-8111-111111111111"),
    ).toThrow();
    const ct = Buffer.from(sealed.ciphertext, "base64");
    ct[0]! ^= 1;
    expect(() =>
      openSealed({ ...sealed, ciphertext: ct.toString("base64") }, agent.privateKey, JOB),
    ).toThrow();
  });

  test("each seal is different, even for the same secrets and agent", () => {
    const agent = newAgentKeyPair();
    const a = sealSecrets(secrets, agent.publicKey, JOB);
    const b = sealSecrets(secrets, agent.publicKey, JOB);
    expect(a.epk).not.toBe(b.epk);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  test("a key of the wrong size is refused", () => {
    expect(() => sealSecrets(secrets, Buffer.alloc(16).toString("base64"), JOB)).toThrow();
  });

  // The Go agent opens this same file in agent/seal_test.go. If the scheme changes, regenerate it with
  //   UPDATE_FIXTURE=1 bun test apps/api/test/agent-seal.test.ts
  // and both languages are checked against the new box.
  test("the fixture the Go agent also opens still opens here", () => {
    const path = join(import.meta.dir, "../../../agent/testdata/sealed.json");
    if (process.env.UPDATE_FIXTURE === "1" || !existsSync(path)) {
      const agent = newAgentKeyPair();
      writeFileSync(
        path,
        JSON.stringify(
          { ...agent, jobId: JOB, secrets, sealed: sealSecrets(secrets, agent.publicKey, JOB) },
          null,
          2,
        ) + "\n",
      );
    }
    const f = JSON.parse(readFileSync(path, "utf8"));
    expect(openSealed(f.sealed, f.privateKey, f.jobId)).toEqual(f.secrets);
  });
});
