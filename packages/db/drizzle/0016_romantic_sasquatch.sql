CREATE TABLE "status_page_monitors" (
	"page_id" uuid NOT NULL,
	"monitor_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "status_page_monitors_page_id_monitor_id_pk" PRIMARY KEY("page_id","monitor_id")
);
--> statement-breakpoint
CREATE TABLE "status_pages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"notice" text DEFAULT '' NOT NULL,
	"notice_kind" text DEFAULT 'info' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "status_page_monitors" ADD CONSTRAINT "status_page_monitors_page_id_status_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."status_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_page_monitors" ADD CONSTRAINT "status_page_monitors_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_pages" ADD CONSTRAINT "status_pages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "status_pages_slug_key" ON "status_pages" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "status_pages_workspace_idx" ON "status_pages" USING btree ("workspace_id");