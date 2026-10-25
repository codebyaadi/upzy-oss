CREATE TABLE "asset_components" (
	"asset_id" uuid NOT NULL,
	"product" text NOT NULL,
	"version" text NOT NULL,
	"display" text NOT NULL,
	"detected_from" text NOT NULL,
	"lookup" jsonb NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_components_asset_id_product_version_pk" PRIMARY KEY("asset_id","product","version")
);
--> statement-breakpoint
ALTER TABLE "asset_components" ADD CONSTRAINT "asset_components_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_components_product_idx" ON "asset_components" USING btree ("product");