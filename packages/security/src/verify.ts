import { randomBytes } from "node:crypto";

import { defaultDeps } from "./deps";
import { hostOf } from "./run";
import type { AssetRef, Deps } from "./types";

export const newVerificationToken = () => randomBytes(16).toString("hex");

export const dnsRecordValue = (token: string) => `upzy-verify=${token}`;
export const wellKnownPath = "/.well-known/upzy-verify.txt";

export interface VerifyResult {
  verified: boolean;
  method?: "dns" | "file";
}

/**
 * Proves control of a host: either a TXT record `upzy-verify=<token>` on the host (or `_upzy.<host>`
 * for DNS providers that make apex TXT awkward), or the token served at /.well-known/upzy-verify.txt.
 */
export async function verifyOwnership(
  asset: AssetRef,
  token: string,
  deps: Pick<Deps, "resolveTxt" | "fetch"> = defaultDeps,
): Promise<VerifyResult> {
  const host = hostOf(asset);
  const expected = dnsRecordValue(token);

  for (const name of [host, `_upzy.${host}`]) {
    const records = await deps.resolveTxt(name).catch(() => []);
    if (records.some((r) => r.join("").trim() === expected))
      return { verified: true, method: "dns" };
  }

  for (const scheme of ["https", "http"]) {
    try {
      const res = await deps.fetch(`${scheme}://${host}${wellKnownPath}`, {
        maxBodyBytes: 1024,
        maxRedirects: 3,
      });
      if (res.status === 200 && res.body.trim() === token)
        return { verified: true, method: "file" };
    } catch {
      // fall through to the next method
    }
  }
  return { verified: false };
}

/** A subdomain inherits verification from a verified parent domain in the same workspace. */
export const parentDomains = (host: string): string[] => {
  const parts = host.split(".");
  return parts.slice(1, -1).map((_, i) => parts.slice(i + 1).join("."));
};
