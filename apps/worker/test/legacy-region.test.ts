import { describe, expect, test } from "bun:test";

import { LEGACY_REGION_REMOVAL, legacyRegionalProber } from "../src/legacy-region";

describe("regional probers that read the database", () => {
  test("the main server's own prober is unaffected", () => {
    expect(legacyRegionalProber({})).toEqual({ run: true });
    expect(legacyRegionalProber({ WORKER_REGION: "primary" })).toEqual({ run: true });
    expect(legacyRegionalProber({ WORKER_REGION: "main" })).toEqual({ run: true });
  });

  test("a worker in another region does not start, and says what to do instead", () => {
    const d = legacyRegionalProber({ WORKER_REGION: "eu-west" });
    expect(d.run).toBe(false);
    expect(d.message).toContain("probe agent");
    expect(d.message).toContain("ALLOW_DB_REGIONAL_PROBER=true");
    expect(d.message).toContain(LEGACY_REGION_REMOVAL);
  });

  test("it can be kept on, loudly, until the removal date", () => {
    for (const v of ["true", "TRUE", " true "]) {
      const d = legacyRegionalProber({ WORKER_REGION: "eu-west", ALLOW_DB_REGIONAL_PROBER: v });
      expect(d.run).toBe(true);
      expect(d.message).toContain("DEPRECATED");
      expect(d.message).toContain(LEGACY_REGION_REMOVAL);
    }
    expect(
      legacyRegionalProber({ WORKER_REGION: "eu-west", ALLOW_DB_REGIONAL_PROBER: "yes" }).run,
    ).toBe(false);
  });
});
