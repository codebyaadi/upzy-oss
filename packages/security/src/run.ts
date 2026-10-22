import { BlockedTargetError } from "@upzy/probes";

import { cveCheck } from "./checks/cve";
import { caaCheck, takeoverCheck } from "./checks/dns";
import { emailCheck } from "./checks/email-auth";
import { headersCheck } from "./checks/headers";
import { tlsCheck } from "./checks/tls";
import { defaultDeps } from "./deps";
import { detectStack, type Stack } from "./stack";
import type { AssetRef, Check, CheckContext, Deps, FindingDraft } from "./types";

export const PASSIVE_CHECKS: Check[] = [
  headersCheck,
  tlsCheck,
  emailCheck,
  caaCheck,
  takeoverCheck,
  cveCheck,
];

export type Outcome = "ok" | "error" | "skipped";

export interface ScanResult {
  findings: FindingDraft[];
  /** Per check family. Only "ok" families may auto-resolve their old findings. */
  outcomes: Record<string, Outcome>;
  errors: Record<string, string>;
  /** What the site runs on, when the page could be fetched. */
  stack?: Stack;
}

export const hostOf = (asset: AssetRef) =>
  asset.kind === "url" ? new URL(asset.value).hostname : asset.value;

/** Checks that look at the same page share one request instead of each fetching it again. */
function memoizeFetch(deps: Deps): Deps {
  const inFlight = new Map<string, ReturnType<Deps["fetch"]>>();
  return {
    ...deps,
    fetch: (url, opts) => {
      const key = `${url}\n${JSON.stringify(opts ?? {})}`;
      let hit = inFlight.get(key);
      if (!hit) inFlight.set(key, (hit = deps.fetch(url, opts)));
      return hit;
    },
  };
}

export function contextFor(asset: AssetRef, rawDeps: Deps = defaultDeps): CheckContext {
  const host = hostOf(asset);
  const deps = memoizeFetch(rawDeps);
  return { asset, host, url: asset.kind === "url" ? asset.value : `https://${host}/`, deps };
}

const withTimeout = <T>(p: Promise<T>, ms: number, family: string) =>
  Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${family} check timed out`)), ms)),
  ]);

/**
 * Runs every applicable passive check. A failing check never aborts the scan: it is recorded as
 * "error" so its previous findings are left alone instead of being wrongly auto-resolved.
 */
export async function runChecks(
  asset: AssetRef,
  opts: { deps?: Deps; checks?: Check[]; timeoutMs?: number } = {},
): Promise<ScanResult> {
  const ctx = contextFor(asset, opts.deps);
  const result: ScanResult = { findings: [], outcomes: {}, errors: {} };

  // Same page the headers check reads (the fetch is shared), so detecting the stack costs no extra request.
  const stack = ctx.deps
    .fetch(ctx.url)
    .then((res) => detectStack(res))
    .catch(() => undefined);

  await Promise.all(
    (opts.checks ?? PASSIVE_CHECKS).map(async (check) => {
      if (!check.appliesTo.includes(asset.kind)) {
        result.outcomes[check.family] = "skipped";
        return;
      }
      try {
        result.findings.push(
          ...(await withTimeout(
            check.run(ctx),
            check.timeoutMs ?? opts.timeoutMs ?? 30_000,
            check.family,
          )),
        );
        // Several checks may share a family; one failure must not be overwritten by a later success.
        if (result.outcomes[check.family] !== "error") result.outcomes[check.family] = "ok";
      } catch (e) {
        result.outcomes[check.family] = "error";
        result.errors[check.family] =
          e instanceof BlockedTargetError
            ? `Blocked: ${e.message}`
            : e instanceof Error
              ? e.message
              : String(e);
      }
    }),
  );
  result.stack = await stack;
  return result;
}
