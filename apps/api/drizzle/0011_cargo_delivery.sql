ALTER TABLE "courier_tariffs" ADD COLUMN "vehicle" text DEFAULT 'courier' NOT NULL;--> statement-breakpoint
ALTER TABLE "courier_tariffs" ADD COLUMN "lift_per_floor" bigint DEFAULT 0 NOT NULL;