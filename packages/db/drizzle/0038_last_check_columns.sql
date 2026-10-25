ALTER TABLE "monitors" ADD COLUMN "last_response_ms" integer;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "last_tls_days_left" integer;
--> statement-breakpoint
-- Backfill from the latest stored checks. The certificate's days-left only looks back two weeks: a check that sees a
-- certificate refreshes it on every run, so anything older is stale anyway.
UPDATE "monitors" m SET
  last_response_ms = (SELECT response_ms FROM monitor_checks c WHERE c.monitor_id = m.id ORDER BY created_at DESC LIMIT 1),
  last_tls_days_left = (SELECT tls_days_left FROM monitor_checks c
                        WHERE c.monitor_id = m.id AND tls_days_left IS NOT NULL AND created_at > now() - interval '14 days'
                        ORDER BY created_at DESC LIMIT 1);
--> statement-breakpoint
-- The hot tables are updated on every check. Leaving room in each page lets those updates stay in the page (no index
-- changes), and vacuuming earlier keeps dead rows from piling up between runs.
ALTER TABLE "monitors" SET (fillfactor = 80, autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.05);
--> statement-breakpoint
ALTER TABLE "jobs" SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.05);
--> statement-breakpoint
ALTER TABLE "monitor_region_state" SET (fillfactor = 80, autovacuum_vacuum_scale_factor = 0.02);
