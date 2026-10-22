import { schema, type Db } from "@upzy/db";
import { enqueue } from "@upzy/queue";
import { and, eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";

import { HttpError } from "../plugins/errors";

const { monitors } = schema;
const Token = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{20,64}$/) });

/**
 * Where a cron job, worker or backup script reports in: `curl https://api.example.com/ping/<token>`. The token is
 * the only credential and is long and random. Any method works, so a plain `curl`, a webhook or a `wget` all do.
 * `/fail` reports that the job ran and failed. Unknown tokens are a plain 404 and a paused monitor ignores pings.
 */
export const pingModule = (db: Db) => {
  async function record(token: string, failed: boolean) {
    const now = new Date();
    const [m] = await db
      .select({
        id: monitors.id,
        active: monitors.active,
        status: monitors.lastStatus,
        last: monitors.lastPingAt,
      })
      .from(monitors)
      .where(and(eq(monitors.heartbeatToken, token), eq(monitors.type, "heartbeat")));
    if (!m) throw new HttpError(404, "Not found");
    if (!m.active) return;
    // A busy job may ping many times a second: one write a second is plenty.
    if (!failed && m.last && now.getTime() - m.last.getTime() < 1000 && m.status === "up") return;
    await db
      .update(monitors)
      .set(failed ? { lastFailAt: now } : { lastPingAt: now })
      .where(eq(monitors.id, m.id));
    // Going from late (or failed) back to healthy, or failing, should show up now, not at the next minute's check.
    if (failed || m.status !== "up")
      await enqueue(db, "check", { monitorId: m.id }, { dedupeKey: m.id, maxAttempts: 2 });
  }

  return new Elysia()
    .all(
      "/ping/:token",
      async ({ params }) => {
        await record(params.token, false);
        return { ok: true };
      },
      { params: Token },
    )
    .all(
      "/ping/:token/fail",
      async ({ params }) => {
        await record(params.token, true);
        return { ok: true };
      },
      { params: Token },
    );
};
