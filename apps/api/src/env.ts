import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.url().default("http://localhost:3000"),
  WEB_ORIGIN: z.url().default("http://localhost:3001"),
  UPZY_ENCRYPTION_KEY: z.string().refine((k) => Buffer.from(k, "base64").length === 32, {
    error: "must be 32 bytes, base64 (openssl rand -base64 32)",
  }),
  PORT: z.coerce.number().int().positive().default(3000),
});

export type Env = z.infer<typeof EnvSchema>;

/** Validates process.env once at boot; exits with a readable message when invalid. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
}
