import z from "zod";

import { hostOfTarget, isBlockedHost } from "./ssrf";

const hostname = z
  .string()
  .trim()
  .toLowerCase()
  .transform((v) => v.replace(/\.$/, ""))
  .pipe(z.hostname({ error: "Enter a valid domain name" }))
  .refine((v) => v.includes("."), { error: "Enter a fully qualified domain (e.g. example.com)" })
  .refine((v) => !isBlockedHost(v), { error: "Target must be a public host" });

const url = z
  .httpUrl({ error: "Enter a valid http/https URL" })
  .refine((u) => !isBlockedHost(hostOfTarget(u)), { error: "Target must be a public host" })
  .transform((u) => new URL(u).toString());

export const CreateAssetSchema = z.discriminatedUnion("kind", [
  z.object({ workspaceId: z.uuid(), kind: z.literal("domain"), value: hostname }),
  z.object({ workspaceId: z.uuid(), kind: z.literal("subdomain"), value: hostname }),
  z.object({ workspaceId: z.uuid(), kind: z.literal("url"), value: url }),
]);
export type CreateAssetInput = z.infer<typeof CreateAssetSchema>;

export const UpdateFindingSchema = z.object({ status: z.enum(["open", "ignored"]) });

export const DiscoverySelectionSchema = z.object({ ids: z.array(z.uuid()).min(1).max(100) });
