import { and, cosineDistance, desc, eq, gte, inArray, isNull, ne, or, sql } from "drizzle-orm";

import type { Db } from "./drizzle";
import { incidentEmbeddings, incidents, monitorChecks, monitors } from "./schema";

/*
 * Finding earlier incidents that failed the same way. Each incident gets a short text describing its failure
 * (what kind of monitor, how it failed, the error text with numbers and addresses removed), turned into a vector
 * by a small local function, and stored with pgvector. Nothing leaves the server and no model has to be
 * downloaded, so it works the same on a laptop and in production.
 *
 * The vector is a hashed bag of words, word pairs and letter triples: it measures shared wording, which is what
 * error messages are made of ("connect ECONNREFUSED", "502 Bad Gateway", "certificate has expired"). It does not
 * know that two differently worded errors mean the same thing. The model name is stored with each vector, so a
 * better embedder can replace this one later and old vectors are simply ignored until they are recomputed.
 */

export const EMBEDDING_DIMENSIONS = 384;
export const EMBEDDING_MODEL = "hash-v1";

/** Cosine similarity below this is coincidence, not the same failure. */
export const MIN_SIMILARITY = 0.5;

function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Lowercase words, with the parts that differ between two otherwise identical failures blanked out. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, " ")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, " ")
    .replace(/\b[0-9a-f]{16,}\b/g, " ")
    .replace(/https?:\/\/\S+/g, " url ")
    .replace(/\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}[\d:.z+-]*/g, " ")
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|seconds|minutes|min|bytes|kb|mb)\b/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A fixed-size, unit-length vector for a piece of text. The same text always gives the same vector. */
export function embedText(text: string): number[] {
  const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  const words = normalizeText(text).split(" ").filter(Boolean);
  const feats = new Map<string, number>();
  const bump = (f: string, w: number) => feats.set(f, (feats.get(f) ?? 0) + w);
  words.forEach((w, i) => {
    bump(`w:${w}`, 1);
    if (i > 0) bump(`b:${words[i - 1]} ${w}`, 1);
    const padded = `^${w}$`;
    for (let j = 0; j + 3 <= padded.length; j++) bump(`c:${padded.slice(j, j + 3)}`, 0.3);
  });
  for (const [f, n] of feats) {
    const h = fnv(f);
    // The second hash decides the sign, so unrelated features cancel instead of piling up.
    v[h % EMBEDDING_DIMENSIONS]! += (fnv(`s${f}`) & 1 ? 1 : -1) * (1 + Math.log(n));
  }
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return norm === 0 ? v : v.map((x) => x / norm);
}

export const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);

/**
 * What to say about an incident: the kind of monitor and the ways its checks failed while it was open. Checks are
 * only kept for a while, so an old incident whose checks are gone falls back to its title.
 */
export async function incidentDocument(
  db: Db,
  inc: {
    monitorId: string | null;
    title: string;
    type: string;
    createdAt: Date;
    resolvedAt: Date | null;
  },
): Promise<string> {
  const parts: string[] = [inc.type];
  if (inc.monitorId) {
    const [m] = await db
      .select({ type: monitors.type })
      .from(monitors)
      .where(eq(monitors.id, inc.monitorId));
    if (m) parts.push(m.type);
    const from = new Date(inc.createdAt.getTime() - 10 * 60_000);
    const to = new Date((inc.resolvedAt ?? new Date()).getTime() + 60_000);
    const failed = await db
      .select({
        kind: monitorChecks.errorKind,
        code: monitorChecks.statusCode,
        error: monitorChecks.error,
      })
      .from(monitorChecks)
      .where(
        and(
          eq(monitorChecks.monitorId, inc.monitorId),
          ne(monitorChecks.status, "up"),
          gte(monitorChecks.createdAt, from),
          sql`${monitorChecks.createdAt} <= ${to}`,
        ),
      )
      .orderBy(desc(monitorChecks.createdAt))
      .limit(20);
    for (const c of failed) {
      if (c.kind) parts.push(c.kind);
      if (c.code) parts.push(`http ${c.code}`);
      if (c.error) parts.push(c.error.slice(0, 300));
    }
    if (failed.length === 0) parts.push(inc.title);
  } else parts.push(inc.title);
  return parts.join(" . ");
}

