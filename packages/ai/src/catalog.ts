import type { ModelSpec, ProviderName } from "./config";

export interface ProviderInfo {
  id: ProviderName;
  label: string;
  /** Where a person creates a key. */
  keysUrl: string;
  /** Prefix a real key starts with, used only to catch obvious paste mistakes. */
  keyPrefix?: string;
}

export const PROVIDERS: ProviderInfo[] = [
  { id: "groq", label: "Groq", keysUrl: "https://console.groq.com/keys", keyPrefix: "gsk_" },
  {
    id: "openai",
    label: "OpenAI",
    keysUrl: "https://platform.openai.com/api-keys",
    keyPrefix: "sk-",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    keysUrl: "https://console.anthropic.com/settings/keys",
    keyPrefix: "sk-ant-",
  },
  { id: "google", label: "Google Gemini", keysUrl: "https://aistudio.google.com/apikey" },
  {
    id: "openrouter",
    label: "OpenRouter",
    keysUrl: "https://openrouter.ai/keys",
    keyPrefix: "sk-or-",
  },
];

export interface CatalogModel {
  provider: ProviderName;
  id: string;
  label: string;
  /** US dollars per million tokens. */
  inputPerM: number;
  outputPerM: number;
  /** Which tasks it is a sensible default for. */
  tier: "fast" | "smart";
}

/**
 * Prices are list prices we last checked, shown as estimates: the provider's own billing is the
 * source of truth. A model missing from here still works (people can type any model id) but its
 * cost is reported as unknown rather than guessed.
 */
export const PRICES_AS_OF = "2026-10";

export const MODEL_CATALOG: CatalogModel[] = [
  {
    provider: "groq",
    id: "llama-3.1-8b-instant",
    label: "Llama 3.1 8B Instant",
    inputPerM: 0.05,
    outputPerM: 0.08,
    tier: "fast",
  },
  {
    provider: "groq",
    id: "llama-3.3-70b-versatile",
    label: "Llama 3.3 70B Versatile",
    inputPerM: 0.59,
    outputPerM: 0.79,
    tier: "smart",
  },
  {
    provider: "groq",
    id: "openai/gpt-oss-20b",
    label: "GPT-OSS 20B",
    inputPerM: 0.075,
    outputPerM: 0.3,
    tier: "fast",
  },
  {
    provider: "groq",
    id: "openai/gpt-oss-120b",
    label: "GPT-OSS 120B",
    inputPerM: 0.15,
    outputPerM: 0.6,
    tier: "smart",
  },
  {
    provider: "openai",
    id: "gpt-4.1-nano",
    label: "GPT-4.1 nano",
    inputPerM: 0.1,
    outputPerM: 0.4,
    tier: "fast",
  },
  {
    provider: "openai",
    id: "gpt-4o-mini",
    label: "GPT-4o mini",
    inputPerM: 0.15,
    outputPerM: 0.6,
    tier: "fast",
  },
  {
    provider: "openai",
    id: "gpt-4.1-mini",
    label: "GPT-4.1 mini",
    inputPerM: 0.4,
    outputPerM: 1.6,
    tier: "smart",
  },
  {
    provider: "openai",
    id: "gpt-4.1",
    label: "GPT-4.1",
    inputPerM: 2,
    outputPerM: 8,
    tier: "smart",
  },
  {
    provider: "anthropic",
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    inputPerM: 1,
    outputPerM: 5,
    tier: "fast",
  },
  {
    provider: "anthropic",
    id: "claude-sonnet-4-5",
    label: "Claude Sonnet 4.5",
    inputPerM: 3,
    outputPerM: 15,
    tier: "smart",
  },
  {
    provider: "google",
    id: "gemini-2.5-flash-lite",
    label: "Gemini 2.5 Flash-Lite",
    inputPerM: 0.1,
    outputPerM: 0.4,
    tier: "fast",
  },
  {
    provider: "google",
    id: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    inputPerM: 0.3,
    outputPerM: 2.5,
    tier: "smart",
  },
  {
    provider: "google",
    id: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    inputPerM: 1.25,
    outputPerM: 10,
    tier: "smart",
  },
  {
    provider: "openrouter",
    id: "meta-llama/llama-3.3-70b-instruct:free",
    label: "Llama 3.3 70B (free)",
    inputPerM: 0,
    outputPerM: 0,
    tier: "smart",
  },
  {
    provider: "openrouter",
    id: "openai/gpt-4.1-mini",
    label: "GPT-4.1 mini via OpenRouter",
    inputPerM: 0.4,
    outputPerM: 1.6,
    tier: "smart",
  },
  {
    provider: "openrouter",
    id: "anthropic/claude-sonnet-4.5",
    label: "Claude Sonnet 4.5 via OpenRouter",
    inputPerM: 3,
    outputPerM: 15,
    tier: "smart",
  },
];

export const isProvider = (v: string): v is ProviderName => PROVIDERS.some((p) => p.id === v);

export function findModel(spec: ModelSpec): CatalogModel | undefined {
  return MODEL_CATALOG.find((m) => m.provider === spec.provider && m.id === spec.model);
}

/** OpenRouter's ":free" variants cost nothing whatever their id. */
const isFree = (spec: ModelSpec) => spec.provider === "openrouter" && spec.model.endsWith(":free");

/** Estimated cost in millionths of a dollar, or null when the model has no known price. */
export function costMicros(
  spec: ModelSpec,
  inputTokens: number,
  outputTokens: number,
): number | null {
  if (isFree(spec)) return 0;
  const m = findModel(spec);
  if (!m) return null;
  // $/M tokens × tokens ÷ 1e6 = $; × 1e6 = micro-dollars, so the 1e6s cancel.
  return Math.round(m.inputPerM * inputTokens + m.outputPerM * outputTokens);
}
