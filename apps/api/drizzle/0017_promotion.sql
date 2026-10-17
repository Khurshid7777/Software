CREATE TABLE "promotions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"plan" text NOT NULL,
	"days" integer NOT NULL,
	"stars" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"charge_id" text,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"refunded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promotions_charge_id_unique" UNIQUE("charge_id")
);
--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "promoted_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "promotions_listing_idx" ON "promotions" USING btree ("listing_id");