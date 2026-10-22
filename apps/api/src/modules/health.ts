import type { Db } from "@upzy/db";
import { sql } from "drizzle-orm";
import { Elysia } from "elysia";

export const health = (db: Db) =>
  new Elysia({ prefix: "/health" }).get("/", async ({ set }) => {
    try {
      await db.execute(sql`select 1`);
      return { status: "ok", database: "up" };
    } catch {
      set.status = 503;
      return { status: "error", database: "down" };
    }
  });
