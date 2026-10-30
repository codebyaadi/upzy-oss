import { BlockedTargetError } from "@upzy/probes";

import { exposedPathsCheck, portsCheck } from "./checks/active";
import { cveCheck } from "./checks/cve";
import { caaCheck, takeoverCheck } from "./checks/dns";
import { emailCheck } from "./checks/email-auth";
import { headersCheck } from "./checks/headers";
import { mtaStsCheck } from "./checks/mta-sts";
import { pageChangeCheck } from "./checks/page-change";
import { registrationCheck, dnssecCheck } from "./checks/registration";
import { reputationCheck } from "./checks/reputation";
import { servicesCheck } from "./checks/services";
import { tlsCheck, tlsLegacyCheck } from "./checks/tls";
import { defaultDeps } from "./deps";
import { extractHosts, mergePageState, type PageState } from "./page-state";
import { recordFetches, type Proof } from "./proof";
import { detectStack, type Stack } from "./stack";
import type { AssetRef, Check, CheckContext, Deps, FindingDraft } from "./types";
import { detectComponents, type Component } from "./vuln";

export const PASSIVE_CHECKS: Check[] = [
  headersCheck,
  tlsCheck,
  tlsLegacyCheck,
  emailCheck,
  mtaStsCheck,
  pageChangeCheck,
  caaCheck,
  takeoverCheck,
  cveCheck,
  registrationCheck,
  dnssecCheck,
  reputationCheck,
];

/** Checks that probe paths and ports. They run only for assets whose ownership has been verified. */
export const ACTIVE_CHECKS: Check[] = [exposedPathsCheck, portsCheck, servicesCheck];

export const ALL_CHECKS: Check[] = [...PASSIVE_CHECKS, ...ACTIVE_CHECKS];

export type Outcome = "ok" | "error" | "skipped";

export interface ScanResult {
  findings: FindingDraft[];
  /** Per check family. Only "ok" families may auto-resolve their old findings. */
  outcomes: Record<string, Outcome>;
  errors: Record<string, string>;
  /** What the site runs on, when the page could be fetched. */
  stack?: Stack;
  /** Versioned software seen on the page, when it could be fetched. Absent means "unknown", not "none". */
  components?: Component[];
  /** Third-party hosts on the page, merged with what was remembered. Absent when the page could not be read. */
  page?: PageState;
  /** Findings that were new but not seen again by the second run, so were not reported. */
  unconfirmed?: string[];
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

/** The identity of a finding within one asset: what makes two runs' findings "the same". */
const keyOf = (f: Pick<FindingDraft, "checkKey" | "subject">) => `${f.checkKey}
${f.subject ?? ""}`;

export interface RunOptions {
  deps?: Deps;
  checks?: Check[];
  timeoutMs?: number;
  verified?: boolean;
  /**
   * Whether a finding would be new to the customer (not already open or ignored). Each such finding is checked a second
   * time, with fresh requests, before it is reported, and dropped if the second run does not see it. A one-off
   * failure (a timeout, a CDN edge serving something odd) then never becomes an alert.
   */
  isNew?: (f: FindingDraft) => boolean;
  /** Pause before the second run, so it is not answered by the same transient condition. */
  recheckDelayMs?: number;
  /** What the page loaded from other sites at earlier scans, so what is new can be told. */
  previousPage?: PageState | null;
}

/**
 * Runs every applicable passive check. A failing check never aborts the scan: it is recorded as
 * "error" so its previous findings are left alone instead of being wrongly auto-resolved.
 * Every finding carries `evidence.proof` (when it was checked and the requests behind it).
 */
export async function runChecks(asset: AssetRef, opts: RunOptions = {}): Promise<ScanResult> {
  const ctx = contextFor(asset, opts.deps);
  const result: ScanResult = { findings: [], outcomes: {}, errors: {} };
  const checks = opts.checks ?? (opts.verified ? ALL_CHECKS : PASSIVE_CHECKS);

  // The page's third-party scripts, frames and form targets, against what was seen before. The fetch is shared with
  // the checks, so reading it here costs no request.
  const html = await ctx.deps.fetch(ctx.url).catch(() => undefined);
  if (html && html.status < 400 && /html/i.test(html.headers["content-type"] ?? "")) {
    const current = extractHosts(html.body, html.finalUrl, ctx.host);
    const state = mergePageState(opts.previousPage, current);
    ctx.page = { state, current };
    result.page = state;
  }

  // Same page the headers check reads (the fetch is shared), so detecting the stack costs no extra request.
  const stack = ctx.deps
    .fetch(ctx.url)
    .then((res) => detectStack(res))
    .catch(() => undefined);

  /** One run of one check, its findings stamped with the requests it made. */
  const runCheck = async (check: Check, c: CheckContext) => {
    const rec = recordFetches(c.deps, c.host);
    const drafts = await withTimeout(
      check.run({ ...c, deps: rec.deps }),
      check.timeoutMs ?? opts.timeoutMs ?? 30_000,
      check.family,
    );
    const checkedAt = new Date().toISOString();
    return drafts.map((f) => {
      const proof: Proof = {
        checkedAt,
        ...(rec.requests.length ? { requests: rec.requests } : {}),
      };
      return { ...f, evidence: { ...f.evidence, proof } };
    });
  };

  const found = new Map<Check, FindingDraft[]>();
  await Promise.all(
    checks.map(async (check) => {
      if (!check.appliesTo.includes(asset.kind) || (check.active && !opts.verified)) {
        result.outcomes[check.family] = "skipped";
        return;
      }
      try {
        found.set(check, await runCheck(check, ctx));
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

  // Validate before reporting: a finding new to the customer must be seen again, by a second run that shares nothing
  // with the first (no cached page), or it is dropped. Known findings are not re-run: they only refresh.
  const unconfirmed: string[] = [];
  const doubtful = [...found].filter(([, drafts]) => drafts.some((f) => opts.isNew?.(f)));
  if (doubtful.length > 0) {
    if (opts.recheckDelayMs ?? 1000)
      await new Promise((r) => setTimeout(r, opts.recheckDelayMs ?? 1000));
    const fresh = contextFor(asset, opts.deps);
    fresh.page = ctx.page;
    await Promise.all(
      doubtful.map(async ([check, drafts]) => {
        let again: Set<string> | undefined;
        try {
          again = new Set((await runCheck(check, fresh)).map(keyOf));
        } catch {
          // Inconclusive is not confirmed. It will be found again by the next scan if it is real.
        }
        const confirmedAt = new Date().toISOString();
        found.set(
          check,
          drafts.flatMap((f) => {
            if (!opts.isNew?.(f)) return [f];
            if (!again?.has(keyOf(f))) {
              unconfirmed.push(f.checkKey);
              return [];
            }
            return [
              {
                ...f,
                evidence: {
                  ...f.evidence,
                  proof: { ...(f.evidence?.proof as Proof), confirmedAt },
                },
              },
            ];
          }),
        );
      }),
    );
  }
  for (const drafts of found.values()) result.findings.push(...drafts);
  if (unconfirmed.length) result.unconfirmed = unconfirmed;
  result.stack = await stack;
  result.components = await ctx.deps
    .fetch(ctx.url)
    .then((res) => detectComponents(res))
    .catch(() => undefined);
  return result;
}
