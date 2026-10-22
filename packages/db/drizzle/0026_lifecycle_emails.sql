CREATE TABLE "lifecycle_emails" (
	"subject" text NOT NULL,
	"kind" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lifecycle_emails_subject_kind_pk" PRIMARY KEY("subject","kind")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "lifecycle_emails" boolean DEFAULT true NOT NULL;