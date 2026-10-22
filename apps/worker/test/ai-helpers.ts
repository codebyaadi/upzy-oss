import type { AiConfig } from "@upzy/ai";
import { encrypt } from "@upzy/crypto";
import { schema, type Db } from "@upzy/db";

export const CONFIG: AiConfig = { rpm: 1000, defaultDailyTokenBudget: 1000 };
export const ENC_KEY = Buffer.alloc(32, 7).toString("base64");

/** Gives an organization a Groq key of its own: the only way AI can run now. */
export const saveGroqKey = (db: Db, organizationId: string) =>
  db
    .insert(schema.aiCredentials)
    .values({
      organizationId,
      provider: "groq",
      encryptedKey: encrypt("gsk_test_key_1234", ENC_KEY),
      keyHint: "1234",
    })
    .onConflictDoNothing();
