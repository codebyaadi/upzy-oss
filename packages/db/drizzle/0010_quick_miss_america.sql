CREATE TABLE "ai_credentials" (
	"organization_id" text NOT NULL,
	"provider" text NOT NULL,
	"encrypted_key" text NOT NULL,
	"key_hint" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "ai_credentials_organization_id_provider_pk" PRIMARY KEY("organization_id","provider")
);
--> statement-breakpoint
ALTER TABLE "ai_settings" ADD COLUMN "key_source" text DEFAULT 'platform' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_settings" ADD COLUMN "fast_model" text;--> statement-breakpoint
ALTER TABLE "ai_settings" ADD COLUMN "smart_model" text;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "cost_micros" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "unpriced_requests" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_credentials" ADD CONSTRAINT "ai_credentials_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_credentials" ADD CONSTRAINT "ai_credentials_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;