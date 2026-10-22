import {
  findModel,
  isProvider,
  MODEL_CATALOG,
  parseModelSpec,
  PRICES_AS_OF,
  PROVIDERS,
  resolveModel,
  AiNotConfiguredError,
  verifyCredential,
  type KeyVerifier,
  type ModelSpec,
  askCopilot,
  chooseLiveModel,
  createModelDiscovery,
  tierModel,
  type ModelDiscovery,
  draftMonitor,
  snapInterval,
  AiBudgetExceededError,
  AiDisabledError,
  AiError,
  AiRateLimitedError,
  AiUnavailableError,
  utcDay,
  type AiConfig,
  type AiStores,
  type Gateway,
} from "@upzy/ai";
import { encrypt } from "@upzy/crypto";
import { schema, type Db } from "@upzy/db";
import { enqueue } from "@upzy/queue";
import { CreateMonitorSchema } from "@upzy/validator";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";

import { copilotTools, Refs, type CitationType } from "../lib/copilot-tools";
import { orgWorkspaceIds, requireWorkspace } from "../lib/scope";
import type { AuthPlugin } from "../plugins/auth";
import { HttpError } from "../plugins/errors";

const { aiSettings, aiUsage, aiCredentials, findings } = schema;

export interface AiDeps {
  gateway: Gateway;
  config: AiConfig;
  stores: AiStores;
  /** Checks a pasted key with the provider. Tests inject a fake; production calls the provider. */
  verifyKey?: KeyVerifier;
  /** Live model lists per key. Share the instance the gateway uses so the page shows what will really run. */
  discovery?: ModelDiscovery;
}

const Params = z.object({ id: z.uuid() });
const ModelId = z
  .string()
  .trim()
  .max(160)
  .refine((v) => {
    try {
      parseModelSpec(v);
      return true;
    } catch {
      return false;
    }
  }, "Expected provider:model");
const SettingsBody = z.object({
  enabled: z.boolean().optional(),
  fastModel: ModelId.nullable().optional(),
  smartModel: ModelId.nullable().optional(),
  dailyTokenBudget: z.number().int().min(1_000).max(5_000_000).optional(),
});
const KeyParams = z.object({ provider: z.string().refine(isProvider, "Unknown provider") });
const KeyBody = z.object({
  apiKey: z
    .string()
    .trim()
    .min(8)
    .max(400)
    .regex(/^[\x21-\x7e]+$/, "A key has no spaces or line breaks"),
});
const UsageQuery = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) });
const CopilotBody = z.object({
  // The conversation so far, oldest first, ending with the person's new question. Nothing is stored on the server.
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().trim().min(1).max(2000),
      }),
    )
    .min(1)
    .max(12)
    .refine((m) => m.at(-1)?.role === "user", "The last message must be a question"),
});
const DraftBody = z.object({ workspaceId: z.uuid(), text: z.string().trim().min(5).max(1000) });
const ExplainBody = z.object({ force: z.boolean().optional() }).optional();

/** AI errors are expected conditions, not server faults: map each to a status the UI can explain. */
function toHttp(e: unknown): never {
  if (e instanceof AiDisabledError) throw new HttpError(403, e.userMessage);
  if (e instanceof AiBudgetExceededError) throw new HttpError(429, e.userMessage);
  if (e instanceof AiRateLimitedError) throw new HttpError(429, e.userMessage);
  if (e instanceof AiUnavailableError) throw new HttpError(503, e.userMessage);
  if (e instanceof AiError) throw new HttpError(503, e.userMessage);
  throw e;
}

const specOf = (raw: string | null | undefined): ModelSpec | null =>
  raw ? parseModelSpec(raw) : null;
const label = (s: ModelSpec | null) => (s ? `${s.provider}:${s.model}` : null);

