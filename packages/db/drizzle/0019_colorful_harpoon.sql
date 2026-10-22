CREATE TABLE "status_subscribers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"page_id" uuid NOT NULL,
	"email" text NOT NULL,
	"token" text NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirmation_sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "status_subscribers" ADD CONSTRAINT "status_subscribers_page_id_status_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."status_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "status_subscribers_page_email_key" ON "status_subscribers" USING btree ("page_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "status_subscribers_token_key" ON "status_subscribers" USING btree ("token");