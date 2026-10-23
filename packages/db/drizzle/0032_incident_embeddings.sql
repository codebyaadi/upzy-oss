CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "incident_embeddings" (
	"incident_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"model" text NOT NULL,
	"embedding" vector(384) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "incident_embeddings" ADD CONSTRAINT "incident_embeddings_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_embeddings" ADD CONSTRAINT "incident_embeddings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "incident_embeddings_workspace_idx" ON "incident_embeddings" USING btree ("workspace_id","model");