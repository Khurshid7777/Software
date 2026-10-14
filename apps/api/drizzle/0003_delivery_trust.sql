CREATE TABLE "complaints" (
	"id" serial PRIMARY KEY NOT NULL,
	"listing_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"text" text,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "courier_tariffs" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"from_district" text,
	"to_district" text,
	"price" bigint NOT NULL,
	"cod_fee_pct" numeric(5, 2) DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"status" text NOT NULL,
	"actor_user_id" uuid,
	"actor" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"buyer_user_id" uuid NOT NULL,
	"seller_user_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"district" text NOT NULL,
	"address" text NOT NULL,
	"comment" text,
	"quote" jsonb NOT NULL,
	"fee_payer" text NOT NULL,
	"provider" text DEFAULT 'manual' NOT NULL,
	"external_id" text,
	"courier_name" text,
	"courier_phone" text,
	"cancel_reason" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"listing_id" uuid,
	"seller_user_id" uuid NOT NULL,
	"buyer_user_id" uuid,
	"rating" integer NOT NULL,
	"text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_order_id_unique" UNIQUE("order_id")
);
--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "moderation" jsonb;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "expiry_reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_buyer_user_id_users_id_fk" FOREIGN KEY ("buyer_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_seller_user_id_users_id_fk" FOREIGN KEY ("seller_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_seller_user_id_users_id_fk" FOREIGN KEY ("seller_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_buyer_user_id_users_id_fk" FOREIGN KEY ("buyer_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "complaints_listing_user_uq" ON "complaints" USING btree ("listing_id","user_id");--> statement-breakpoint
CREATE INDEX "complaints_user_created_idx" ON "complaints" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "order_events_order_idx" ON "order_events" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "orders_buyer_idx" ON "orders" USING btree ("buyer_user_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_seller_idx" ON "orders" USING btree ("seller_user_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_listing_status_idx" ON "orders" USING btree ("listing_id","status");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "reviews_seller_idx" ON "reviews" USING btree ("seller_user_id","created_at");--> statement-breakpoint
CREATE INDEX "listings_status_expires_idx" ON "listings" USING btree ("status","expires_at");--> statement-breakpoint
-- Race-safe invariants: one open order per buyer and listing, one reservation (confirmed order) per listing.
CREATE UNIQUE INDEX "orders_one_open_per_buyer_uq" ON "orders" ("listing_id", "buyer_user_id") WHERE "status" IN ('new', 'confirmed', 'courier_assigned', 'picked_up');--> statement-breakpoint
CREATE UNIQUE INDEX "orders_one_reservation_per_listing_uq" ON "orders" ("listing_id") WHERE "status" IN ('confirmed', 'courier_assigned', 'picked_up');
