CREATE TABLE "monitor_region_state" (
	"monitor_id" uuid NOT NULL,
	"region" text NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_status" "check_status" DEFAULT 'unknown' NOT NULL,
	"last_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monitor_region_state_monitor_id_region_pk" PRIMARY KEY("monitor_id","region")
);
--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "regions" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor_region_state" ADD CONSTRAINT "monitor_region_state_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;