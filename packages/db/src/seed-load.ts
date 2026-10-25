/**
 * Fills a LOCAL database with a realistic monitoring load, to measure the dashboard and the check pipeline against.
 * Unlike seed.ts it deletes nothing except its own previous run.
 *
 *   bun --env-file=../../.env src/seed-load.ts [--monitors 300] [--days 90] [--interval 60] [--owner you@example.com]
 *   bun --env-file=../../.env src/seed-load.ts --clean
 *
 * The defaults are an Agency organization at its limit: 300 monitors checked every 60 seconds for 90 days, which is
 * about 39 million rows. Expect 10 to 25 minutes and about 6 GB on a laptop; use `--days 7` for a quick run
 * (about 3 million rows, under a minute). The monitors are created inactive and point at `.test` addresses, so the
 * scheduler never sends a request anywhere. `--owner` makes an existing account the owner of the load organization,
 * so the dashboard and API can be used as that person.
 */
import { eq, sql } from "drizzle-orm";

import { createDb } from "./drizzle";
import { members, monitors, organizations, users, workspaces } from "./schema";

const ORG_ID = "load-test-org";
const ORG_SLUG = "load-test";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const db = createDb();

async function clean() {
  // Monitors, checks and workspaces go with the organization (cascade).
  await db.delete(organizations).where(eq(organizations.id, ORG_ID));
  console.log("Removed the load-test organization and everything under it.");
}

async function main() {
  if (process.argv.includes("--clean")) return clean();

  const count = Number(arg("monitors", "300"));
  const days = Number(arg("days", "90"));
  const interval = Number(arg("interval", "60"));
  const owner = arg("owner", "");
  if (![count, days, interval].every((n) => Number.isInteger(n) && n > 0))
    throw new Error("--monitors, --days and --interval must be positive whole numbers");

  await clean();
  await db
    .insert(organizations)
    .values({ id: ORG_ID, name: "Load test", slug: ORG_SLUG, createdAt: new Date() });
  const [workspace] = await db
    .insert(workspaces)
    .values({ name: "Load test", orgId: ORG_ID })
    .returning({ id: workspaces.id });

  if (owner) {
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, owner));
    if (!user) throw new Error(`No account with the email ${owner}. Sign up first, then re-run.`);
    await db
      .insert(members)
      .values({
        id: "load-test-member",
        organizationId: ORG_ID,
        userId: user.id,
        role: "owner",
        createdAt: new Date(),
      })
      .onConflictDoNothing();
  }

  await db.insert(monitors).values(
    Array.from({ length: count }, (_, n) => ({
      workspaceId: workspace!.id,
      name: `Load ${String(n + 1).padStart(3, "0")}`,
      type: "http" as const,
      target: `https://load-${n + 1}.example.test/health`,
      interval,
      active: false,
      lastStatus: "up" as const,
    })),
  );

  const ids = (
    await db
      .select({ id: monitors.id })
      .from(monitors)
      .where(eq(monitors.workspaceId, workspace!.id))
  ).map((m) => m.id);

  const perMonitor = Math.floor((days * 86_400) / interval);
  console.log(
    `Creating ${ids.length} monitors with ${perMonitor} checks each (${(ids.length * perMonitor).toLocaleString()} rows)...`,
  );
  const started = performance.now();
  const BATCH = 10;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    // Mostly up, a little latency noise with a slow tail, and about one failure in 500 (in runs of a few checks,
    // so incidents look real). Each monitor gets its own typical latency.
    await db.execute(sql`
      insert into monitor_checks (monitor_id, status, response_ms, created_at, status_code, ttfb_ms, tls_days_left, error)
      select m.id,
             case when f.failing then 'down'::check_status else 'up'::check_status end,
             case when f.failing then null
                  else (m.base + (random() * 60)::int + case when random() < 0.02 then (random() * 1500)::int else 0 end) end,
             now() - (g.n * ${interval} * interval '1 second'),
             case when f.failing then 503 else 200 end,
             case when f.failing then null else (m.base / 3 + (random() * 20)::int) end,
             60,
             case when f.failing then 'HTTP 503' else null end
      from (select unnest(${sql.raw(`array[${batch.map((b) => `'${b}'::uuid`).join(",")}]`)}) as id,
                   (60 + random() * 240)::int as base) m
      cross join generate_series(0, ${perMonitor - 1}) as g(n)
      cross join lateral (select (g.n / 4) % 500 = (abs(hashtext(m.id::text)) % 500) as failing) f`);
    const done = Math.min(i + BATCH, ids.length);
    const secs = (performance.now() - started) / 1000;
    console.log(
      `  ${done}/${ids.length} monitors, ${Math.round(secs)}s elapsed, about ${Math.round((secs / done) * (ids.length - done))}s left`,
    );
  }

  console.log("Updating table statistics...");
  await db.execute(sql`analyze monitor_checks`);
  await db.execute(sql`analyze monitors`);
  const [{ n }] = (await db.execute(
    sql`select count(*) as n from monitor_checks where monitor_id = any (${sql.raw(`array[${ids.map((b) => `'${b}'::uuid`).join(",")}]`)})`,
  )) as unknown as [{ n: string }];
  console.log(
    `Done in ${Math.round((performance.now() - started) / 1000)}s: ${Number(n).toLocaleString()} checks.` +
      (owner ? ` ${owner} owns the "Load test" organization.` : ""),
  );
}

main()
  .catch((e) => {
    console.error("Load seed error:", e);
    process.exit(1);
  })
  .finally(() => process.exit(0));
