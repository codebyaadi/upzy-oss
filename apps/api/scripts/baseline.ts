/**
 * Times the dashboard's heaviest endpoints against the load-test organization and prints the numbers as a Markdown
 * table, plus the most expensive statements from pg_stat_statements.
 *
 *   1. packages/db: bun run db:seed:load            (fills the database)
 *   2. bun --env-file=../../.env src/index.ts       (the API, in apps/api)
 *   3. apps/api:    bun --env-file=../../.env scripts/baseline.ts [--runs 20] [--api http://localhost:3000]
 *
 * It signs up (or signs in) load@example.test, makes that account the owner of the load organization and calls the
 * API as that person. Local databases only.
 */
import { createDb, schema } from "@upzy/db";
import { eq, sql } from "drizzle-orm";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const api = arg("api", process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(/\/$/, "");
const runs = Number(arg("runs", "20"));
const origin = process.env.WEB_ORIGIN ?? "http://localhost:3001";
const ORG_ID = "load-test-org";
const EMAIL = "load@example.test";
const PASSWORD = "load-test-password-123";

const db = createDb();
const { members, users, monitors, workspaces } = schema;

const headers = (cookie = "") => ({ "content-type": "application/json", origin, cookie });
const cookieOf = (r: Response) =>
  r.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

async function login(): Promise<string> {
  let r = await fetch(`${api}/api/auth/sign-up/email`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: "Load Test" }),
  });
  if (!r.ok)
    r = await fetch(`${api}/api/auth/sign-in/email`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
  if (!r.ok) throw new Error(`Could not sign in as ${EMAIL}: ${r.status} ${await r.text()}`);
  return cookieOf(r);
}

const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;

async function main() {
  const [org] = await db
    .select()
    .from(schema.organizations)
    .where(eq(schema.organizations.id, ORG_ID));
  if (!org)
    throw new Error("No load-test organization. Run `bun run db:seed:load` in packages/db first.");

  const cookie = await login();
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, EMAIL));
  await db
    .insert(members)
    .values({
      id: "load-test-baseline-member",
      organizationId: ORG_ID,
      userId: user!.id,
      role: "owner",
      createdAt: new Date(),
    })
    .onConflictDoNothing();
  const active = await fetch(`${api}/api/auth/organization/set-active`, {
    method: "POST",
    headers: headers(cookie),
    body: JSON.stringify({ organizationId: ORG_ID }),
  });
  if (!active.ok) throw new Error(`set-active failed: ${active.status}`);

  const [first] = await db
    .select({ id: monitors.id })
    .from(monitors)
    .innerJoin(workspaces, eq(workspaces.id, monitors.workspaceId))
    .where(eq(workspaces.orgId, ORG_ID))
    .limit(1);
  const id = first!.id;
  const [{ n }] = (await db.execute(
    sql`select count(*) as n from monitor_checks mc join monitors m on m.id = mc.monitor_id join workspaces w on w.id = m.workspace_id where w.org_id = ${ORG_ID}`,
  )) as unknown as [{ n: string }];

  const cases: [string, string][] = [
    ["GET /monitor (list, all monitors)", "/monitor"],
    ["GET /overview", "/overview"],
    ["GET /monitor/:id/stats?range=24h", `/monitor/${id}/stats?range=24h`],
    ["GET /monitor/:id/stats?range=7d", `/monitor/${id}/stats?range=7d`],
    ["GET /monitor/:id/stats?range=30d", `/monitor/${id}/stats?range=30d`],
    ["GET /monitor/:id/checks?limit=50", `/monitor/${id}/checks?limit=50`],
  ];

  await db.execute(sql`select pg_stat_statements_reset()`);
  const rows: string[] = [];
  for (const [label, path] of cases) {
    const times: number[] = [];
    let status = 0;
    for (let i = 0; i < runs + 1; i++) {
      const t = performance.now();
      const r = await fetch(`${api}${path}`, { headers: headers(cookie) });
      await r.arrayBuffer();
      status = r.status;
      if (i > 0) times.push(performance.now() - t); // the first call warms caches and plans
    }
    times.sort((a, b) => a - b);
    rows.push(
      `| ${label} | ${status} | ${Math.round(percentile(times, 0.5))} | ${Math.round(percentile(times, 0.95))} |`,
    );
  }

  const top = (await db.execute<{
    calls: string;
    total_ms: string;
    mean_ms: string;
    query: string;
  }>(sql`
    select calls::text, round(total_exec_time)::text as total_ms, round(mean_exec_time::numeric, 1)::text as mean_ms,
           left(regexp_replace(query, '[[:space:]]+', ' ', 'g'), 110) as query
    from pg_stat_statements
    where query not ilike '%pg_stat_statements%' and dbid = (select oid from pg_database where datname = current_database())
    order by total_exec_time desc limit 10`)) as unknown as {
    calls: string;
    total_ms: string;
    mean_ms: string;
    query: string;
  }[];

  console.log(
    `Checks in the load organization: ${Number(n).toLocaleString()}, ${runs} runs each\n`,
  );
  console.log("| Endpoint | Status | p50 ms | p95 ms |\n| --- | --- | --- | --- |");
  console.log(rows.join("\n"));
  console.log("\nTop statements by total time during those requests:\n");
  console.log("| Calls | Total ms | Mean ms | Statement |\n| --- | --- | --- | --- |");
  for (const r of [...top])
    console.log(
      `| ${r.calls} | ${r.total_ms} | ${r.mean_ms} | \`${r.query.replace(/\|/g, "\\|")}\` |`,
    );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => process.exit(0));
