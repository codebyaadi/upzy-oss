CREATE TYPE "public"."discovery_status" AS ENUM('new', 'accepted', 'dismissed');--> statement-breakpoint
CREATE TABLE "discovered_hosts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"parent_asset_id" uuid NOT NULL,
	"host" text NOT NULL,
	"status" "discovery_status" DEFAULT 'new' NOT NULL,
	"resolves" boolean,
	"source" text NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "next_discovery_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "last_discovery_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "discovery_error" text;--> statement-breakpoint
ALTER TABLE "discovered_hosts" ADD CONSTRAINT "discovered_hosts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovered_hosts" ADD CONSTRAINT "discovered_hosts_parent_asset_id_assets_id_fk" FOREIGN KEY ("parent_asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "discovered_hosts_workspace_host_key" ON "discovered_hosts" USING btree ("workspace_id","host");--> statement-breakpoint
CREATE INDEX "discovered_hosts_parent_idx" ON "discovered_hosts" USING btree ("parent_asset_id","status");--> statement-breakpoint
CREATE INDEX "assets_next_discovery_idx" ON "assets" USING btree ("next_discovery_at");