ALTER TABLE "status_pages" ADD COLUMN "custom_domain" text;--> statement-breakpoint
ALTER TABLE "status_pages" ADD COLUMN "domain_token" text;--> statement-breakpoint
ALTER TABLE "status_pages" ADD COLUMN "domain_verified_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "status_pages_verified_domain_key" ON "status_pages" USING btree ("custom_domain") WHERE "status_pages"."domain_verified_at" is not null;