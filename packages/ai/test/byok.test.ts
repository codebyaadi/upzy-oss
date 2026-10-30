import { describe, expect, test } from "bun:test";

import { costMicros, findModel, MODEL_CATALOG, PROVIDERS } from "../src/catalog";
import { parseModelSpec } from "../src/config";

describe("price catalog", () => {
  test("every provider offered has at least one model and a key link", () => {
    for (const p of PROVIDERS) {
      expect(p.keysUrl.startsWith("https://")).toBe(true);
      expect(MODEL_CATALOG.some((m) => m.provider === p.id)).toBe(true);
    }
  });

  test("computes cost in micro-dollars from per-million prices", () => {
    // 70B: $0.59 in / $0.79 out per million. 1M in + 1M out = $1.38 = 1,380,000 micros.
    const spec = { provider: "groq", model: "llama-3.3-70b-versatile" } as const;
    expect(costMicros(spec, 1_000_000, 1_000_000)).toBe(1_380_000);
    expect(costMicros(spec, 1000, 500)).toBe(Math.round(0.59 * 1000 + 0.79 * 500));
  });

  test("free OpenRouter models cost nothing and unknown models have no price", () => {
    expect(costMicros({ provider: "openrouter", model: "anything:free" }, 5000, 5000)).toBe(0);
    expect(costMicros({ provider: "openai", model: "brand-new-model" }, 5000, 5000)).toBeNull();
    expect(findModel({ provider: "openai", model: "brand-new-model" })).toBeUndefined();
  });

  test("the free-models router is selectable, costs nothing, and is never picked for Automatic", async () => {
    const { tierModel } = await import("../src/providers");
    const free = { provider: "openrouter", model: "openrouter/free" } as const;
    expect(findModel(free)?.free).toBe(true);
    expect(costMicros(free, 5000, 5000)).toBe(0);
    expect(tierModel("openrouter", "smart")?.model).not.toBe("openrouter/free");
    expect(tierModel("openrouter", "fast")?.model).not.toBe("openrouter/free");
  });

  test("model resolution: picked wins, otherwise follow the other role or the keyed provider", async () => {
    const { resolveModel } = await import("../src/providers");
    const none = { fast: null, smart: null };
    expect(resolveModel(none, "smart", [])).toBeNull();
    expect(resolveModel(none, "smart", ["anthropic"])).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    });
    expect(resolveModel(none, "fast", ["anthropic"])).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
    const picked = { provider: "openai", model: "gpt-4.1" } as const;
    expect(resolveModel({ fast: null, smart: picked }, "fast", ["groq"])).toEqual({
      provider: "openai",
      model: "gpt-4.1-nano",
    });
    expect(resolveModel({ fast: null, smart: picked }, "smart", [])).toEqual(picked);
    // A provider that only has models in one tier (OpenRouter) serves both roles from it.
    expect(resolveModel(none, "fast", ["openrouter"])).toEqual({
      provider: "openrouter",
      model: "meta-llama/llama-3.3-70b-instruct",
    });
    expect(resolveModel(none, "smart", ["openrouter"])).toEqual({
      provider: "openrouter",
      model: "meta-llama/llama-3.3-70b-instruct",
    });
    // A provider with no model of that tier in the catalog falls back to the model that was picked.
    const custom = { provider: "openai", model: "my-ft" } as const;
    expect(resolveModel({ fast: null, smart: custom }, "fast", [])).toEqual({
      provider: "openai",
      model: "gpt-4.1-nano",
    });
  });

  test("parses specs for the new providers", () => {
    expect(parseModelSpec("anthropic:claude-haiku-4-5")).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
    expect(() => parseModelSpec("mistral:x")).toThrow();
  });
});

describe("incident triage output checks", () => {
  const base = {
    summary: "s",
    likelyCause: "dns" as const,
    confidence: "high" as const,
    evidence: [],
    suggestedActions: [{ title: "t", detail: "d" }],
    unknowns: [],
  };
  const facts = [
    { id: "E1", kind: "a", text: "x" },
    { id: "E2", kind: "b", text: "y" },
  ];

  test("citations to facts that don't exist are removed and confidence cannot stay high", async () => {
    const { sanitizeTriage } = await import("../src/features/triage-incident");
    const out = sanitizeTriage({ ...base, evidence: [{ ref: "E7", note: "made up" }] }, facts);
    expect(out.evidence).toEqual([]);
    expect(out.confidence).toBe("low");
    expect(out.unknowns.join(" ")).toContain("removed");
  });

  test("one supporting fact caps high at medium; two keep it", async () => {
    const { sanitizeTriage } = await import("../src/features/triage-incident");
    const one = sanitizeTriage({ ...base, evidence: [{ ref: "E1", note: "n" }] }, facts);
    expect(one.confidence).toBe("medium");
    const two = sanitizeTriage(
      {
        ...base,
        evidence: [
          { ref: "E1", note: "n" },
          { ref: "E2", note: "m" },
        ],
      },
      facts,
    );
    expect(two.confidence).toBe("high");
    expect(two.unknowns).toEqual([]);
  });
});
