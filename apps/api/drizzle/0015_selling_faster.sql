ALTER TABLE "listings" ADD COLUMN "auto_drop_floor" bigint;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "auto_drop_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "likers_offer_price" bigint;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "likers_offer_at" timestamp with time zone;