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

/** The same idea for client reports: one link per (workspace, address), so one recipient can opt out alone. */
const reportKey = (workspaceId: string, email: string) =>
  `report:${workspaceId}:${email.trim().toLowerCase()}`;
export const reportUnsubscribeToken = (secret: string, workspaceId: string, email: string) =>
  createHmac("sha256", secret).update(reportKey(workspaceId, email)).digest("hex");

export function validReportUnsubscribeToken(
  secret: string,
  workspaceId: string,
  email: string,
  token: string,
): boolean {
  if (!secret || !workspaceId || !email || !token) return false;
  const expected = Buffer.from(reportUnsubscribeToken(secret, workspaceId, email));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export const reportUnsubscribeUrl = (
  apiUrl: string,
  secret: string,
  workspaceId: string,
  email: string,
) =>
  `${apiUrl.replace(/\/$/, "")}/reports/unsubscribe?w=${encodeURIComponent(workspaceId)}&e=${encodeURIComponent(email.trim().toLowerCase())}&t=${reportUnsubscribeToken(secret, workspaceId, email)}`;
