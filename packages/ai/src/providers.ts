import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

import { MODEL_CATALOG } from "./catalog";
import type { ModelRole, ModelSpec } from "./config";

/** Builds a callable model for a spec using the organization's own API key. Injectable for tests. */
export type ModelFactory = (spec: ModelSpec, apiKey: string) => LanguageModel | null;

export const defaultModelFactory: ModelFactory = (spec, apiKey) => {
  switch (spec.provider) {
    case "groq":
      return createGroq({ apiKey })(spec.model);
    case "openrouter":
      return createOpenRouter({ apiKey }).chat(spec.model);
    case "openai":
      return createOpenAI({ apiKey })(spec.model);
    case "anthropic":
      return createAnthropic({ apiKey })(spec.model);
    case "google":
      return createGoogleGenerativeAI({ apiKey })(spec.model);
  }
};

/** The catalog's model of a tier for a provider, e.g. Groq's quick model. */
export const tierModel = (provider: string, tier: ModelRole): ModelSpec | null => {
  const m = MODEL_CATALOG.find((c) => c.provider === provider && c.tier === tier);
  return m ? { provider: m.provider, model: m.id } : null;
};

/**
 * Which model runs a role. What an admin picked wins. A role they didn't pick follows the other one
 * (same provider, the catalog's model for that tier). With nothing picked it follows the first provider
 * that has a saved key. Null means nothing is set up yet.
 */
export function resolveModel(
  models: { fast: ModelSpec | null; smart: ModelSpec | null },
  role: ModelRole,
  keyedProviders: string[],
): ModelSpec | null {
  const picked = models[role];
  if (picked) return picked;
  const other = models[role === "fast" ? "smart" : "fast"];
  const provider = other?.provider ?? keyedProviders[0];
  if (!provider) return null;
  return tierModel(provider, role) ?? other ?? null;
}
