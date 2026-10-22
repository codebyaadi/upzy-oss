CREATE TABLE "postmortems" (
	"incident_id" uuid PRIMARY KEY NOT NULL,
	"content" jsonb,
	"ai_generated" boolean DEFAULT false NOT NULL,
	"model" text,
	"status" text,
	"error" text,
	"edited_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "postmortems" ADD CONSTRAINT "postmortems_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "postmortems" ADD CONSTRAINT "postmortems_edited_by_users_id_fk" FOREIGN KEY ("edited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;