/** Computes and stores the vector for each incident that doesn't have one (of the current model) yet. */
export async function ensureEmbedded(db: Db, workspaceId: string, ids: string[]) {
  if (ids.length === 0) return;
  const have = await db
    .select({ id: incidentEmbeddings.incidentId })
    .from(incidentEmbeddings)
    .where(
      and(
        inArray(incidentEmbeddings.incidentId, ids),
        eq(incidentEmbeddings.model, EMBEDDING_MODEL),
      ),
    );
  const done = new Set(have.map((h) => h.id));
  const todo = ids.filter((id) => !done.has(id));
  if (todo.length === 0) return;
  const rows = await db.select().from(incidents).where(inArray(incidents.id, todo));
  for (const inc of rows) {
    const embedding = embedText(await incidentDocument(db, inc));
    await db
      .insert(incidentEmbeddings)
      .values({ incidentId: inc.id, workspaceId, model: EMBEDDING_MODEL, embedding })
      .onConflictDoUpdate({
        target: incidentEmbeddings.incidentId,
        set: { model: EMBEDDING_MODEL, embedding, createdAt: new Date() },
      });
  }
}

export interface SimilarIncident {
  id: string;
  title: string;
  status: "open" | "acknowledged" | "resolved";
  monitorName: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
  /** 0 to 1, how alike the failures read. */
  similarity: number;
}

/** Earlier incidents in the same workspace that failed in a similar way, most alike first. */
export async function similarIncidents(
  db: Db,
  incidentId: string,
  opts: { limit?: number; windowDays?: number } = {},
): Promise<SimilarIncident[]> {
  const [inc] = await db.select().from(incidents).where(eq(incidents.id, incidentId));
  if (!inc) return [];
  const since = new Date(Date.now() - (opts.windowDays ?? 365) * 86_400_000);

  // Embed this incident and the most recent ones that haven't been yet, a bounded amount per call.
  const recent = await db
    .select({ id: incidents.id })
    .from(incidents)
    .leftJoin(
      incidentEmbeddings,
      and(
        eq(incidentEmbeddings.incidentId, incidents.id),
        eq(incidentEmbeddings.model, EMBEDDING_MODEL),
      ),
    )
    .where(
      and(
        eq(incidents.workspaceId, inc.workspaceId),
        gte(incidents.createdAt, since),
        or(isNull(incidentEmbeddings.incidentId), eq(incidents.id, inc.id)),
      ),
    )
    .orderBy(desc(incidents.createdAt))
    .limit(100);
  await ensureEmbedded(db, inc.workspaceId, [...new Set([inc.id, ...recent.map((r) => r.id)])]);

  const [mine] = await db
    .select({ embedding: incidentEmbeddings.embedding })
    .from(incidentEmbeddings)
    .where(eq(incidentEmbeddings.incidentId, inc.id));
  if (!mine) return [];

  const similarity = sql<number>`1 - (${cosineDistance(incidentEmbeddings.embedding, mine.embedding)})`;
  const rows = await db
    .select({
      id: incidents.id,
      title: incidents.title,
      status: incidents.status,
      monitorName: monitors.name,
      createdAt: incidents.createdAt,
      resolvedAt: incidents.resolvedAt,
      similarity,
    })
    .from(incidentEmbeddings)
    .innerJoin(incidents, eq(incidents.id, incidentEmbeddings.incidentId))
    .leftJoin(monitors, eq(monitors.id, incidents.monitorId))
    .where(
      and(
        eq(incidentEmbeddings.workspaceId, inc.workspaceId),
        eq(incidentEmbeddings.model, EMBEDDING_MODEL),
        ne(incidentEmbeddings.incidentId, inc.id),
        gte(incidents.createdAt, since),
        sql`${similarity} >= ${MIN_SIMILARITY}`,
      ),
    )
    .orderBy(sql`${similarity} desc`)
    .limit(opts.limit ?? 5);
  return rows.map((r) => ({ ...r, similarity: Number(r.similarity) }));
}
