ALTER TYPE "public"."check_status" ADD VALUE 'degraded';--> statement-breakpoint
CREATE TABLE "maintenance_window_monitors" (
	"window_id" uuid NOT NULL,
	"monitor_id" uuid NOT NULL,
	CONSTRAINT "maintenance_window_monitors_window_id_monitor_id_pk" PRIMARY KEY("window_id","monitor_id")
);
--> statement-breakpoint
CREATE TABLE "maintenance_windows" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"all_monitors" boolean DEFAULT false NOT NULL,
	"show_on_status_page" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "consecutive_slow" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "maintenance_window_monitors" ADD CONSTRAINT "maintenance_window_monitors_window_id_maintenance_windows_id_fk" FOREIGN KEY ("window_id") REFERENCES "public"."maintenance_windows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_window_monitors" ADD CONSTRAINT "maintenance_window_monitors_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_windows" ADD CONSTRAINT "maintenance_windows_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "maintenance_window_monitors_monitor_id_idx" ON "maintenance_window_monitors" USING btree ("monitor_id");--> statement-breakpoint
CREATE INDEX "maintenance_windows_workspace_id_ends_at_idx" ON "maintenance_windows" USING btree ("workspace_id","ends_at");