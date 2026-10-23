ALTER TYPE "public"."channel_kind" ADD VALUE 'teams';--> statement-breakpoint
ALTER TYPE "public"."channel_kind" ADD VALUE 'pagerduty';--> statement-breakpoint
ALTER TYPE "public"."channel_kind" ADD VALUE 'opsgenie';--> statement-breakpoint
ALTER TYPE "public"."channel_kind" ADD VALUE 'github';--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "external_id" text;