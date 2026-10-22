import { APICallError, type LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";

import type { AiConfig, ModelSpec } from "../src/config";
import type { AiSettings, AiStores, UsageEvent } from "../src/stores";

export const CONFIG: AiConfig = { rpm: 1000, defaultDailyTokenBudget: 1000 };

const usage = (input = 10, output = 20) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});

/** A model that replies with `text` (a string or a per-call function), or throws what `fail` returns. */
export function mockModel(opts: {
  text?: string | ((n: number) => string);
  fail?: (n: number) => Error | null;
  tokens?: [number, number];
}) {
  const calls: { system: string; user: string }[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      const n = calls.length;
      const parts = options.prompt as { role: string; content: unknown }[];
      const text = (role: string) =>
        parts
          .filter((p) => p.role === role)
          .map((p) =>
            typeof p.content === "string"
              ? p.content
              : (p.content as { text?: string }[]).map((c) => c.text ?? "").join(""),
          )
          .join("\n");
      calls.push({ system: text("system"), user: text("user") });
      const err = opts.fail?.(n);
      if (err) throw err;
      const out = typeof opts.text === "function" ? opts.text(n) : (opts.text ?? "{}");
      return {
        content: [{ type: "text" as const, text: out }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: usage(...(opts.tokens ?? [10, 20])),
        warnings: [],
      };
    },
  });
  return { model: model as LanguageModel, calls };
}

export function memoryStores(
  settings: Partial<AiSettings> = {},
  used = 0,
  initialKeys: Record<string, string> = { groq: "gsk_test" },
) {
  const events: UsageEvent[] = [];
  const cache = new Map<string, unknown>();
  let tokens = used;
  const state: AiSettings = {
    enabled: true,
    dailyTokenBudget: 1000,
    models: {
      fast: { provider: "groq", model: "fast-model" },
      smart: { provider: "groq", model: "smart-model" },
    },
    ...settings,
  };
  const keys = new Map(Object.entries(initialKeys));
  const stores: AiStores = {
    settings: { get: async () => state },
    credentials: {
      get: async (_o, provider) => keys.get(provider),
      providers: async () => [...keys.keys()],
    },
    usage: {
      tokensToday: async () => tokens,
      record: async (e) => {
        events.push(e);
        tokens += e.inputTokens + e.outputTokens;
      },
    },
    cache: { get: async (k) => cache.get(k) as never, set: async (k, v) => void cache.set(k, v) },
  };
  return { stores, events, cache, state, keys };
}

export const http = (status: number, message = "error") =>
  new APICallError({
    message,
    url: "https://provider.test/v1/chat",
    requestBodyValues: {},
    statusCode: status,
    isRetryable: status === 429 || status >= 500,
  });

/** Build a ModelFactory from per-spec mock models. */
export const factoryFor =
  (byModel: Record<string, LanguageModel>) => (spec: ModelSpec, _key?: string) =>
    byModel[`${spec.provider}:${spec.model}`] ?? null;
