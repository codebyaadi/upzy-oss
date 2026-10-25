CREATE TABLE "monitor_check_rollups" (
	"monitor_id" uuid NOT NULL,
	"region" text DEFAULT '' NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"total" integer NOT NULL,
	"up" integer NOT NULL,
	"degraded" integer DEFAULT 0 NOT NULL,
	"sum_ms" bigint DEFAULT 0 NOT NULL,
	"ms_count" integer DEFAULT 0 NOT NULL,
	"min_ms" integer,
	"max_ms" integer,
	"latency_hist" integer[] DEFAULT '{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}'::integer[] NOT NULL,
	CONSTRAINT "monitor_check_rollups_monitor_id_region_bucket_start_pk" PRIMARY KEY("monitor_id","region","bucket_start")
);
--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "last_check_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "monitor_check_rollups" ADD CONSTRAINT "monitor_check_rollups_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "monitor_check_rollups_bucket_start_idx" ON "monitor_check_rollups" USING btree ("bucket_start");

--> statement-breakpoint
-- Backfill: count the checks already stored into their buckets, and the last check time into each monitor. The
-- migration runs before the API and workers start, so nothing writes checks meanwhile. On a very large table this
-- takes a few minutes (about 3 million checks every 20 seconds).
INSERT INTO "monitor_check_rollups"
  (monitor_id, region, bucket_start, total, up, degraded, sum_ms, ms_count, min_ms, max_ms, latency_hist)
SELECT monitor_id,
       coalesce(region, ''),
       date_bin('5 minutes', created_at, timestamptz '2000-01-01 00:00:00+00'),
       count(*)::int,
       count(*) FILTER (WHERE status = 'up')::int,
       count(*) FILTER (WHERE status = 'degraded')::int,
       coalesce(sum(response_ms), 0),
       count(response_ms)::int,
       min(response_ms),
       max(response_ms),
       ARRAY[
      count(*) filter (where response_ms < 25)::int,
      count(*) filter (where response_ms >= 25 and response_ms < 50)::int,
      count(*) filter (where response_ms >= 50 and response_ms < 75)::int,
      count(*) filter (where response_ms >= 75 and response_ms < 100)::int,
      count(*) filter (where response_ms >= 100 and response_ms < 150)::int,
      count(*) filter (where response_ms >= 150 and response_ms < 200)::int,
      count(*) filter (where response_ms >= 200 and response_ms < 300)::int,
      count(*) filter (where response_ms >= 300 and response_ms < 400)::int,
      count(*) filter (where response_ms >= 400 and response_ms < 500)::int,
      count(*) filter (where response_ms >= 500 and response_ms < 750)::int,
      count(*) filter (where response_ms >= 750 and response_ms < 1000)::int,
      count(*) filter (where response_ms >= 1000 and response_ms < 1500)::int,
      count(*) filter (where response_ms >= 1500 and response_ms < 2000)::int,
      count(*) filter (where response_ms >= 2000 and response_ms < 3000)::int,
      count(*) filter (where response_ms >= 3000 and response_ms < 5000)::int,
      count(*) filter (where response_ms >= 5000)::int
       ]
FROM monitor_checks
GROUP BY 1, 2, 3
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "monitors" m SET last_check_at = c.last
FROM (SELECT monitor_id, max(created_at) AS last FROM monitor_checks GROUP BY monitor_id) c
WHERE c.monitor_id = m.id;
