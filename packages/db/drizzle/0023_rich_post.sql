ALTER TYPE "public"."error_kind" ADD VALUE 'assertion' BEFORE 'other';--> statement-breakpoint
ALTER TYPE "public"."error_kind" ADD VALUE 'heartbeat' BEFORE 'other';--> statement-breakpoint
ALTER TYPE "public"."monitor_type" ADD VALUE 'flow';--> statement-breakpoint
ALTER TYPE "public"."monitor_type" ADD VALUE 'heartbeat';--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "secrets_encrypted" text;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "heartbeat_token" text;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "last_ping_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "last_fail_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "heartbeat_since" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "monitors_heartbeat_token_key" ON "monitors" USING btree ("heartbeat_token") WHERE "monitors"."heartbeat_token" is not null;