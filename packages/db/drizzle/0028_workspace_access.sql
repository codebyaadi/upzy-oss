CREATE TABLE "pending_workspace_access" (
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"workspace_id" uuid
);
--> statement-breakpoint
CREATE TABLE "restricted_members" (
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "restricted_members_organization_id_user_id_pk" PRIMARY KEY("organization_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "workspace_access" (
	"user_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	CONSTRAINT "workspace_access_user_id_workspace_id_pk" PRIMARY KEY("user_id","workspace_id")
);
--> statement-breakpoint
ALTER TABLE "pending_workspace_access" ADD CONSTRAINT "pending_workspace_access_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_workspace_access" ADD CONSTRAINT "pending_workspace_access_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restricted_members" ADD CONSTRAINT "restricted_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restricted_members" ADD CONSTRAINT "restricted_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_access" ADD CONSTRAINT "workspace_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_access" ADD CONSTRAINT "workspace_access_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pending_workspace_access_idx" ON "pending_workspace_access" USING btree ("organization_id","email");--> statement-breakpoint
CREATE INDEX "workspace_access_workspace_idx" ON "workspace_access" USING btree ("workspace_id");