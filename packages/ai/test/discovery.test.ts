import { describe, expect, test } from "bun:test";

import { z } from "zod";

import { chooseLiveModel, createModelDiscovery } from "../src/discovery";
import { createGateway } from "../src/gateway";
import { CONFIG, factoryFor, memoryStores, mockModel } from "./helpers";

describe("choosing a model from what a key can use", () => {
  test("Gemini: the newest flash-lite for quick tasks, the newest flash for the main model", () => {
    const ids = [
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-3.8-flash",
      "gemini-3.8-flash-lite",
      "gemini-3.8-pro",
      "gemini-3.8-flash-preview-05-20",
      "gemini-3.8-flash-latest",
    ];
    expect(chooseLiveModel("google", "fast", ids)).toEqual({
      provider: "google",
      model: "gemini-3.8-flash-lite",
    });
    expect(chooseLiveModel("google", "smart", ids)).toEqual({
      provider: "google",
      model: "gemini-3.8-flash",
    });
  });

  test("a retired generation isn't chosen when it is the only one left to match nothing sensible", () => {
    expect(chooseLiveModel("google", "smart", ["gemini-3.8-pro"])).toEqual({
      provider: "google",
      model: "gemini-3.8-pro",
    });
    expect(chooseLiveModel("google", "fast", ["embedding-001"])).toBeNull();
    expect(chooseLiveModel("google", "fast", [])).toBeNull();
  });

  test("versions compare as numbers, not text (3.10 is newer than 3.9)", () => {
    expect(
      chooseLiveModel("google", "smart", ["gemini-3.9-flash", "gemini-3.10-flash"])?.model,
    ).toBe("gemini-3.10-flash");
  });

  test("OpenAI and Anthropic families", () => {
    expect(
      chooseLiveModel("openai", "fast", ["gpt-4.1-nano", "gpt-5-nano", "gpt-5-mini", "gpt-5"])
        ?.model,
    ).toBe("gpt-5-nano");
    expect(chooseLiveModel("openai", "smart", ["gpt-4.1-nano", "gpt-5-mini", "gpt-5"])?.model).toBe(
      "gpt-5-mini",
    );
    const claude = [
      "claude-sonnet-4-5-20250929",
      "claude-sonnet-4-5",
      "claude-haiku-4-5",
      "claude-opus-4-1",
      "claude-sonnet-4",
    ];
    expect(chooseLiveModel("anthropic", "smart", claude)?.model).toBe("claude-sonnet-4-5"); // alias over the dated copy
    expect(chooseLiveModel("anthropic", "fast", claude)?.model).toBe("claude-haiku-4-5");
  });

  test("Groq: the catalog's model if the key has it, otherwise nothing", () => {
    expect(chooseLiveModel("groq", "smart", ["llama-3.3-70b-versatile"])?.model).toBe(
      "llama-3.3-70b-versatile",
    );
    expect(chooseLiveModel("groq", "smart", ["something-else"])).toBeNull();
  });
});

describe("model discovery", () => {
  test("asks the provider once, then remembers; a failure is remembered briefly and gives []", async () => {
    let calls = 0;
    const d = createModelDiscovery(async () => (++calls, ["a"]));
    expect(await d.models("o", "google", "k")).toEqual(["a"]);
    expect(await d.models("o", "google", "k")).toEqual(["a"]);
    expect(calls).toBe(1);
    const bad = createModelDiscovery(async () => {
      throw new Error("down");
    });
    expect(await bad.models("o", "google", "k")).toEqual([]);
  });
});

describe("Automatic follows the live list; picks are respected", () => {
  const Out = z.object({ ok: z.boolean() });
  const req = {
    feature: "t",
    role: "smart" as const,
    organizationId: "o1",
    schema: Out,
    system: "s",
    instructions: "i",
    cache: false as const,
  };
  const good = JSON.stringify({ ok: true });

  test("with nothing picked, a retired catalog default is replaced by the newest model the key has", async () => {
    const live = mockModel({ text: good });
    const old = mockModel({ text: good });
    const store = memoryStores({ models: { fast: null, smart: null } }, 0, { google: "AIza-k" });
    const gateway = createGateway({
      config: CONFIG,
      stores: store.stores,
      modelFactory: factoryFor({
        "google:gemini-3.8-flash": live.model,
        "google:gemini-2.5-flash": old.model,
      }),
      discovery: createModelDiscovery(async () => ["gemini-3.8-flash", "gemini-3.8-flash-lite"]),
    });
    const r = await gateway.generateStructured(req);
    expect(r.model).toBe("gemini-3.8-flash");
    expect(old.calls).toHaveLength(0);
  });

  test("an explicit pick is used as it is, without asking the provider", async () => {
    let asked = 0;
    const picked = mockModel({ text: good });
    const store = memoryStores(
      { models: { fast: null, smart: { provider: "google", model: "my-model" } } },
      0,
      { google: "AIza-k" },
    );
    const gateway = createGateway({
      config: CONFIG,
      stores: store.stores,
      modelFactory: factoryFor({ "google:my-model": picked.model }),
      discovery: createModelDiscovery(async () => (++asked, ["gemini-3.8-flash"])),
    });
    expect((await gateway.generateStructured(req)).model).toBe("my-model");
    expect(asked).toBe(0);
  });

  test("if the provider can't be asked, the catalog default is used", async () => {
    const m = mockModel({ text: good });
    const store = memoryStores({ models: { fast: null, smart: null } }, 0, { google: "AIza-k" });
    const gateway = createGateway({
      config: CONFIG,
      stores: store.stores,
      modelFactory: factoryFor({ "google:gemini-2.5-flash": m.model }),
      discovery: createModelDiscovery(async () => {
        throw new Error("offline");
      }),
    });
    expect((await gateway.generateStructured(req)).model).toBe("gemini-2.5-flash");
  });
});
