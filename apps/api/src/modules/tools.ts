import {
  ToolInputError,
  ToolUnreachableError,
  isToolId,
  normalizeHost,
  runTool,
  type ToolResult,
} from "@upzy/security";
import { Elysia } from "elysia";
import { z } from "zod";

import { HttpError } from "../plugins/errors";

const Params = z.object({ tool: z.string().max(20) });
const Query = z.object({ host: z.string().max(300) });

const TTL_MS = 10 * 60_000;
const MAX_CACHED = 500;
const MAX_RUNNING = 20;

export interface ToolsDeps {
  /** Tests inject a fake; production runs the real checks. */
  run?: (tool: Parameters<typeof runTool>[0], host: string) => Promise<ToolResult>;
  now?: () => number;
}

/**
 * The free checkers on the website: public, no sign-up, nothing stored. Because anyone can aim them at any site, they
 * are limited three ways: a per-address rate limit (see rate-limit.ts), a ten-minute cache per tool and host so one
 * site can't be hammered through us, and a cap on how many checks run at once.
 */
export const toolsModule = ({ run = runTool, now = Date.now }: ToolsDeps = {}) => {
  const cache = new Map<string, { at: number; result: ToolResult }>();
  const inFlight = new Map<string, Promise<ToolResult>>();

  return new Elysia({ prefix: "/tools" }).get(
    "/:tool",
    async ({ params, query, set }) => {
      if (!isToolId(params.tool)) throw new HttpError(404, "Unknown tool");
      let key: string;
      try {
        // Normalising here too gives the cache one key for "Example.com" and "https://example.com/".
        key = `${params.tool}:${normalizeHost(query.host)}`;
      } catch (e) {
        if (e instanceof ToolInputError) throw new HttpError(422, e.message);
        throw e;
      }

      const t = now();
      const hit = cache.get(key);
      set.headers["cache-control"] = "no-store";
      if (hit && t - hit.at < TTL_MS) return hit.result;

      let pending = inFlight.get(key);
      if (!pending) {
        if (inFlight.size >= MAX_RUNNING)
          throw new HttpError(503, "The checker is busy right now. Try again in a moment.");
        pending = run(params.tool, query.host).finally(() => inFlight.delete(key));
        inFlight.set(key, pending);
      }
      try {
        const result = await pending;
        if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
        cache.set(key, { at: now(), result });
        return result;
      } catch (e) {
        if (e instanceof ToolInputError || e instanceof ToolUnreachableError)
          throw new HttpError(422, e.message);
        console.error("[tools] check failed", key, e);
        throw new HttpError(502, "The check failed unexpectedly. Try again in a moment.");
      }
    },
    { params: Params, query: Query },
  );
};
