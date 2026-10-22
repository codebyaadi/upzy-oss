ALTER TABLE "incidents" ADD COLUMN "ai_triage" jsonb;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "ai_triaged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "ai_triage_status" text;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "ai_triage_error" text;