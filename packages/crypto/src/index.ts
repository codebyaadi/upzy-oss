import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Envelope format: `v1.<base64(iv | tag | ciphertext)>`. The version prefix leaves room for key
 * rotation: decrypt() can pick a key by version while encrypt() always uses the newest.
 */
const VERSION = "v1";

function keyFrom(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== 32)
    throw new Error(
      "UPZY_ENCRYPTION_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32)",
    );
  return key;
}

export function encrypt(plaintext: string, base64Key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(base64Key), iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${VERSION}.${Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64")}`;
}

export function decrypt(payload: string, base64Key: string): string {
  const [version, body] = payload.split(".");
  if (version !== VERSION || !body) throw new Error("Unsupported ciphertext format");
  const raw = Buffer.from(body, "base64");
  const decipher = createDecipheriv("aes-256-gcm", keyFrom(base64Key), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

export const encryptJson = (value: unknown, key: string) => encrypt(JSON.stringify(value), key);
export const decryptJson = <T>(payload: string, key: string) =>
  JSON.parse(decrypt(payload, key)) as T;

/** A random secret suitable for webhook signing. */
export const generateSecret = (prefix = "whsec") =>
  `${prefix}_${randomBytes(24).toString("base64url")}`;

/**
 * Stripe-style signature header: `t=<unix seconds>,v1=<hex hmac of "t.body">`. The timestamp is
 * part of the signed payload so receivers can reject replays.
 */
export function signWebhook(
  secret: string,
  body: string,
  timestamp = Math.floor(Date.now() / 1000),
): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

export function verifyWebhook(
  secret: string,
  body: string,
  header: string,
  toleranceSec = 300,
  now = Math.floor(Date.now() / 1000),
): boolean {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1 || Math.abs(now - t) > toleranceSec) return false;
  const expected = Buffer.from(signWebhook(secret, body, t).split("v1=")[1]!, "hex");
  const given = Buffer.from(parts.v1, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}