export const aiModule = (db: Db, authP: AuthPlugin, ai: AiDeps, encryptionKey?: string) => {
  const verify = ai.verifyKey ?? verifyCredential;
  const discovery =
    ai.discovery ??
    createModelDiscovery(async (provider, key) => {
      const r = await verify(provider, key);
      if (!r.ok) throw new Error(r.message);
      return r.models;
    });

  /** The model each role will use for this organization, and whether its provider has a saved key. */
  async function effective(
    orgId: string,
    models: { fast: ModelSpec | null; smart: ModelSpec | null },
  ) {
    const keyed = await ai.stores.credentials.providers(orgId);
    const one = async (role: "fast" | "smart") => {
      let spec = resolveModel(models, role, keyed);
      // Nothing picked: Automatic means the newest suitable model this key can use right now.
      if (spec && !models[role] && keyed.includes(spec.provider)) {
        const key = await ai.stores.credentials.get(orgId, spec.provider);
        const live = key
          ? chooseLiveModel(spec.provider, role, await discovery.models(orgId, spec.provider, key))
          : null;
        if (live) spec = live;
      }
      return { spec, ready: !!spec && keyed.includes(spec.provider) };
    };
    return { fast: await one("fast"), smart: await one("smart") };
  }

  return new Elysia({ prefix: "/ai" })
    .use(authP)
    .get(
      "/settings",
      async ({ orgId }) => {
        const settings = await ai.stores.settings.get(orgId);
        const usedToday = await ai.stores.usage.tokensToday(orgId);
        const byFeature = await db
          .select({
            feature: aiUsage.feature,
            requests: sql<number>`sum(${aiUsage.requests})::int`,
            tokens: sql<number>`sum(${aiUsage.inputTokens} + ${aiUsage.outputTokens})::int`,
            failures: sql<number>`sum(${aiUsage.failures})::int`,
          })
          .from(aiUsage)
          .where(and(eq(aiUsage.organizationId, orgId), eq(aiUsage.day, utcDay())))
          .groupBy(aiUsage.feature);
        const credentials = await db
          .select({
            provider: aiCredentials.provider,
            hint: aiCredentials.keyHint,
            createdAt: aiCredentials.createdAt,
            lastUsedAt: aiCredentials.lastUsedAt,
          })
          .from(aiCredentials)
          .where(eq(aiCredentials.organizationId, orgId));
        const eff = await effective(orgId, settings.models);
        return {
          enabled: settings.enabled,
          dailyTokenBudget: settings.dailyTokenBudget,
          fastModel: label(settings.models.fast),
          smartModel: label(settings.models.smart),
          usedToday,
          byFeature,
          credentials,
          // Everything the model pickers need: providers, models and their (estimated) prices.
          catalog: {
            pricesAsOf: PRICES_AS_OF,
            providers: PROVIDERS.map((p) => ({ id: p.id, label: p.label, keysUrl: p.keysUrl })),
            models: MODEL_CATALOG,
          },
          // What will actually run for this organization right now.
          active: {
            fast: { model: label(eff.fast.spec), ready: eff.fast.ready },
            smart: { model: label(eff.smart.spec), ready: eff.smart.ready },
          },
        };
      },
      { org: true },
    )
    .patch(
      "/settings",
      async ({ body, orgId, user }) => {
        const current = await ai.stores.settings.get(orgId);
        const next = {
          enabled: body.enabled ?? current.enabled,
          dailyTokenBudget: body.dailyTokenBudget ?? current.dailyTokenBudget,
          models: {
            fast: body.fastModel === undefined ? current.models.fast : specOf(body.fastModel),
            smart: body.smartModel === undefined ? current.models.smart : specOf(body.smartModel),
          },
        };
        const eff = await effective(orgId, next.models);
        // Models can be chosen before the key exists (that is where you add it); AI itself can't be turned on
        // until every role has a saved key.
        if (body.enabled === true) {
          if (!eff.fast.spec || !eff.smart.spec)
            throw new HttpError(409, new AiNotConfiguredError().userMessage);
          for (const role of ["fast", "smart"] as const) {
            const e = eff[role];
            if (!e.ready)
              throw new HttpError(
                409,
                `Save your ${e.spec!.provider} API key first: the ${role === "fast" ? "quick-task" : "main"} model uses it.`,
              );
          }
        }
        const values = {
          enabled: next.enabled,
          dailyTokenBudget: next.dailyTokenBudget,
          fastModel: label(next.models.fast),
          smartModel: label(next.models.smart),
          updatedBy: user.id,
        };
        await db
          .insert(aiSettings)
          .values({ organizationId: orgId, ...values })
          .onConflictDoUpdate({
            target: aiSettings.organizationId,
            set: { ...values, updatedAt: new Date() },
          });
        return { ...next, fastModel: values.fastModel, smartModel: values.smartModel };
      },
      { org: "admin", body: SettingsBody },
    )
    .put(
      "/credentials/:provider",
      async ({ params, body, orgId, user }) => {
        if (!encryptionKey)
          throw new HttpError(503, "Key storage isn't configured on this server.");
        const provider = params.provider as ModelSpec["provider"];
        // Prove the key works before keeping it, with the provider's "list models" call: no customer data is sent,
        // and a wrong model name can't pass for a bad key.
        const result = await verify(provider, body.apiKey);
        if (!result.ok)
          throw new HttpError(result.reason === "rejected" ? 422 : 503, result.message);
        const row = {
          encryptedKey: encrypt(body.apiKey, encryptionKey),
          keyHint: body.apiKey.slice(-4),
          createdBy: user.id,
        };
        await db
          .insert(aiCredentials)
          .values({ organizationId: orgId, provider, ...row })
          .onConflictDoUpdate({
            target: [aiCredentials.organizationId, aiCredentials.provider],
            set: { ...row, createdAt: new Date(), lastUsedAt: null },
          });
        // Models we offer for this provider that the key can't use (retired, or not enabled for the account).
        const unavailable =
          result.models.length > 0
            ? MODEL_CATALOG.filter(
                (m) => m.provider === provider && !result.models.includes(m.id),
              ).map((m) => m.id)
            : [];
        discovery.prime(orgId, provider, result.models);
        // What Automatic will use with this key, from the provider's own list.
        const auto = (role: "fast" | "smart") =>
          label(
            (result.models.length ? chooseLiveModel(provider, role, result.models) : null) ??
              tierModel(provider, role),
          );
        const automatic = { fast: auto("fast"), smart: auto("smart") };
        return {
          provider,
          hint: row.keyHint,
          availableModels: result.models.length,
          unavailable,
          automatic,
        };
      },
      { org: "admin", params: KeyParams, body: KeyBody },
    )
    .delete(
      "/credentials/:provider",
      async ({ params, orgId }) => {
        const settings = await ai.stores.settings.get(orgId);
        // Taking away the key AI is running on would silently break it: turn AI off (or change model) first.
        if (settings.enabled) {
          const eff = await effective(orgId, settings.models);
          if ([eff.fast.spec, eff.smart.spec].some((m) => m?.provider === params.provider))
            throw new HttpError(
              409,
              "AI is using this key. Turn AI off or choose a model from another provider first.",
            );
        }
        discovery.forget(orgId, params.provider);
        await db
          .delete(aiCredentials)
          .where(
            and(
              eq(aiCredentials.organizationId, orgId),
              eq(aiCredentials.provider, params.provider),
            ),
          );
        return { ok: true as const };
      },
      { org: "admin", params: KeyParams },
    )
    .get(
      "/models",
      async ({ orgId }) => {
        // What each saved key can actually use right now, straight from the provider (cached for a few minutes).
        const out: Record<string, string[]> = {};
        for (const provider of await ai.stores.credentials.providers(orgId)) {
          const key = await ai.stores.credentials.get(orgId, provider);
          out[provider] = key
            ? await discovery.models(orgId, provider as ModelSpec["provider"], key)
            : [];
        }
        return out;
      },
      { org: true },
    )
    .get(
      "/usage",
      async ({ query, orgId }) => {
        const since = new Date(Date.now() - (query.days - 1) * 86_400_000)
          .toISOString()
          .slice(0, 10);
        const rows = await db
          .select({
            // Bun.SQL returns `date` columns as Date objects: ask for the calendar day as text instead.
            day: sql<string>`${aiUsage.day}::text`,
            provider: aiUsage.provider,
            model: aiUsage.model,
            feature: aiUsage.feature,
            requests: aiUsage.requests,
            failures: aiUsage.failures,
            inputTokens: aiUsage.inputTokens,
            outputTokens: aiUsage.outputTokens,
            costMicros: aiUsage.costMicros,
            unpriced: aiUsage.unpricedRequests,
          })
          .from(aiUsage)
          .where(and(eq(aiUsage.organizationId, orgId), sql`${aiUsage.day} >= ${since}`));

        type Agg = {
          requests: number;
          failures: number;
          inputTokens: number;
          outputTokens: number;
          costMicros: number;
          unpriced: number;
        };
        const zero = (): Agg => ({
          requests: 0,
          failures: 0,
          inputTokens: 0,
          outputTokens: 0,
          costMicros: 0,
          unpriced: 0,
        });
        const add = (a: Agg, r: (typeof rows)[number]) => {
          a.requests += r.requests;
          a.failures += r.failures;
          a.inputTokens += r.inputTokens;
          a.outputTokens += r.outputTokens;
          a.costMicros += r.costMicros;
          a.unpriced += r.unpriced;
        };
        const group = (key: (r: (typeof rows)[number]) => string) => {
          const m = new Map<string, Agg>();
          for (const r of rows) {
            const a = m.get(key(r)) ?? zero();
            add(a, r);
            m.set(key(r), a);
          }
          return m;
        };
        const total = zero();
        rows.forEach((r) => add(total, r));

        // One entry per day in the window, so the chart has no gaps.
        const byDay = group((r) => r.day);
        const days = Array.from({ length: query.days }, (_, i) => {
          const d = new Date(Date.parse(since) + i * 86_400_000).toISOString().slice(0, 10);
          return { day: d, ...(byDay.get(d) ?? zero()) };
        });
        const list = (m: Map<string, Agg>) =>
          [...m]
            .map(([key, v]) => ({ key, ...v }))
            .sort(
              (a, b) =>
                b.costMicros - a.costMicros ||
                b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
            );
        return {
          days: query.days,
          pricesAsOf: PRICES_AS_OF,
          total,
          perDay: days,
          byModel: list(group((r) => `${r.provider}:${r.model}`)).map((m) => ({
            ...m,
            known: !!findModel(parseModelSpec(m.key)) || m.key.endsWith(":free"),
          })),
          byFeature: list(group((r) => r.feature)),
        };
      },
      { org: true, query: UsageQuery },
    )
    .post(
      "/copilot",
      async ({ user, body, orgId }) => {
        const refs = new Refs();
        let result;
        try {
          result = await askCopilot(ai.gateway, orgId, {
            messages: body.messages,
            tools: copilotTools(db, orgId, user.id, refs),
          });
        } catch (e) {
          toHttp(e);
        }
        // The model cites short handles. Only records the tools actually returned have one, so anything else it
        // names is dropped; the real id and title come from our side.
        const citations = result.data.citations
          .map((c) => refs.resolve(c.type as CitationType, c.id))
          .filter((c): c is NonNullable<typeof c> => !!c)
          .filter((c, i, all) => all.findIndex((x) => x.type === c.type && x.id === c.id) === i);
        return {
          answer: result.data.answer,
          citations,
          looked: [...new Set(result.steps.map((s) => s.tool))],
          model: `${result.provider}/${result.model}`,
        };
      },
      { org: "member", body: CopilotBody },
    )
    .post(
      "/monitor-draft",
      async ({ user, body, orgId }) => {
        await requireWorkspace(db, orgId, body.workspaceId, user.id);
        let result;
        try {
          result = await draftMonitor(ai.gateway, orgId, body.text);
        } catch (e) {
          toHttp(e);
        }
        const d = result.data;
        // The model only proposes. The real schema (including the internal-host screen) decides if it is acceptable.
        const candidate = {
          workspaceId: body.workspaceId,
          name: d.name,
          type: d.type,
          target: d.target,
          interval: snapInterval(d.intervalSeconds),
          failureThreshold: d.failureThreshold,
          active: true,
          config: d.type === "http" && d.keyword ? { keyword: d.keyword } : {},
        };
        const checked = CreateMonitorSchema.safeParse(candidate);
        if (!checked.success) {
          const why = checked.error.issues.map((i) => i.message).join("; ");
          throw new HttpError(
            422,
            `The AI suggestion wasn't usable (${why}). Try rephrasing, or fill in the form yourself.`,
          );
        }
        const { workspaceId: _w, ...draft } = checked.data;
        return {
          draft,
          unsupported: d.unsupported,
          rationale: d.rationale,
          model: `${result.provider}/${result.model}`,
        };
      },
      { org: "member", body: DraftBody },
    )
    .post(
      "/finding/:id/explain",
      async ({ user, params, body, orgId, set }) => {
        const [row] = await db
          .select({
            id: findings.id,
            aiExplainedAt: findings.aiExplainedAt,
            status: findings.aiExplainStatus,
          })
          .from(findings)
          .where(
            and(
              eq(findings.id, params.id),
              inArray(findings.workspaceId, orgWorkspaceIds(db, orgId, user.id)),
            ),
          );
        if (!row) throw new HttpError(404, "Finding not found");

        const settings = await ai.stores.settings.get(orgId);
        if (!settings.enabled) throw new HttpError(403, new AiDisabledError().userMessage);

        if (row.aiExplainedAt && !body?.force) return { status: "ready" as const };
        if (row.status === "pending") return { status: "pending" as const };

        await db
          .update(findings)
          .set({ aiExplainStatus: "pending", aiExplainError: null })
          .where(eq(findings.id, row.id));
        await enqueue(
          db,
          "ai",
          { kind: "explain-finding", findingId: row.id },
          { maxAttempts: 3, dedupeKey: `explain:${row.id}` },
        );
        set.status = 202;
        return { status: "pending" as const };
      },
      { org: "member", params: Params, body: ExplainBody },
    );
};
