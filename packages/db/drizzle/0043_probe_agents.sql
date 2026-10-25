CREATE TABLE "probe_agents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"region" text NOT NULL,
	"hashed_token" text NOT NULL,
	"prefix" text DEFAULT '' NOT NULL,
	"version" text,
	"platform" text,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "probe_agents_hashed_token_key" ON "probe_agents" USING btree ("hashed_token");