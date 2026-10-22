import { decryptJson } from "@upzy/crypto";
import type { schema } from "@upzy/db";

type Row = typeof schema.monitors.$inferSelect;

/** Names only: the values of a monitor's secrets are write-only and never leave the server. */
export function secretNames(row: Pick<Row, "secretsEncrypted">, key: string): string[] {
  if (!row.secretsEncrypted) return [];
  try {
    return Object.keys(decryptJson<Record<string, string>>(row.secretsEncrypted, key)).sort();
  } catch {
    return [];
  }
}

/**
 * A monitor as the API shows it. The encrypted secrets and the heartbeat token are removed from the row; the ping
 * address is added for people allowed to use it (members and up), since anyone who knows it can fake a ping.
 */
export function present(row: Row, opts: { key: string; apiOrigin: string; canSeePing: boolean }) {
  const { secretsEncrypted: _s, heartbeatToken, ...rest } = row;
  return {
    ...rest,
    secretNames: secretNames(row, opts.key),
    ...(row.type === "heartbeat"
      ? {
          pingUrl:
            opts.canSeePing && heartbeatToken ? `${opts.apiOrigin}/ping/${heartbeatToken}` : null,
        }
      : {}),
  };
}
