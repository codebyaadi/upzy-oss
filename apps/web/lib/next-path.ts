import type { Route } from "next";

/**
 * Where to go after signing in. Only same-site relative paths are honoured, so `?next=` can't redirect
 * off-site. The check happens at runtime, so the result is asserted to be a `Route`.
 */
export function safeNext(value: string | null | undefined, fallback: Route = "/monitors"): Route {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\"))
    return fallback;
  return value as Route;
}
