import { createHash } from "node:crypto";

import {
  APICallError,
  generateText,
  NoObjectGeneratedError,
  Output,
  stepCountIs,
  type ModelMessage,
  type ToolSet,
} from "ai";
import type { z } from "zod";

import { costMicros } from "./catalog";
import type { AiConfig, ModelRole } from "./config";
import { chooseLiveModel, type ModelDiscovery } from "./discovery";
import {
  AiBudgetExceededError,
  AiDisabledError,
  AiNotConfiguredError,
  AiUnavailableError,
  type Attempt,
} from "./errors";
import { createRateLimiter, type RateLimiter } from "./limiter";
import { defaultModelFactory, resolveModel, type ModelFactory } from "./providers";
import { fence, mapStrings, redact, stripHidden, SYSTEM_GUARD } from "./safety";
import type { AiStores } from "./stores";

export interface StructuredRequest<T> {
  /** Used for usage accounting, e.g. "explain-finding". */
  feature: string;
  role: ModelRole;
  organizationId: string;
  schema: z.ZodType<T>;
  /** Trusted instructions for the task (ours, not from the outside world). */
  system: string;
  /** Trusted task text, e.g. "Explain this finding." */
  instructions: string;
  /** Untrusted inputs by label. Redacted, fenced and truncated before they reach the model. */
  data?: Record<string, string>;
  /** Cache identical requests. Pass false for output that must always be fresh. */
  cache?: { ttlMs: number } | false;
  maxOutputTokens?: number;
  timeoutMs?: number;
  maxCharsPerBlock?: number;
}

export interface StructuredResult<T> {
  data: T;
  provider: string;
  model: string;
  cached: boolean;
  usage: { inputTokens: number; outputTokens: number };
}

