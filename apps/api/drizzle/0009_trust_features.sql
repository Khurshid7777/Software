ALTER TABLE "conversations" ADD COLUMN "suggestions" jsonb;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "checklist" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "verification" jsonb;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "bundle_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "inspection" jsonb;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "review_reminded_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "orders_bundle_idx" ON "orders" USING btree ("bundle_id") WHERE "orders"."bundle_id" is not null;