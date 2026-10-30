import { describe, expect, test } from "bun:test";

import { tool, type LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";

import { AiBudgetExceededError, AiDisabledError, AiUnavailableError } from "../src/errors";
import { askCopilot } from "../src/features/copilot";
import { createGateway } from "../src/gateway";
import { CONFIG, memoryStores } from "./helpers";

const usage = (i: number, o: number) => ({
  inputTokens: { total: i, noCache: i, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: o, text: o, reasoning: undefined },
});

/** A scripted model: each call returns the next scripted step (tool calls, or the final JSON answer). */
function scripted(steps: ({ tool: string; input: object } | { answer: object })[]) {
  let n = 0;
  const seen: string[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (o) => {
      seen.push(JSON.stringify(o.prompt));
      const step = steps[Math.min(n++, steps.length - 1)]!;
      if ("tool" in step)
        return {
          content: [
            {
              type: "tool-call" as const,
              toolCallId: `c${n}`,
              toolName: step.tool,
              input: JSON.stringify(step.input),
            },
          ],
          finishReason: { unified: "tool-calls" as const, raw: undefined },
          usage: usage(100, 20),
          warnings: [],
        };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(step.answer) }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: usage(150, 60),
        warnings: [],
      };
    },
  });
  return { model: model as LanguageModel, seen };
}

const tools = (calls: string[]) => ({
  listMonitors: tool({
    description: "List monitors",
    inputSchema: z.object({ status: z.string().optional() }),
    execute: async (input) => {
      calls.push(JSON.stringify(input));
      return '<untrusted_data>[{"id":"m1","name":"API"}]</untrusted_data>';
    },
  }),
});

const setup = (steps: Parameters<typeof scripted>[0], store = memoryStores()) => {
  const s = scripted(steps);
  const gateway = createGateway({
    config: CONFIG,
    stores: store.stores,
    modelFactory: () => s.model,
  });
  return { gateway, ...store, ...s };
};
const ask = (gateway: ReturnType<typeof setup>["gateway"], calls: string[] = []) =>
  askCopilot(gateway, "org1", {
    messages: [{ role: "user", content: "which monitors do I have?" }],
    tools: tools(calls),
  });

describe("copilot chat", () => {
  test("runs a tool, then answers; steps and total usage are reported and recorded once", async () => {
    const calls: string[] = [];
    const { gateway, events } = setup([
      { tool: "listMonitors", input: { status: "down" } },
      {
        answer: {
          answer: "You have one monitor: API.",
          citations: [{ type: "monitor", id: "m1" }],
        },
      },
    ]);
    const r = await ask(gateway, calls);
    expect(r.data).toEqual({
      answer: "You have one monitor: API.",
      citations: [{ type: "monitor", id: "m1" }],
    });
    expect(r.steps).toEqual([{ tool: "listMonitors", input: { status: "down" } }]);
    expect(calls).toEqual(['{"status":"down"}']);
    expect(r.usage).toEqual({ inputTokens: 250, outputTokens: 80 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      feature: "copilot",
      inputTokens: 250,
      outputTokens: 80,
      failed: false,
    });
  });

  test("an answer that looked nothing up is asked again, once, and the second try can use tools", async () => {
    const calls: string[] = [];
    const { gateway } = setup([
      { answer: { answer: "I'll look that up.", citations: [] } },
      { tool: "listMonitors", input: {} },
      {
        answer: {
          answer: "You have one monitor: API.",
          citations: [{ type: "monitor", id: "m1" }],
        },
      },
    ]);
    const r = await ask(gateway, calls);
    expect(r.data.answer).toBe("You have one monitor: API.");
    expect(calls).toHaveLength(1);
  });

  test("a model that never uses a tool is asked only twice", async () => {
    const { gateway, seen } = setup([{ answer: { answer: "I'll look that up.", citations: [] } }]);
    const r = await ask(gateway);
    expect(r.data.answer).toBe("I'll look that up.");
    expect(seen).toHaveLength(2);
  });

  test("tool results reach the model as tool output, after the user's question", async () => {
    const { gateway, seen } = setup([
      { tool: "listMonitors", input: {} },
      { answer: { answer: "ok", citations: [] } },
    ]);
    await ask(gateway);
    expect(seen[1]).toContain("untrusted_data");
    expect(seen[0]).toContain("which monitors do I have?");
  });

  test("a model that never stops calling tools is cut off and reported as unavailable", async () => {
    const calls: string[] = [];
    const { gateway, events } = setup([{ tool: "listMonitors", input: {} }]);
    await expect(ask(gateway, calls)).rejects.toBeInstanceOf(AiUnavailableError);
    expect(calls.length).toBeLessThanOrEqual(6);
    expect(events.at(-1)?.failed).toBe(true);
  });

  test("secrets in the answer are scrubbed", async () => {
    const { gateway } = setup([
      {
        answer: {
          answer: "The key is AKIAIOSFODNN7EXAMPLE and Bearer abcdefghijklmnop",
          citations: [],
        },
      },
    ]);
    const r = await ask(gateway);
    expect(r.data.answer).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(r.data.answer).not.toContain("abcdefghijklmnop");
  });

  test("off, or over budget, nothing is called", async () => {
    const calls: string[] = [];
    const off = setup(
      [{ answer: { answer: "x", citations: [] } }],
      memoryStores({ enabled: false }),
    );
    await expect(ask(off.gateway, calls)).rejects.toBeInstanceOf(AiDisabledError);
    const over = setup(
      [{ answer: { answer: "x", citations: [] } }],
      memoryStores({ dailyTokenBudget: 10 }, 10),
    );
    await expect(ask(over.gateway, calls)).rejects.toBeInstanceOf(AiBudgetExceededError);
    expect(calls).toEqual([]);
    expect(off.seen).toHaveLength(0);
  });
});
