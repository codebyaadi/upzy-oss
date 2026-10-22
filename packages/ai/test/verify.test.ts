import { describe, expect, test } from "bun:test";

import { verifyWith } from "../src/verify";

const reply = (status: number, body: unknown = {}) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const seen = () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string> });
    return new Response(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
};

describe("key verification", () => {
  test("lists the models a key can use, with each provider's own auth header", async () => {
    const o = seen();
    expect(await verifyWith(o.f, "openai", "sk-1")).toEqual({ ok: true, models: ["m1", "m2"] });
    expect(o.calls[0]!.headers.authorization).toBe("Bearer sk-1");
    const a = seen();
    await verifyWith(a.f, "anthropic", "sk-ant-1");
    expect(a.calls[0]!.headers["x-api-key"]).toBe("sk-ant-1");
    expect(a.calls[0]!.headers["anthropic-version"]).toBeDefined();
    const g = seen();
    await verifyWith(g.f, "google", "AIzaX");
    expect(g.calls[0]!.headers["x-goog-api-key"]).toBe("AIzaX");
  });

  test("Google's list is reduced to models that can generate text, without the models/ prefix", async () => {
    const f = reply(200, {
      models: [
        { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
        { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] },
      ],
    });
    expect(await verifyWith(f, "google", "AIzaX")).toEqual({
      ok: true,
      models: ["gemini-2.5-flash"],
    });
  });

  test("a refused key is 'rejected', not a model problem; Google keys of another kind get a pointer", async () => {
    for (const status of [400, 401, 403, 404]) {
      const r = await verifyWith(reply(status), "openai", "sk-bad");
      expect(r).toMatchObject({ ok: false, reason: "rejected" });
    }
    const r = await verifyWith(reply(403), "google", "AQ.Ab8RNexample");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain("aistudio.google.com/apikey");
    const plain = await verifyWith(reply(403), "google", "AIzaBadKey");
    expect(!plain.ok && plain.message).not.toContain("aistudio");
  });

  test("rate limits, outages and network failures are 'unreachable', so a good key isn't blamed", async () => {
    for (const status of [429, 402, 500, 503])
      expect(await verifyWith(reply(status), "groq", "k")).toMatchObject({
        ok: false,
        reason: "unreachable",
      });
    const boom = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await verifyWith(boom, "groq", "k")).toMatchObject({ ok: false, reason: "unreachable" });
  });

  test("OpenRouter is checked against its key endpoint and reports no model list", async () => {
    const o = seen();
    expect(await verifyWith(o.f, "openrouter", "sk-or-1")).toEqual({ ok: true, models: [] });
    expect(o.calls[0]!.url).toContain("/api/v1/key");
  });
});
