import { MockLanguageModelV4 } from "ai/test";

import { createGateway, type Gateway } from "../src";

/** Canned, well-behaved answers keyed by which feature's system prompt is in the request. Lets CI exercise the harness without a network. */
export function dryGateway(
  overrides: Partial<Record<"explain" | "draft" | "digest", object>> = {},
): Gateway {
  const explain = {
    summary: "Browsers can be pushed to plain HTTP.",
    impact: "Traffic could be intercepted on untrusted networks.",
    exploitability: "Needs a network position.",
    steps: [{ title: "Fix it", detail: "Apply the configuration shown." }],
    snippets: [
      {
        platform: "nginx",
        language: "nginx",
        code: 'add_header Strict-Transport-Security "max-age=31536000" always;',
      },
      { platform: "dns", language: "dns", code: 'example.com. TXT "v=spf1 -all"' },
    ],
    caveats: [],
    confidence: "medium",
  };
  const model = new MockLanguageModelV4({
    doGenerate: async (o) => {
      const prompt = JSON.stringify(o.prompt);
      let body: object;
      if (prompt.includes("remediation guidance")) body = overrides.explain ?? explain;
      else if (prompt.includes("ONE uptime monitor")) body = overrides.draft ?? cannedDraft(prompt);
      else
        body = overrides.digest ?? {
          headline: "Two outages this week",
          summary: "There were 2 incidents with 41 minutes of downtime. API uptime was 99.91%.",
          highlights: ["2 incidents resolved"],
          actions: ["Renew the certificate for example.com"],
        };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(body) }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
  return createGateway({
    config: { rpm: 100_000, defaultDailyTokenBudget: 1e9 },
    stores: {
      settings: {
        get: async () => ({
          enabled: true,
          dailyTokenBudget: 1e9,
          models: { fast: null, smart: null },
        }),
      },
      credentials: { get: async () => "dry", providers: async () => ["groq"] },
      usage: { tokensToday: async () => 0, record: async () => {} },
      cache: { get: async () => undefined, set: async () => {} },
    },
    modelFactory: () => model,
  });
}

const cannedDraft = (prompt: string) => {
  const p = prompt.toLowerCase();
  if (p.includes("certificate on example.com"))
    return {
      name: "Cert",
      type: "ssl",
      target: "example.com",
      intervalSeconds: 3600,
      failureThreshold: 1,
      unsupported: [],
      rationale: "r",
    };
  if (p.includes("postgres port"))
    return {
      name: "DB port",
      type: "tcp",
      target: "db.example.com:5432",
      intervalSeconds: 600,
      failureThreshold: 2,
      unsupported: [],
      rationale: "r",
    };
  if (p.includes("from europe"))
    return {
      name: "Site",
      type: "http",
      target: "https://example.com",
      intervalSeconds: 60,
      failureThreshold: 2,
      unsupported: ["check from Europe", "message Slack if slower than 2s"],
      rationale: "r",
    };
  if (p.includes("every 5 minutes"))
    return {
      name: "Health",
      type: "http",
      target: "https://example.com/health",
      intervalSeconds: 300,
      failureThreshold: 2,
      unsupported: [],
      rationale: "r",
    };
  return {
    name: "Site",
    type: "http",
    target: "https://example.com",
    intervalSeconds: 300,
    failureThreshold: 2,
    unsupported: [],
    rationale: "r",
  };
};
