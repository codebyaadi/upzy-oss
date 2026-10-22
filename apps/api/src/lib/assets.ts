import { schema, type Db } from "@upzy/db";
import { hostOf, newVerificationToken, parentDomains, type AssetRef } from "@upzy/security";
import { and, eq, inArray } from "drizzle-orm";

const { assets, discoveredHosts } = schema;

/** True if the host, or a parent domain of it, is a verified asset in the workspace. */
export async function coveredByVerified(db: Db, workspaceId: string, asset: AssetRef) {
  const host = hostOf(asset);
  const [hit] = await db
    .select({ id: assets.id })
    .from(assets)
    .where(
      and(
        eq(assets.workspaceId, workspaceId),
        eq(assets.verified, true),
        inArray(assets.kind, ["domain", "subdomain"]),
        inArray(assets.value, [host, ...parentDomains(host)]),
      ),
    )
    .limit(1);
  return !!hit;
}

/** Inserts an asset (verified if a verified parent covers it) and settles any matching suggestion. */
export async function createAsset(
  db: Db,
  input: { workspaceId: string; kind: "domain" | "subdomain" | "url"; value: string },
) {
  const verified = await coveredByVerified(db, input.workspaceId, input);
  const token = newVerificationToken();
  const [row] = await db
    .insert(assets)
    .values({
      ...input,
      verificationToken: token,
      verified,
      verifiedAt: verified ? new Date() : null,
    })
    .returning({
      id: assets.id,
      workspaceId: assets.workspaceId,
      kind: assets.kind,
      value: assets.value,
      source: assets.source,
      verified: assets.verified,
      verifiedAt: assets.verifiedAt,
      lastScanAt: assets.lastScanAt,
      createdAt: assets.createdAt,
    });
  if (input.kind !== "url") {
    await db
      .update(discoveredHosts)
      .set({ status: "accepted" })
      .where(
        and(
          eq(discoveredHosts.workspaceId, input.workspaceId),
          eq(discoveredHosts.host, input.value),
        ),
      );
  }
  return { row: row!, token };
}
