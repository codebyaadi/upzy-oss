-- assets, scans and findings were unused placeholders before this migration. Clear them so the
-- NOT NULL columns added below can be created on a database that already has rows.
DELETE FROM "findings";--> statement-breakpoint
DELETE FROM "scans";--> statement-breakpoint
DELETE FROM "assets";--> statement-breakpoint
CREATE TYPE "public"."asset_kind" AS ENUM('domain', 'subdomain', 'url');--> statement-breakpoint
ALTER TABLE "findings" DROP CONSTRAINT "findings_scan_id_scans_id_fk";
--> statement-breakpoint
ALTER TABLE "findings" ALTER COLUMN "scan_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "findings" ALTER COLUMN "status" SET DEFAULT 'open';--> statement-breakpoint
ALTER TABLE "scans" ALTER COLUMN "status" SET DEFAULT 'queued';--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "kind" "asset_kind" NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "verification_token" text NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "next_scan_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "last_scan_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "asset_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "check_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "fingerprint" text NOT NULL;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "risk_score" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "remediation" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "evidence" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "first_seen" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "last_seen" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scans" ADD COLUMN "asset_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "scans" ADD COLUMN "checks" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scans" ADD CONSTRAINT "scans_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assets_workspace_kind_value_key" ON "assets" USING btree ("workspace_id","kind","value");--> statement-breakpoint
CREATE INDEX "assets_next_scan_idx" ON "assets" USING btree ("next_scan_at");--> statement-breakpoint
CREATE UNIQUE INDEX "findings_workspace_fingerprint_key" ON "findings" USING btree ("workspace_id","fingerprint");--> statement-breakpoint
CREATE INDEX "findings_workspace_status_risk_idx" ON "findings" USING btree ("workspace_id","status","risk_score" desc);--> statement-breakpoint
CREATE INDEX "scans_asset_idx" ON "scans" USING btree ("asset_id","started_at");--> statement-breakpoint
ALTER TABLE "assets" DROP COLUMN "type";--> statement-breakpoint
ALTER TABLE "assets" DROP COLUMN "meta";--> statement-breakpoint
ALTER TABLE "assets" DROP COLUMN "first_seen";--> statement-breakpoint
ALTER TABLE "assets" DROP COLUMN "last_seen";--> statement-breakpoint
ALTER TABLE "scans" DROP COLUMN "name";--> statement-breakpoint
ALTER TABLE "scans" DROP COLUMN "type";--> statement-breakpoint
DROP TYPE "public"."scan_type";