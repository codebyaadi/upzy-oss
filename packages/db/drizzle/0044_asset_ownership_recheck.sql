ALTER TABLE "assets" ADD COLUMN "verify_next_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "verify_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "verification_lost_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "page_state" jsonb;