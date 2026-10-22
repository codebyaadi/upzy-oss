import { Elysia } from "elysia";
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Who was refused, when known, so denied attempts can be audited. */
    public actor?: { organizationId: string; userId: string },
  ) {
    super(message);
  }
}

const PG_UNIQUE_VIOLATION = "23505";

/** Postgres error code, whether thrown directly or wrapped by Drizzle (`cause`). */
function pgCode(err: unknown): string | undefined {
  const e = err as { code?: string; errno?: string; cause?: { code?: string; errno?: string } };
  return e?.errno ?? e?.code ?? e?.cause?.errno ?? e?.cause?.code;
}

export const errors = new Elysia({ name: "errors" })
  .error({ HttpError })
  .onError({ as: "global" }, ({ code, error, set }) => {
    if (error instanceof HttpError) {
      set.status = error.status;
      return { message: error.message };
    }
    if (error instanceof ZodError) {
      set.status = 400;
      return {
        message: "Validation failed",
        errors: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      };
    }
    if (code === "VALIDATION") {
      set.status = 400;
      return { message: "Validation failed" };
    }
    if (code === "NOT_FOUND") {
      set.status = 404;
      return { message: "Not found" };
    }
    if (pgCode(error) === PG_UNIQUE_VIOLATION) {
      set.status = 409;
      return { message: "Unique constraint failed on the database." };
    }
    console.error(error);
    set.status = 500;
    return { message: "Internal server error" };
  });
