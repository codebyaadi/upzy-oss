import { decryptJson } from "@upzy/crypto";
import { RESULT_QUEUE, checkQueue, regionsOf, schema, type Db } from "@upzy/db";
import { claim, discard, enqueue, fail } from "@upzy/queue";
import {
  AGENT_MONITOR_TYPES,
  AGENT_PROTOCOL,
  AgentHelloSchema,
  AgentPullSchema,
  AgentResultSchema,
  type AgentJob,
} from "@upzy/validator";
import { and, eq, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";

import { authenticateAgent } from "../lib/agent-auth";
import { sealSecrets } from "../lib/agent-seal";

const { monitors, probeAgents, jobs } = schema;

const unauthorized = () =>
  new Response(JSON.stringify({ error: "Invalid or revoked agent token." }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "www-authenticate": 'Bearer realm="upzy-agent"',
    },
  });

/**
 * The API a probe agent talks to. The agent is a program on a machine in some region; it fetches checks for that
 * region, runs them, and reports what it measured. It never touches the database and never sees more than the checks
 * it is handed. Whether a result makes a monitor down, and every alert after that, is decided by the server's worker
 * with the same code as for a check it ran itself.
 */
export const agentModule = (db: Db, opts: { encryptionKey: string }) =>
  new Elysia({ prefix: "/agent" })
    .derive({ as: "scoped" }, async ({ request }) => ({
      agent: await authenticateAgent(db, request.headers.get("authorization")),
    }))
    .onBeforeHandle({ as: "scoped" }, ({ agent }) => {
      if (!agent) return unauthorized();
    })
    // Says who it is and what it runs, and learns how to talk to this server.
    .post(
      "/hello",
      async ({ agent, body }) => {
        await db
          .update(probeAgents)
          .set({
            lastSeenAt: new Date(),
            version: body.version,
            platform: [body.os, body.arch].filter(Boolean).join("/") || null,
          })
          .where(eq(probeAgents.id, agent!.id));
        return {
          agent: agent!.name,
          region: agent!.region,
          protocol: AGENT_PROTOCOL,
          pollSeconds: 5,
        };
      },
      { body: AgentHelloSchema },
    )
    // Hands out up to `max` due checks for the agent's region. A check not reported back within minutes goes to
    // another taker (the queue's stale-job recovery), so a crashed agent loses nothing.
    .post(
      "/jobs/pull",
      async ({ agent, body }) => {
        await db
          .update(probeAgents)
          .set({ lastSeenAt: new Date() })
          .where(eq(probeAgents.id, agent!.id));
        const claimed = await claim(db, checkQueue(agent!.region), body.max);
        const out: AgentJob[] = [];
        for (const job of claimed) {
          const { monitorId } = job.payload as { monitorId: string };
          const [m] = await db.select().from(monitors).where(eq(monitors.id, monitorId));
          const type = m?.type as (typeof AGENT_MONITOR_TYPES)[number] | undefined;
          // Paused, deleted, moved away from this region, or a kind an agent cannot run: nothing to do.
          if (
            !m ||
            !m.active ||
            !regionsOf(m).includes(agent!.region) ||
            !type ||
            !AGENT_MONITOR_TYPES.includes(type)
          ) {
            await discard(db, job.id);
            continue;
          }
          let sealedSecrets: AgentJob["sealedSecrets"];
          if (m.secretsEncrypted) {
            // Secrets are never sent in the clear: only to an agent that gave a key to seal them to.
            try {
              if (!body.publicKey)
                throw new Error("This agent sent no public key, so it cannot receive secrets");
              sealedSecrets = sealSecrets(
                decryptJson<Record<string, string>>(m.secretsEncrypted, opts.encryptionKey),
                body.publicKey,
                job.id,
              );
            } catch (e) {
              await fail(db, job, e);
              continue;
            }
          }
          out.push({
            jobId: job.id,
            monitorId: m.id,
            type,
            target: m.target,
            config: m.config as Record<string, unknown>,
            ...(sealedSecrets ? { sealedSecrets } : {}),
          });
        }
        return { jobs: out };
      },
      { body: AgentPullSchema },
    )
    // Takes the measurement. 202: it is queued for the worker, not yet applied.
    .post(
      "/jobs/:jobId/result",
      async ({ agent, params, body, set }) => {
        // Only a check this agent's region owns and that is out for delivery can be answered, once.
        const [job] = await db
          .select({ id: jobs.id, payload: jobs.payload })
          .from(jobs)
          .where(
            and(
              eq(jobs.id, params.jobId),
              eq(jobs.queue, checkQueue(agent!.region)),
              eq(jobs.state, "running"),
            ),
          );
        if (!job) {
          set.status = 404;
          return { error: "No such check is waiting for a result." };
        }
        const { monitorId } = job.payload as { monitorId: string };
        await db.transaction(async (tx) => {
          await enqueue(tx, RESULT_QUEUE, { monitorId, region: agent!.region, result: body });
          await tx.execute(sql`delete from jobs where id = ${job.id}`);
        });
        set.status = 202;
        return { accepted: true };
      },
      { params: z.object({ jobId: z.uuid() }), body: AgentResultSchema },
    );
