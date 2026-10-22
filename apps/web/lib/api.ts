import { treaty } from "@elysiajs/eden";
import type { App } from "api";

/** End-to-end typed client for apps/api (Eden Treaty). Cookies are sent for session auth. */
export const api: ReturnType<typeof treaty<App>> = treaty<App>(
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000",
  {
    fetch: { credentials: "include" },
  },
);
