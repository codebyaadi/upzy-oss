import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  EMBEDDING_DIMENSIONS,
  MIN_SIMILARITY,
  cosine,
  createDb,
  embedText,
  normalizeText,
  schema,
  similarIncidents,
} from "@upzy/db";
import { eq } from "drizzle-orm";

describe("embedText", () => {
  test("gives the same unit-length vector for the same text", () => {
    const a = embedText("connect ECONNREFUSED");
    expect(a).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(embedText("connect ECONNREFUSED")).toEqual(a);
    expect(Math.hypot(...a)).toBeCloseTo(1, 6);
  });

  test("the same failure with different addresses and numbers still matches", () => {
    const a = embedText("connect ECONNREFUSED 10.0.3.7:443 after 5000 ms");
    const b = embedText("connect ECONNREFUSED 192.168.9.1:8443 after 31 ms");
    expect(cosine(a, b)).toBeGreaterThan(0.95);
  });

  test("close wording scores above the bar and different failures below it", () => {
    const base = embedText("http timeout Request timed out after 10s waiting for response");
    const close = embedText("http timeout The request timed out waiting for the response");
    const other = embedText("tls certificate has expired http 526");
    expect(cosine(base, close)).toBeGreaterThan(MIN_SIMILARITY);
    expect(cosine(base, other)).toBeLessThan(MIN_SIMILARITY);
  });

  test("empty text gives a zero vector instead of NaN", () => {
    expect(embedText("   ").every((x) => x === 0)).toBe(true);
  });

  test("normalizing removes what differs between occurrences", () => {
    expect(
      normalizeText("Error at 2026-10-23T10:00:00Z from 10.1.2.3 id 0123456789abcdef0123"),
    ).toBe("error at from id");
  });
});

const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run("similarIncidents (postgres + pgvector)", () => {
  const db = createDb(url);
  const { organizations, workspaces, monitors, monitorChecks, incidents, incidentEmbeddings } =
    schema;
  const orgId = `sim-org-${Date.now()}`;
  let ws = "";
  let otherWs = "";

  beforeAll(async () => {
    await db
      .insert(organizations)
      .values({ id: orgId, name: "t", slug: orgId, createdAt: new Date() });
    const made = await Promise.all(
      ["a", "b"].map(async (name) => {
        const [w] = await db
          .insert(workspaces)
          .values({ orgId, name })
          .returning({ id: workspaces.id });
        return w!.id;
      }),
    );
    ws = made[0]!;
    otherWs = made[1]!;
  });
  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  /** An incident on its own monitor (only one can be open per monitor) whose checks failed with this error. */
  async function incident(
    workspaceId: string,
    name: string,
    error: string,
    opts: {
      resolvedAfterMin?: number;
      kind?: "http" | "timeout" | "dns" | "tls";
      code?: number;
    } = {},
  ) {
    const created = new Date(Date.now() - 60 * 60_000);
    const [m] = await db
      .insert(monitors)
      .values({
        workspaceId,
        name,
        type: "http",
        target: `https://${name}.example.com`,
        interval: 60,
        active: true,
      })
      .returning({ id: monitors.id });
    await db.insert(monitorChecks).values(
      [1, 2, 3].map((n) => ({
        monitorId: m!.id,
        status: "down" as const,
        error,
        errorKind: opts.kind ?? ("http" as const),
        statusCode: opts.code ?? null,
        createdAt: new Date(created.getTime() + n * 60_000),
      })),
    );
    const [i] = await db
      .insert(incidents)
      .values({
        workspaceId,
        monitorId: m!.id,
        type: "uptime",
        status: opts.resolvedAfterMin ? "resolved" : "open",
        title: `${name} is down`,
        createdAt: created,
        resolvedAt: opts.resolvedAfterMin
          ? new Date(created.getTime() + opts.resolvedAfterMin * 60_000)
          : null,
      })
      .returning({ id: incidents.id });
    return i!.id;
  }

  test("finds earlier incidents that failed the same way, not ones that failed differently", async () => {
    const now = await incident(ws, "checkout", "connect ECONNREFUSED 10.0.0.5:443", {
      kind: "http",
    });
    const same = await incident(ws, "billing", "connect ECONNREFUSED 10.0.0.9:8443", {
      kind: "http",
      resolvedAfterMin: 12,
    });
    const different = await incident(ws, "docs", "certificate has expired", {
      kind: "tls",
      code: 526,
      resolvedAfterMin: 30,
    });

    const found = await similarIncidents(db, now);
    expect(found.map((f) => f.id)).toContain(same);
    expect(found.map((f) => f.id)).not.toContain(different);
    const hit = found.find((f) => f.id === same)!;
    expect(hit.similarity).toBeGreaterThan(0.9);
    expect(hit.monitorName).toBe("billing");
    expect(hit.status).toBe("resolved");
    expect(found.map((f) => f.id)).not.toContain(now);
  });

  test("never looks across workspaces", async () => {
    const mine = await incident(ws, "search", "read ECONNRESET by peer");
    const theirs = await incident(otherWs, "search", "read ECONNRESET by peer", {
      resolvedAfterMin: 5,
    });
    const found = await similarIncidents(db, mine);
    expect(found.map((f) => f.id)).not.toContain(theirs);
  });

  test("vectors are stored once, tagged with the model, and reused", async () => {
    const a = await incident(
      ws,
      "queue",
      "upstream connect error or disconnect/reset before headers",
    );
    const b = await incident(
      ws,
      "queue2",
      "upstream connect error or disconnect/reset before headers",
      {
        resolvedAfterMin: 3,
      },
    );
    await similarIncidents(db, a);
    await similarIncidents(db, a);
    const rows = await db
      .select()
      .from(incidentEmbeddings)
      .where(eq(incidentEmbeddings.workspaceId, ws));
    const ids = rows.map((r) => r.incidentId);
    expect(ids.filter((id) => id === a)).toHaveLength(1);
    expect(ids).toContain(b);
    expect(new Set(rows.map((r) => r.model))).toEqual(new Set(["hash-v1"]));
    expect(rows[0]!.embedding).toHaveLength(EMBEDDING_DIMENSIONS);
  });

  test("an incident that doesn't exist has no neighbours", async () => {
    expect(await similarIncidents(db, "00000000-0000-4000-8000-000000000000")).toEqual([]);
  });

  test("deleting an incident removes its vector", async () => {
    const x = await incident(ws, "tmp", "something unusual happened 42");
    await similarIncidents(db, x);
    await db.delete(incidents).where(eq(incidents.id, x));
    const left = await db
      .select()
      .from(incidentEmbeddings)
      .where(eq(incidentEmbeddings.incidentId, x));
    expect(left).toEqual([]);
  });
});