/** A tool-using conversation turn (the ops copilot). The tools are the caller's: this layer only runs them. */
export interface ChatRequest<T> {
  feature: string;
  role: ModelRole;
  organizationId: string;
  schema: z.ZodType<T>;
  system: string;
  /** Plain user/assistant text only. Anything untrusted belongs in tool results, which the caller fences. */
  messages: ModelMessage[];
  tools: ToolSet;
  /** Upper bound on model calls in this turn (each tool round trip is one). */
  maxSteps: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export interface ChatResult<T> {
  data: T;
  /** Which tools the model called, in order. */
  steps: { tool: string; input: unknown }[];
  provider: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface Gateway {
  generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;
  chat<T>(req: ChatRequest<T>): Promise<ChatResult<T>>;
}

export interface GatewayDeps {
  config: AiConfig;
  stores: AiStores;
  limiter?: RateLimiter;
  modelFactory?: ModelFactory;
  /** When set, "Automatic" model choices follow what the key can use right now instead of a fixed list. */
  discovery?: ModelDiscovery;
}

const MAX_PROMPT_CHARS = 24_000;
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

/** Provider-side problems worth trying another provider for. Anything else is a bug or a bad model id: also move on, but say why. */
function describe(e: unknown): string {
  if (APICallError.isInstance(e)) {
    // The provider's own explanation ("model not found", "quota exceeded", "API key not valid") is what makes this fixable.
    const why = redact(String(e.message)).replace(/\s+/g, " ").trim().slice(0, 180);
    return `HTTP ${e.statusCode ?? "?"}${e.statusCode === 429 ? " (rate limited)" : ""}${why ? `: ${why}` : ""}`;
  }
  if (NoObjectGeneratedError.isInstance(e)) return "invalid structured output";
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError"))
    return "timed out";
  return e instanceof Error ? redact(e.message).slice(0, 160) : "unknown error";
}

/**
 * The only way features talk to a model. It enforces the safety rules in one place:
 *  - AI must be enabled for the organization, and within its daily token budget
 *  - inputs are redacted, fenced as untrusted data and size-capped
 *  - the org's provider policy decides which providers may see the prompt
 *  - output is validated against a Zod schema (one repair retry), never trusted as free text
 *  - provider failures fall through to the next provider, and finally to AiUnavailableError
 * No tools are exposed, so a hostile page can't make the model do anything but emit JSON.
 */
export function createGateway({
  config,
  stores,
  limiter,
  modelFactory,
  discovery,
}: GatewayDeps): Gateway {
  const rate = limiter ?? createRateLimiter({ rpm: config.rpm });
  const factory = modelFactory ?? defaultModelFactory;

  /** AI must be on for the organization and under today's budget. */
  async function gate(organizationId: string) {
    const settings = await stores.settings.get(organizationId);
    if (!settings.enabled) throw new AiDisabledError();
    const used = await stores.usage.tokensToday(organizationId);
    if (used >= settings.dailyTokenBudget)
      throw new AiBudgetExceededError(used, settings.dailyTokenBudget);
    return settings;
  }

  /** The organization's own key and chosen model, nothing else: no shared key, no silent fallback. */
  async function pick(
    organizationId: string,
    role: ModelRole,
    settings: Awaited<ReturnType<typeof gate>>,
  ) {
    const keyed = await stores.credentials.providers(organizationId);
    let spec = resolveModel(settings.models, role, keyed);
    if (!spec) throw new AiNotConfiguredError();
    const key = await stores.credentials.get(organizationId, spec.provider);
    // Nothing was picked for this role: take the newest suitable model the key can use now, so a retired default
    // (or a newer generation) is handled without anyone editing settings.
    if (key && discovery && !settings.models[role]) {
      const live = chooseLiveModel(
        spec.provider,
        role,
        await discovery.models(organizationId, spec.provider, key),
      );
      if (live) spec = live;
    }
    const model = key ? factory(spec, key) : null;
    if (!model) {
      throw new AiUnavailableError([
        {
          provider: spec.provider,
          model: spec.model,
          reason: "no API key saved for this provider",
        },
      ]);
    }
    return { spec, model };
  }

  return {
    async chat<T>(req: ChatRequest<T>): Promise<ChatResult<T>> {
      const settings = await gate(req.organizationId);
      const { spec, model } = await pick(req.organizationId, req.role, settings);
      const record = (inputTokens: number, outputTokens: number, failed: boolean) =>
        stores.usage.record({
          organizationId: req.organizationId,
          provider: spec.provider,
          model: spec.model,
          feature: req.feature,
          inputTokens,
          outputTokens,
          failed,
          costMicros: failed ? 0 : costMicros(spec, inputTokens, outputTokens),
        });
      try {
        await rate.acquire();
        const res = await generateText({
          model,
          system: `${SYSTEM_GUARD}\n\n${req.system}`,
          messages: req.messages,
          tools: req.tools,
          stopWhen: stepCountIs(req.maxSteps),
          output: Output.object({ schema: req.schema }),
          temperature: 0.2,
          maxOutputTokens: req.maxOutputTokens ?? 1500,
          maxRetries: 0,
          abortSignal: AbortSignal.timeout(req.timeoutMs ?? 60_000),
        });
        const usage = {
          inputTokens: res.totalUsage.inputTokens ?? 0,
          outputTokens: res.totalUsage.outputTokens ?? 0,
        };
        await record(usage.inputTokens, usage.outputTokens, false);
        void stores.credentials.touch?.(req.organizationId, spec.provider)?.catch(() => {});
        const data = req.schema.parse(mapStrings(res.output, redact)) as T;
        const steps = res.steps.flatMap((st) =>
          st.toolCalls.map((c) => ({ tool: String(c.toolName), input: c.input })),
        );
        return { data, steps, provider: spec.provider, model: spec.model, usage };
      } catch (e) {
        await record(0, 0, true).catch(() => {});
        throw new AiUnavailableError([
          { provider: spec.provider, model: spec.model, reason: describe(e) },
        ]);
      }
    },

    async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
      const settings = await gate(req.organizationId);

      const system = `${SYSTEM_GUARD}\n\n${req.system}`;
      const blocks = Object.entries(req.data ?? {}).map(([label, text]) =>
        fence(label, text, { maxChars: req.maxCharsPerBlock }),
      );
      const prompt = [stripHidden(req.instructions), ...blocks].join("\n\n");
      if (system.length + prompt.length > MAX_PROMPT_CHARS) {
        throw new AiUnavailableError([{ provider: "-", model: "-", reason: "input too large" }]);
      }

      const cacheKey =
        req.cache === false ? null : hash({ f: req.feature, r: req.role, system, prompt });
      if (cacheKey) {
        const hit = await stores.cache.get<T>(cacheKey);
        if (hit !== undefined) {
          const parsed = req.schema.safeParse(hit);
          if (parsed.success)
            return {
              data: parsed.data,
              provider: "cache",
              model: "cache",
              cached: true,
              usage: { inputTokens: 0, outputTokens: 0 },
            };
        }
      }

      const picked = await pick(req.organizationId, req.role, settings);
      const chain = [picked];
      const attempts: Attempt[] = [];

      for (const { spec, model } of chain) {
        let repairHint = "";
        for (let tryNo = 0; tryNo < 2; tryNo++) {
          try {
            await rate.acquire();
            const res = await generateText({
              model,
              system,
              prompt: prompt + repairHint,
              output: Output.object({ schema: req.schema }),
              temperature: 0.2,
              maxOutputTokens: req.maxOutputTokens ?? 1200,
              maxRetries: 0,
              abortSignal: AbortSignal.timeout(req.timeoutMs ?? 40_000),
            });
            const usage = {
              inputTokens: res.usage.inputTokens ?? 0,
              outputTokens: res.usage.outputTokens ?? 0,
            };
            await stores.usage.record({
              organizationId: req.organizationId,
              provider: spec.provider,
              model: spec.model,
              feature: req.feature,
              ...usage,
              failed: false,
              costMicros: costMicros(spec, usage.inputTokens, usage.outputTokens),
            });
            void stores.credentials.touch?.(req.organizationId, spec.provider)?.catch(() => {});
            // Model output is untrusted too: scrub anything that looks like a secret before it is stored or shown.
            const data = req.schema.parse(mapStrings(res.output, redact)) as T;
            if (cacheKey && req.cache) await stores.cache.set(cacheKey, data, req.cache.ttlMs);
            return { data, provider: spec.provider, model: spec.model, cached: false, usage };
          } catch (e) {
            const reason = describe(e);
            await stores.usage
              .record({
                organizationId: req.organizationId,
                provider: spec.provider,
                model: spec.model,
                feature: req.feature,
                inputTokens: 0,
                outputTokens: 0,
                failed: true,
              })
              .catch(() => {});
            // Bad structured output: ask once more on the same model, then move on.
            if (NoObjectGeneratedError.isInstance(e) && tryNo === 0) {
              repairHint =
                "\n\nYour previous reply was not valid JSON for the required schema. Reply again with ONLY a JSON object that matches the schema.";
              continue;
            }
            attempts.push({ provider: spec.provider, model: spec.model, reason });
            break;
          }
        }
      }
      throw new AiUnavailableError(attempts);
    },
  };
}
