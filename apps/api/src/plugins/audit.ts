import { schema, type Db } from "@upzy/db";
import { Elysia } from "elysia";

import { HttpError } from "./errors";
import { clientIp } from "./rate-limit";

export interface AuditEntry {
  organizationId: string;
  userId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  status: number;
  ip: string | null;
  userAgent: string | null;
  payload: Record<string, unknown>;
}

export type AuditSink = (entry: AuditEntry) => Promise<void>;

export const dbAuditSink =
  (db: Db): AuditSink =>
  async (entry) => {
    await db.insert(schema.auditLogs).values(entry);
  };

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** Auth endpoints are audited by better-auth hooks, where the session is known. */
const SKIP_PREFIXES = ["/api/auth/"];

/** Pulls an id out of a JSON response so creates can reference the new resource. */
const idOf = (response: unknown): string | null => {
  const id = (response as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : null;
};

/**
 * Records every mutating request made by a signed-in organization member: actor, route, resource,
 * status and client. Refused attempts (insufficient role) are recorded too. Bodies are reduced to
 * field names so secrets never reach the log. A failure to write the log is reported but never
 * fails the request.
 */
export const audit = (sink: AuditSink, opts: { trustProxy?: boolean } = {}) => {
  const created = new WeakMap<Request, string>();
  const trustProxy = opts.trustProxy ?? false;

  const record = (
    ctx: Record<string, any>,
    who: { organizationId: string; userId: string | null },
    status: number,
  ) => {
    const request = ctx.request as Request;
    const path = new URL(request.url).pathname;
    // Prefixed "/" routes are registered as "/workspace/": log the canonical form.
    const route: string = (ctx.route ?? path).replace(/\/+$/, "") || "/";
    const params: Record<string, string> = ctx.params ?? {};
    const body = ctx.body;
    void sink({
      organizationId: who.organizationId,
      userId: who.userId,
      action: `${request.method} ${route}`,
      resourceType: route.split("/")[1] ?? "unknown",
      resourceId: params.id ?? created.get(request) ?? null,
      status,
      ip: clientIp(request, ctx.server?.requestIP(request)?.address, trustProxy),
      userAgent: request.headers.get("user-agent")?.slice(0, 300) ?? null,
      payload: {
        params,
        fields: body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : [],
      },
    }).catch((e) => console.error("[audit] failed to record", e));
  };

  const auditable = (request: Request) =>
    MUTATING.has(request.method) &&
    !SKIP_PREFIXES.some((p) => new URL(request.url).pathname.startsWith(p));

  return new Elysia({ name: "audit" })
    .onAfterHandle({ as: "global" }, ({ request, response }) => {
      const id = idOf(response);
      if (id) created.set(request, id);
    })
    .onAfterResponse({ as: "global" }, (ctx) => {
      if (!auditable(ctx.request)) return;
      // Resolved by the `org` macro. Requests that never authenticated are not attributable.
      const { orgId, user } = ctx as unknown as { orgId?: string; user?: { id: string } };
      if (!orgId) return;
      const status = typeof ctx.set.status === "number" ? ctx.set.status : 200;
      // A deleted organization takes its audit log with it, so there is nowhere to record its own deletion.
      if (ctx.request.method === "DELETE" && ctx.route === "/organization" && status < 300) return;
      record(ctx, { organizationId: orgId, userId: user?.id ?? null }, status);
    })
    .onError({ as: "global" }, (ctx) => {
      // Role refusals never reach onAfterResponse with an org context, so log them here.
      if (ctx.error instanceof HttpError && ctx.error.actor && auditable(ctx.request)) {
        record(
          ctx,
          { organizationId: ctx.error.actor.organizationId, userId: ctx.error.actor.userId },
          ctx.error.status,
        );
      }
    });
};
