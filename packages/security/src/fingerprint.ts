import { createHash } from "node:crypto";

import type { FindingDraft } from "./types";

/** Stable identity of a finding on an asset: repeats of the same issue map to the same row. */
export const fingerprint = (assetId: string, f: Pick<FindingDraft, "checkKey" | "subject">) =>
  createHash("sha256")
    .update(`${f.checkKey}\n${assetId}\n${f.subject ?? ""}`)
    .digest("hex");
