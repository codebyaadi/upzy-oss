ALTER TABLE "api_keys" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "prefix" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "scopes" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hashed_key_key" ON "api_keys" USING btree ("hashed_key");--> statement-breakpoint
CREATE INDEX "api_keys_organization_idx" ON "api_keys" USING btree ("organization_id");