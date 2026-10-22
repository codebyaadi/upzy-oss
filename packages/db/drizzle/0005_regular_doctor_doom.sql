DROP INDEX "deliveries_once";--> statement-breakpoint
ALTER TABLE "notification_deliveries" ALTER COLUMN "incident_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "finding_id" uuid;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "occurrence" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_once" ON "notification_deliveries" USING btree (coalesce("incident_id", "finding_id"),"channel_id","event","occurrence");