CREATE TABLE "ai_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"provider_policy" text DEFAULT 'groq_only' NOT NULL,
	"daily_token_budget" integer DEFAULT 200000 NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"organization_id" text NOT NULL,
	"day" date NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"feature" text NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ai_usage_organization_id_day_provider_model_feature_pk" PRIMARY KEY("organization_id","day","provider","model","feature")
);
--> statement-breakpoint
CREATE TABLE "digest_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"week_start" date NOT NULL,
	"recipients" integer DEFAULT 0 NOT NULL,
	"used_ai" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "ai_explanation" jsonb;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "ai_explained_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "ai_explain_status" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "ai_explain_error" text;--> statement-breakpoint
ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_runs" ADD CONSTRAINT "digest_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_org_day_idx" ON "ai_usage" USING btree ("organization_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "digest_runs_workspace_week_key" ON "digest_runs" USING btree ("workspace_id","week_start");