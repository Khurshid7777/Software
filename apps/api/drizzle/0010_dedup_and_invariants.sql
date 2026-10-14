-- Duplicate-description check at publication: the `%` operator can use this index (similarity() alone cannot).
CREATE INDEX IF NOT EXISTS "listings_description_trgm_idx" ON "listings" USING gin ((coalesce(nullif("description_ru", ''), "description_uz")) gin_trgm_ops);--> statement-breakpoint
-- Already created by 0003 (raw SQL); now declared in schema.ts as well, so IF NOT EXISTS.
CREATE UNIQUE INDEX IF NOT EXISTS "orders_one_open_per_buyer_uq" ON "orders" USING btree ("listing_id","buyer_user_id") WHERE "orders"."status" in ('new', 'confirmed', 'courier_assigned', 'picked_up');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "orders_one_reservation_per_listing_uq" ON "orders" USING btree ("listing_id") WHERE "orders"."status" in ('confirmed', 'courier_assigned', 'picked_up');
