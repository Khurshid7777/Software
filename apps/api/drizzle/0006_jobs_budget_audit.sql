CREATE TABLE "admin_audit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_user_id" uuid,
	"actor_telegram_id" bigint,
	"action" text NOT NULL,
	"target" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_budget" (
	"month" text NOT NULL,
	"tier" text NOT NULL,
	"spent_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ai_budget_month_tier_pk" PRIMARY KEY("month","tier")
);
--> statement-breakpoint
CREATE TABLE "bot_pending_replies" (
	"telegram_user_id" bigint PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"done_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_audit" ADD CONSTRAINT "admin_audit_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_pending_replies" ADD CONSTRAINT "bot_pending_replies_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_audit_created_idx" ON "admin_audit" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "jobs_due_idx" ON "jobs" USING btree ("run_at") WHERE "jobs"."done_at" is null;--> statement-breakpoint
-- Backfill the running counter from the call log (strong tier = Opus models, the default AI_MODEL_STRONG).
INSERT INTO "ai_budget" ("month", "tier", "spent_usd", "calls")
SELECT to_char("created_at" at time zone 'UTC', 'YYYY-MM'), CASE WHEN "model" ILIKE '%opus%' THEN 'strong' ELSE 'fast' END,
       sum("cost_usd"), count(*)
FROM "ai_usage" GROUP BY 1, 2
ON CONFLICT DO NOTHING;
