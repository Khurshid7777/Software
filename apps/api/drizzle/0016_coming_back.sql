CREATE TABLE "follows" (
	"follower_user_id" uuid NOT NULL,
	"seller_user_id" uuid NOT NULL,
	"last_notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follows_follower_user_id_seller_user_id_pk" PRIMARY KEY("follower_user_id","seller_user_id")
);
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "bundle2_pct" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "bundle3_pct" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_follower_user_id_users_id_fk" FOREIGN KEY ("follower_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_seller_user_id_users_id_fk" FOREIGN KEY ("seller_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "follows_seller_idx" ON "follows" USING btree ("seller_user_id");