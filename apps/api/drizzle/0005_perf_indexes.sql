-- Foreign keys used in lookups and cascades without a leading index (found with pg_constraint).
CREATE INDEX IF NOT EXISTS "conversation_messages_conversation_idx" ON "conversation_messages" ("conversation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_seller_idx" ON "conversations" ("seller_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_listing_idx" ON "conversations" ("listing_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "favorites_listing_idx" ON "favorites" ("listing_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_notifications_listing_idx" ON "search_notifications" ("listing_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_user_name_created_idx" ON "events" ("user_id", "name", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_created_idx" ON "events" ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channels_user_idx" ON "channels" ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "listings_shop_idx" ON "listings" ("shop_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reviews_listing_idx" ON "reviews" ("listing_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "complaints_listing_idx" ON "complaints" ("listing_id") WHERE "resolved_at" IS NULL;--> statement-breakpoint
-- Catalog sorted by price among live listings.
CREATE INDEX IF NOT EXISTS "listings_active_price_idx" ON "listings" ("price") WHERE "status" = 'active';--> statement-breakpoint
-- Platform sales per seller (trust level, seller card).
CREATE INDEX IF NOT EXISTS "listings_seller_sold_platform_idx" ON "listings" ("seller_user_id") WHERE "sold_via" = 'platform';
