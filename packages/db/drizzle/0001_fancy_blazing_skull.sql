CREATE TYPE "public"."error_kind" AS ENUM('dns', 'timeout', 'tls', 'http', 'refused', 'blocked', 'other');--> statement-breakpoint
CREATE TYPE "public"."job_state" AS ENUM('queued', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"queue" text NOT NULL,
	"payload" jsonb NOT NULL,
	"state" "job_state" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"run_at" timestamp DEFAULT now() NOT NULL,
	"locked_at" timestamp,
	"last_error" text,
	"dedupe_key" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "monitor_id" uuid;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "title" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor_checks" ADD COLUMN "status_code" integer;--> statement-breakpoint
ALTER TABLE "monitor_checks" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "monitor_checks" ADD COLUMN "error_kind" "error_kind";--> statement-breakpoint
ALTER TABLE "monitor_checks" ADD COLUMN "ttfb_ms" integer;--> statement-breakpoint
ALTER TABLE "monitor_checks" ADD COLUMN "tls_days_left" integer;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "latency_threshold_ms" integer;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "failure_threshold" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("queue","state","run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_active_key" ON "jobs" USING btree ("queue","dedupe_key") WHERE "jobs"."state" in ('queued', 'running');--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_one_open_per_monitor" ON "incidents" USING btree ("monitor_id") WHERE "incidents"."status" <> 'resolved';