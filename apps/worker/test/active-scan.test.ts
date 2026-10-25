import { describe, expect, test } from "bun:test";

import { ACTIVE_CHECKS, ALL_CHECKS, PASSIVE_CHECKS } from "@upzy/security";

import { activeEngine, checksFor } from "../src/roles/active-scan";

describe("activeEngine", () => {
  test("defaults to the built-in checks", () => {
    expect(activeEngine({})).toBe("builtin");
    expect(activeEngine({ ACTIVE_SCAN_ENGINE: " " })).toBe("builtin");
  });
  test("accepts nuclei in any case", () => {
    expect(activeEngine({ ACTIVE_SCAN_ENGINE: "Nuclei" })).toBe("nuclei");
  });
  test("refuses anything else", () => {
    expect(() => activeEngine({ ACTIVE_SCAN_ENGINE: "zap" })).toThrow();
  });
});

describe("checksFor", () => {
  test("an unverified asset only ever gets passive checks, whatever the engine", () => {
    expect(checksFor(false, "builtin")).toBe(PASSIVE_CHECKS);
    expect(checksFor(false, "nuclei")).toBe(PASSIVE_CHECKS);
  });
  test("a verified asset gets every check with the built-in engine", () => {
    expect(checksFor(true, "builtin")).toBe(ALL_CHECKS);
  });
  test("with nuclei, only the port checks stay in the worker", () => {
    const active = checksFor(true, "nuclei").filter((c) => ACTIVE_CHECKS.includes(c));
    expect(active.length).toBeGreaterThan(0);
    expect(active.every((c) => c.family === "ports")).toBe(true);
  });
});
