CREATE TABLE "scan_provenance" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"scan_id" uuid,
	"scanner_id" uuid,
	"engine" text NOT NULL,
	"engine_version" text,
	"template_set" text,
	"templates_run" integer DEFAULT 0 NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"rate_limit_per_second" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"findings" integer DEFAULT 0 NOT NULL,
	"error" text,
	"templates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "probe_agents" ADD COLUMN "kind" text DEFAULT 'probe' NOT NULL;--> statement-breakpoint
ALTER TABLE "scan_provenance" ADD CONSTRAINT "scan_provenance_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_provenance" ADD CONSTRAINT "scan_provenance_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_provenance" ADD CONSTRAINT "scan_provenance_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scan_provenance_asset_idx" ON "scan_provenance" USING btree ("asset_id","created_at" DESC NULLS LAST);