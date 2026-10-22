import { redact } from "@upzy/ai";
import { EMAIL_QUEUE, type Email } from "@upzy/auth/email";
import { schema, type Db } from "@upzy/db";
import { enqueue } from "@upzy/queue";
import { and, eq, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";

import type { AuthPlugin } from "../plugins/auth";
import { HttpError } from "../plugins/errors";

const { jobs } = schema;
const Params = z.object({ id: z.uuid() });

/** Where mail is going, without the credentials in the URL. */
function describeSmtp(env: Record<string, string | undefined>) {
  const raw = env.SMTP_URL;
  if (!raw) return { configured: false as const };
  try {
    const u = new URL(raw);
    return {
      configured: true as const,
      host: u.hostname,
      port: u.port ? Number(u.port) : u.protocol === "smtps:" ? 465 : 25,
      secure: u.protocol === "smtps:",
      from: env.MAIL_FROM ?? null,
    };
  } catch {
    return {
      configured: true as const,
      host: "(invalid SMTP_URL)",
      port: 0,
      secure: false,
      from: env.MAIL_FROM ?? null,
    };
  }
}

/**
 * Lets an admin check that the server can really send email: invitations, password resets and email alerts all
 * depend on it, and a wrong SMTP setting otherwise only shows up in the worker's log.
 */
export const emailModule = (
  db: Db,
  authP: AuthPlugin,
  env: Record<string, string | undefined> = process.env,
) =>
  new Elysia({ prefix: "/email" })
    .use(authP)
    .get("/status", () => describeSmtp(env), { org: "admin" })
    .post(
      "/test",
      async ({ user }) => {
        if (!describeSmtp(env).configured)
          throw new HttpError(409, "Email isn't set up on this server yet: SMTP_URL is empty.");
        const email: Email = {
          to: user.email,
          subject: "Upzy test email",
          text: "If you are reading this, Upzy can send email. Invitations, password resets and email alerts will reach people the same way.",
        };
        // One attempt: a failing test should say so now, not retry for minutes.
        const id = await enqueue(db, EMAIL_QUEUE, email, { maxAttempts: 1 });
        if (!id) throw new HttpError(409, "A test email is already on its way.");
        return { id, to: user.email };
      },
      { org: "admin" },
    )
    .get(
      "/test/:id",
      async ({ params, user }) => {
        const [job] = await db
          .select({ state: jobs.state, attempts: jobs.attempts, error: jobs.lastError })
          .from(jobs)
          .where(
            and(
              eq(jobs.id, params.id),
              eq(jobs.queue, EMAIL_QUEUE),
              // Only the test you sent yourself.
              sql`${jobs.payload}->>'to' = ${user.email} and ${jobs.payload}->>'subject' = 'Upzy test email'`,
            ),
          );
        if (!job) throw new HttpError(404, "Test not found");
        return {
          state:
            job.state === "done"
              ? ("sent" as const)
              : job.state === "failed"
                ? ("failed" as const)
                : ("sending" as const),
          error: job.error ? redact(job.error).slice(0, 300) : null,
        };
      },
      { org: "admin", params: Params },
    );
