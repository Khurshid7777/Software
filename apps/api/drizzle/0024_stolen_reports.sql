CREATE TABLE "stolen_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"imei" text NOT NULL,
	"kind" text NOT NULL,
	"police_report" text,
	"withdrawn_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stolen_reports" ADD CONSTRAINT "stolen_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stolen_reports_open_uq" ON "stolen_reports" USING btree ("user_id","imei") WHERE "stolen_reports"."withdrawn_at" is null;--> statement-breakpoint
CREATE INDEX "stolen_reports_imei_idx" ON "stolen_reports" USING btree ("imei") WHERE "stolen_reports"."withdrawn_at" is null;