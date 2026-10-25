import { ACTIVE_SCAN_QUEUE, SCAN_RESULT_QUEUE, schema, type Db } from "@upzy/db";
import { claim, discard, enqueue } from "@upzy/queue";
import {
  SCANNER_PROTOCOL,
  ScannerHelloSchema,
  ScannerPullSchema,
  ScannerResultSchema,
  type ScannerJob,
} from "@upzy/validator";
import { and, eq, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";

import { authenticateAgent } from "../lib/agent-auth";

const { assets, probeAgents, jobs } = schema;

/** What the scanner may send to one target. The scanner may go lower, never higher. */
export const SCAN_RATE_LIMIT_PER_SECOND = 5;
export const SCAN_TIMEOUT_SECONDS = 900;

const unauthorized = () =>
  new Response(JSON.stringify({ error: "Invalid or revoked scanner token." }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "www-authenticate": 'Bearer realm="upzy-scanner"',
    },
  });

/** The host to scan and the page to start from, for an asset. */
export function targetOf(asset: { kind: "domain" | "subdomain" | "url"; value: string }) {
  if (asset.kind === "url") {
    const u = new URL(asset.value);
    return { host: u.hostname, url: `https://${u.host}${u.pathname}${u.search}` };
  }
  return { host: asset.value, url: `https://${asset.value}/` };
}

/**
 * The API the active scanner talks to. Active scanning sends more traffic than a visit, so it is only ever done to
 * assets whose ownership has been proved, and that is checked here three times: when the scan is queued, when it is
 * handed out, and when the worker records its result. A scanner holds a token of its own kind: a probe agent's token
 * does not work here, nor this one there.
 */
export const scannerModule = (db: Db) =>
  new Elysia({ prefix: "/scanner" })
    .derive(async ({ request }) => ({
      scanner: await authenticateAgent(db, request.headers.get("authorization"), "scanner"),
    }))
    .onBeforeHandle(({ scanner }) => {
      if (!scanner) return unauthorized();
    })
    .post(
      "/hello",
      async ({ scanner, body }) => {
        await db
          .update(probeAgents)
          .set({
            lastSeenAt: new Date(),
            version: body.version,
            platform:
              [body.engine, body.engineVersion, body.os, body.arch].filter(Boolean).join(" ") ||
              null,
          })
          .where(eq(probeAgents.id, scanner!.id));
        return {
          scanner: scanner!.name,
          protocol: SCANNER_PROTOCOL,
          pollSeconds: 30,
          rateLimitPerSecond: SCAN_RATE_LIMIT_PER_SECOND,
        };
      },
      { body: ScannerHelloSchema },
    )
    // Hands out verified assets to scan. An asset that is not (or is no longer) verified is dropped, not scanned.
    .post(
      "/jobs/pull",
      async ({ scanner, body }) => {
        await db
          .update(probeAgents)
          .set({ lastSeenAt: new Date() })
          .where(eq(probeAgents.id, scanner!.id));
        const out: ScannerJob[] = [];
        for (const job of await claim(db, ACTIVE_SCAN_QUEUE, body.max)) {
          const { assetId } = job.payload as { assetId: string };
          const [asset] = await db.select().from(assets).where(eq(assets.id, assetId));
          if (!asset || !asset.verified) {
            await discard(db, job.id);
            continue;
          }
          const target = targetOf(asset);
          out.push({
            jobId: job.id,
            assetId: asset.id,
            host: target.host,
            url: target.url,
            rateLimitPerSecond: SCAN_RATE_LIMIT_PER_SECOND,
            timeoutSeconds: SCAN_TIMEOUT_SECONDS,
          });
        }
        return { jobs: out };
      },
      { body: ScannerPullSchema },
    )
    // A scan takes minutes, longer than the queue's patience for a silent worker. This says it is still going.
    .post(
      "/jobs/:jobId/heartbeat",
      async ({ params, set }) => {
        const rows = await db.execute(
          sql`update jobs set locked_at = now() where id = ${params.jobId} and queue = ${ACTIVE_SCAN_QUEUE} and state = 'running' returning 1`,
        );
        if (rows.length === 0) {
          set.status = 404;
          return { error: "No such scan is running." };
        }
        return { ok: true };
      },
      { params: z.object({ jobId: z.uuid() }) },
    )
    .post(
      "/jobs/:jobId/result",
      async ({ scanner, params, body, set }) => {
        const [job] = await db
          .select({ id: jobs.id, payload: jobs.payload })
          .from(jobs)
          .where(
            and(
              eq(jobs.id, params.jobId),
              eq(jobs.queue, ACTIVE_SCAN_QUEUE),
              eq(jobs.state, "running"),
            ),
          );
        if (!job) {
          set.status = 404;
          return { error: "No such scan is waiting for a result." };
        }
        const { assetId } = job.payload as { assetId: string };
        await db.transaction(async (tx) => {
          await enqueue(tx, SCAN_RESULT_QUEUE, { assetId, scannerId: scanner!.id, result: body });
          await tx.execute(sql`delete from jobs where id = ${job.id}`);
        });
        set.status = 202;
        return { accepted: true };
      },
      { params: z.object({ jobId: z.uuid() }), body: ScannerResultSchema },
    );
