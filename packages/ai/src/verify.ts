import type { ProviderName } from "./config";

export type VerifyResult =
  | { ok: true; /** Model ids this key can use, as the provider lists them. */ models: string[] }
  | { ok: false; reason: "rejected" | "unreachable"; message: string };

export type KeyVerifier = (provider: ProviderName, apiKey: string) => Promise<VerifyResult>;

interface Endpoint {
  url: string;
  headers: (key: string) => Record<string, string>;
  /** Pulls the model ids out of the provider's list response. */
  models: (body: any) => string[];
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
const ids = (body: any) =>
  Array.isArray(body?.data) ? body.data.map((m: any) => String(m.id)) : [];

/**
 * Every provider has a cheap "list the models this key can use" call. Checking a key with that, not with a chat
 * request for one particular model, means a wrong or retired model name can't be mistaken for a bad key, and it
 * tells us which models are really available.
 */
const ENDPOINTS: Record<ProviderName, Endpoint> = {
  groq: { url: "https://api.groq.com/openai/v1/models", headers: bearer, models: ids },
  openai: { url: "https://api.openai.com/v1/models", headers: bearer, models: ids },
  anthropic: {
    url: "https://api.anthropic.com/v1/models?limit=1000",
    headers: (k) => ({ "x-api-key": k, "anthropic-version": "2023-06-01" }),
    models: ids,
  },
  google: {
    url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
    headers: (k) => ({ "x-goog-api-key": k }),
    models: (b) =>
      Array.isArray(b?.models)
        ? b.models
            .filter(
              (m: any) =>
                !m.supportedGenerationMethods ||
                m.supportedGenerationMethods.includes("generateContent"),
            )
            .map((m: any) => String(m.name).replace(/^models\//, ""))
        : [],
  },
  // OpenRouter's model list is public, so the key itself is checked against its own endpoint.
  openrouter: { url: "https://openrouter.ai/api/v1/key", headers: bearer, models: () => [] },
};

/** Google AI Studio keys start with "AIza". Other Google keys (for instance "AQ.…", Vertex AI) are a different product. */
const googleHint = (key: string) =>
  key.startsWith("AIza")
    ? ""
    : " This doesn't look like a Gemini API key from Google AI Studio (those start with AIza): create one at aistudio.google.com/apikey. Keys for Google Cloud or Vertex AI aren't supported.";

export async function verifyWith(
  doFetch: typeof fetch,
  provider: ProviderName,
  apiKey: string,
): Promise<VerifyResult> {
  const e = ENDPOINTS[provider];
  try {
    const res = await doFetch(e.url, {
      headers: e.headers(apiKey),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403 || res.status === 400 || res.status === 404) {
      // Google answers 400 for a malformed key and 403 for a key that isn't allowed to use this API.
      return {
        ok: false,
        reason: "rejected",
        message: `The provider didn't accept this key.${provider === "google" ? googleHint(apiKey) : ""}`,
      };
    }
    if (res.status === 429 || res.status === 402)
      return {
        ok: false,
        reason: "unreachable",
        message:
          "The provider is rate limiting or asking for payment. Try again, and check the account's billing.",
      };
    if (!res.ok)
      return {
        ok: false,
        reason: "unreachable",
        message: `The provider answered with an error (${res.status}). Try again.`,
      };
    const body = await res.json().catch(() => null);
    if (provider === "openrouter") {
      // The key check lists no models; the public catalog does, so retired ones can be left out of the pickers.
      const list = await doFetch("https://openrouter.ai/api/v1/models", {
        signal: AbortSignal.timeout(15_000),
      })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      return { ok: true, models: ids(list) };
    }
    return { ok: true, models: e.models(body) };
  } catch {
    return { ok: false, reason: "unreachable", message: "Couldn't reach the provider. Try again." };
  }
}

export const verifyCredential: KeyVerifier = (provider, apiKey) =>
  verifyWith(fetch, provider, apiKey);
