/**
 * AI eval harness. Runs fixed scenarios (including prompt-injection and leakage attempts) through the real gateway
 * and checks the outputs.
 *
 *   bun eval/run.ts            live: needs GROQ_API_KEY (and optionally OPENROUTER_API_KEY); calls real models
 *   bun eval/run.ts --dry      runs the harness against canned good answers (used by CI to keep the harness honest)
 *
 * Live runs are for a nightly job, not for every commit: free tiers are rate limited and models drift.
 */
import {
  createGateway,
  draftMonitor,
  explainFinding,
  loadAiConfig,
  narrateDigest,
  parseModelSpec,
  type ModelSpec,
  type ProviderName,
  type AiStores,
  type Gateway,
} from "../src";
import { checkDigest, checkDraft, checkExplanation, type CheckResult } from "./checks";
import { DIGEST_STATS, DRAFT_CASES, EXPLAIN_CASES } from "./fixtures";

export interface EvalRow {
  suite: string;
  name: string;
  ok: boolean;
  failures: string[];
  warnings: string[];
  error?: string;
}

/**
 * The live eval plays the part of one organization that brought its own key: the key and models come from
 * AI_EVAL_API_KEY, AI_EVAL_PROVIDER (default groq) and optionally AI_EVAL_MODEL_SMART / AI_EVAL_MODEL_FAST.
 */
export interface EvalTarget {
  provider: ProviderName;
  apiKey: string;
  fast: ModelSpec | null;
  smart: ModelSpec | null;
}

export const evalTargetFromEnv = (
  env: Record<string, string | undefined> = process.env,
): EvalTarget | null => {
  const apiKey = env.AI_EVAL_API_KEY || env.GROQ_API_KEY;
  if (!apiKey) return null;
  return {
    provider: (env.AI_EVAL_PROVIDER ?? "groq") as ProviderName,
    apiKey,
    fast: env.AI_EVAL_MODEL_FAST ? parseModelSpec(env.AI_EVAL_MODEL_FAST) : null,
    smart: env.AI_EVAL_MODEL_SMART ? parseModelSpec(env.AI_EVAL_MODEL_SMART) : null,
  };
};

const evalStores = (t: EvalTarget): AiStores => {
  const cache = new Map<string, unknown>();
  return {
    settings: {
      get: async () => ({
        enabled: true,
        dailyTokenBudget: 10_000_000,
        models: { fast: t.fast, smart: t.smart },
      }),
    },
    credentials: {
      get: async (_o, provider) => (provider === t.provider ? t.apiKey : undefined),
      providers: async () => [t.provider],
    },
    usage: { tokensToday: async () => 0, record: async () => {} },
    cache: { get: async (k) => cache.get(k) as never, set: async (k, v) => void cache.set(k, v) },
  };
};

export function liveGateway(target: EvalTarget): Gateway {
  return createGateway({ config: loadAiConfig(), stores: evalStores(target) });
}

const row = (suite: string, name: string, r: CheckResult): EvalRow => ({
  suite,
  name,
  ok: r.failures.length === 0,
  failures: r.failures,
  warnings: r.warnings,
});
const errRow = (suite: string, name: string, e: unknown): EvalRow => ({
  suite,
  name,
  ok: false,
  failures: [],
  warnings: [],
  error: e instanceof Error ? e.message : String(e),
});

export async function runEval(gateway: Gateway, org = "eval-org"): Promise<EvalRow[]> {
  const rows: EvalRow[] = [];
  for (const c of EXPLAIN_CASES) {
    try {
      rows.push(
        row(
          "explain",
          c.name,
          checkExplanation(c, (await explainFinding(gateway, org, c.finding)).data),
        ),
      );
    } catch (e) {
      rows.push(errRow("explain", c.name, e));
    }
  }
  for (const c of DRAFT_CASES) {
    try {
      rows.push(
        row("draft", c.name, checkDraft(c, (await draftMonitor(gateway, org, c.text)).data)),
      );
    } catch (e) {
      rows.push(errRow("draft", c.name, e));
    }
  }
  try {
    rows.push(
      row(
        "digest",
        "weekly digest with hostile monitor name",
        checkDigest(DIGEST_STATS, (await narrateDigest(gateway, org, DIGEST_STATS)).data),
      ),
    );
  } catch (e) {
    rows.push(errRow("digest", "weekly digest with hostile monitor name", e));
  }
  return rows;
}

export function report(rows: EvalRow[]): string {
  const lines = rows.map(
    (r) =>
      `${r.ok ? "PASS" : "FAIL"}  ${r.suite.padEnd(8)} ${r.name}${r.error ? `\n      error: ${r.error}` : ""}${r.failures.map((f) => `\n      fail: ${f}`).join("")}${r.warnings.map((w) => `\n      warn: ${w}`).join("")}`,
  );
  const failed = rows.filter((r) => !r.ok).length;
  return `${lines.join("\n")}\n\n${rows.length - failed}/${rows.length} passed`;
}

if (import.meta.main) {
  const dry = process.argv.includes("--dry");
  if (dry) {
    const { dryGateway } = await import("./dry");
    const rows = await runEval(dryGateway());
    console.log(report(rows));
    process.exit(rows.every((r) => r.ok) ? 0 : 1);
  }
  const target = evalTargetFromEnv();
  if (!target) {
    console.log("No AI_EVAL_API_KEY (or GROQ_API_KEY) set: skipping the live eval.");
    process.exit(0);
  }
  const rows = await runEval(liveGateway(target));
  console.log(report(rows));
  // Provider errors (rate limits, outages) are not model-quality failures: only unsafe or wrong outputs fail the run.
  process.exit(rows.some((r) => !r.ok && !r.error) ? 1 : 0);
}
