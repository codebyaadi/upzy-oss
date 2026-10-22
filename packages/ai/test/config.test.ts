import { expect, test } from "bun:test";

import { loadAiConfig, parseModelSpec } from "../src/config";

test("parses specs, splitting only on the first colon", () => {
  expect(parseModelSpec("groq:llama-3.3-70b-versatile")).toEqual({
    provider: "groq",
    model: "llama-3.3-70b-versatile",
  });
  expect(parseModelSpec("openrouter:meta-llama/llama-3.3-70b-instruct:free")).toEqual({
    provider: "openrouter",
    model: "meta-llama/llama-3.3-70b-instruct:free",
  });
});

test("rejects malformed or unknown providers", () => {
  for (const bad of ["llama", "mistral:gpt", "groq:", ":model"])
    expect(() => parseModelSpec(bad)).toThrow(/Invalid model spec/);
});

test("the server only holds limits: no provider keys or models", () => {
  expect(loadAiConfig({})).toEqual({ rpm: 60, defaultDailyTokenBudget: 200_000 });
  expect(loadAiConfig({ AI_RPM_LIMIT: "10", GROQ_API_KEY: "ignored" })).toEqual({
    rpm: 10,
    defaultDailyTokenBudget: 200_000,
  });
});
