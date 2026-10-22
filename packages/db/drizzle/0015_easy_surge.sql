ALTER TABLE "discovered_hosts" ADD COLUMN "profile" jsonb;--> statement-breakpoint
ALTER TABLE "discovered_hosts" ADD COLUMN "ai_classification" jsonb;--> statement-breakpoint
ALTER TABLE "discovered_hosts" ADD COLUMN "ai_classified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "discovered_hosts" ADD COLUMN "ai_status" text;--> statement-breakpoint
ALTER TABLE "discovered_hosts" ADD COLUMN "ai_error" text;