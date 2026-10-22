CREATE TABLE "asset_health" (
	"asset_id" uuid NOT NULL,
	"day" text NOT NULL,
	"score" integer NOT NULL,
	"grade" text NOT NULL,
	"categories" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_health_asset_id_day_pk" PRIMARY KEY("asset_id","day")
);
--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "stack" jsonb;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "verify_status" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "verify_error" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "last_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "asset_health" ADD CONSTRAINT "asset_health_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;