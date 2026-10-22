CREATE TABLE "incident_groups" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"shared_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"summary" jsonb,
	"summary_at" timestamp with time zone,
	"summary_status" text,
	"summary_error" text
);
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "correlation_keys" jsonb;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "incident_groups" ADD CONSTRAINT "incident_groups_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_group_id_incident_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."incident_groups"("id") ON DELETE set null ON UPDATE no action;