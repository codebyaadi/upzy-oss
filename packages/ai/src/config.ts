export type ModelRole = "fast" | "smart";
export type ProviderName = "groq" | "openrouter" | "openai" | "anthropic" | "google";
export const PROVIDER_NAMES: ProviderName[] = [
  "groq",
  "openrouter",
  "openai",
  "anthropic",
  "google",
];

export interface ModelSpec {
  provider: ProviderName;
  model: string;
}

/**
 * Upzy holds no AI provider keys. Every call uses the organization's own key (see stores.credentials), so
 * the only server-side settings are limits.
 */
export interface AiConfig {
  /** Requests per minute across this process, so one busy organization can't hammer a provider. */
  rpm: number;
  /** Daily token budget given to organizations that have not set their own. */
  defaultDailyTokenBudget: number;
}

/** "groq:llama-3.3-70b-versatile" or "openrouter:meta-llama/llama-3.3-70b-instruct:free". Only the first colon splits. */
export function parseModelSpec(raw: string): ModelSpec {
  const i = raw.indexOf(":");
  const provider = raw.slice(0, i);
  const model = raw.slice(i + 1).trim();
  if (i < 0 || !(PROVIDER_NAMES as string[]).includes(provider) || !model) {
    throw new Error(
      `Invalid model spec "${raw}". Expected "<provider>:<model>" with provider one of ${PROVIDER_NAMES.join(", ")}.`,
    );
  }
  return { provider: provider as ProviderName, model };
}

export function loadAiConfig(env: Record<string, string | undefined> = process.env): AiConfig {
  return {
    rpm: Number(env.AI_RPM_LIMIT ?? 60),
    defaultDailyTokenBudget: Number(env.AI_ORG_DAILY_TOKEN_BUDGET ?? 200_000),
  };
}
