CREATE TABLE "offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"buyer_user_id" uuid NOT NULL,
	"seller_user_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"list_price" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "previous_price" bigint;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "price_dropped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "imei" text;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_buyer_user_id_users_id_fk" FOREIGN KEY ("buyer_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_seller_user_id_users_id_fk" FOREIGN KEY ("seller_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "offers_listing_buyer_idx" ON "offers" USING btree ("listing_id","buyer_user_id","created_at");--> statement-breakpoint
CREATE INDEX "offers_seller_idx" ON "offers" USING btree ("seller_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "offers_one_pending_idx" ON "offers" USING btree ("listing_id","buyer_user_id") WHERE "offers"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "conversations_seller_created_idx" ON "conversations" USING btree ("seller_user_id","created_at");--> statement-breakpoint
CREATE INDEX "listings_imei_idx" ON "listings" USING btree ("imei") WHERE "listings"."imei" is not null;