import { schema, type Db } from "@upzy/db";
import { defaultDeps, parentDomains, verifyOwnership, type Deps } from "@upzy/security";
import { and, eq, inArray, like, lte, sql } from "drizzle-orm";

import { sleepUnlessAborted } from "./retention";

const { assets } = schema;

/** A verified asset is looked at again every week, and once a check fails, every day until it passes or is withdrawn. */
const RECHECK_EVERY = "7 days";
const RETRY_EVERY = "1 day";
/** Failed checks in a row before verification is withdrawn: a DNS hiccup or a deploy gap never costs it. */
export const MAX_FAILURES = 3;

export interface OwnershipResult {
  checked: number;
  /** Assets whose verification was withdrawn this round. */
  lost: string[];
}

/**
 * Proves again that whoever added an asset still controls it. Ownership is what lets Upzy probe paths and ports of a
 * site, so it cannot be a one-time event: a domain that is sold, expires or is handed to someone else stops being the
 * customer's. When the proof is gone for three checks in a row (a few days, never a single failure), the asset goes
 * back to unverified and its active checks stop with the next scan.
 *
 * A subdomain also passes while a verified parent domain in the same workspace covers it, which is how it was verified.
 */
export async function recheckOwnership(
  db: Db,
  deps: Pick<Deps, "resolveTxt" | "fetch"> = defaultDeps,
  batch = 25,
): Promise<OwnershipResult> {
  // Claim and push the due time out in one step: another worker skips these, and a crash simply means tomorrow.
  const due = await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(assets)
      .where(and(eq(assets.verified, true), lte(assets.verifyNextAt, sql`now()`)))
      .orderBy(assets.verifyNextAt)
      .limit(batch)
      .for("update", { skipLocked: true });
    if (rows.length > 0)
      await tx
        .update(assets)
        .set({ verifyNextAt: sql`now() + ${RETRY_EVERY}::interval` })
        .where(
          inArray(
            assets.id,
            rows.map((r) => r.id),
          ),
        );
    return rows;
  });

  const lost: string[] = [];
  for (const a of due) {
    let ok = false;
    try {
      ok = (await verifyOwnership({ kind: a.kind, value: a.value }, a.verificationToken, deps))
        .verified;
      if (!ok && a.kind === "subdomain") {
        const parents = parentDomains(a.value);
        if (parents.length > 0) {
          const [covered] = await db
            .select({ id: assets.id })
            .from(assets)
            .where(
              and(
                eq(assets.workspaceId, a.workspaceId),
                eq(assets.kind, "domain"),
                eq(assets.verified, true),
                inArray(assets.value, parents),
              ),
            )
            .limit(1);
          ok = !!covered;
        }
      }
    } catch (e) {
      console.error(`[ownership] ${a.value}:`, e);
    }

    if (ok) {
      await db
        .update(assets)
        .set({ verifyFailures: 0, verifyNextAt: sql`now() + ${RECHECK_EVERY}::interval` })
        .where(eq(assets.id, a.id));
    } else if (a.verifyFailures + 1 >= MAX_FAILURES) {
      await db
        .update(assets)
        .set({
          verified: false,
          verifiedAt: null,
          verifyFailures: 0,
          verificationLostAt: new Date(),
        })
        .where(eq(assets.id, a.id));
      lost.push(a.value);
      if (a.kind === "domain")
        // Subdomains verified through this domain are covered by nothing now: look at them at the next round, one
        // failure short of withdrawal, so that they follow within a day instead of waiting out their own week.
        await db
          .update(assets)
          .set({ verifyFailures: MAX_FAILURES - 1, verifyNextAt: sql`now()` })
          .where(
            and(
              eq(assets.workspaceId, a.workspaceId),
              eq(assets.kind, "subdomain"),
              eq(assets.verified, true),
              like(assets.value, `%.${a.value}`),
            ),
          );
    } else {
      await db
        .update(assets)
        .set({ verifyFailures: a.verifyFailures + 1 })
        .where(eq(assets.id, a.id));
    }
  }
  return { checked: due.length, lost };
}

/** Looks for due re-checks every ten minutes. A failure is logged and retried on the next round. */
export async function runOwnership(
  db: Db,
  signal: AbortSignal,
  opts: { firstDelayMs?: number; intervalMs?: number; deps?: Deps } = {},
) {
  await sleepUnlessAborted(opts.firstDelayMs ?? 3 * 60_000, signal);
  while (!signal.aborted) {
    try {
      for (;;) {
        const r = await recheckOwnership(db, opts.deps);
        if (r.lost.length)
          console.log(
            `[ownership] could not confirm ownership of ${r.lost.join(", ")}; active scans stopped for them`,
          );
        if (r.checked < 25 || signal.aborted) break;
      }
    } catch (e) {
      console.error("[ownership]", e);
    }
    await sleepUnlessAborted(opts.intervalMs ?? 10 * 60_000, signal);
  }
}
