ALTER TABLE "audit_logs" ADD COLUMN "status" integer;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "ip" text;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "user_agent" text;--> statement-breakpoint
CREATE INDEX "audit_logs_org_created_idx" ON "audit_logs" USING btree ("organization_id","created_at" DESC NULLS LAST);