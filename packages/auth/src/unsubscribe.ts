import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Links in lifecycle emails that switch them off for one user. The token is an HMAC of the user id under the auth
 * secret, so it can't be guessed or made for someone else, and it needs no storage. It never expires: an old email
 * must still be able to unsubscribe.
 */
export const unsubscribeToken = (secret: string, userId: string) =>
  createHmac("sha256", secret).update(`unsubscribe:${userId}`).digest("hex");

export function validUnsubscribeToken(secret: string, userId: string, token: string): boolean {
  if (!secret || !userId || !token) return false;
  const expected = Buffer.from(unsubscribeToken(secret, userId));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** `apiUrl` is where the API is reached from outside (BETTER_AUTH_URL). */
export const unsubscribeUrl = (apiUrl: string, secret: string, userId: string) =>
  `${apiUrl.replace(/\/$/, "")}/lifecycle/unsubscribe?u=${encodeURIComponent(userId)}&t=${unsubscribeToken(secret, userId)}`;
