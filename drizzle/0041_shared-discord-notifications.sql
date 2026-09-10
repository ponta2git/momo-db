CREATE TABLE "discord_notification_attendance" (
	"notification_id" text PRIMARY KEY NOT NULL,
	"session_id" text,
	"aggregate_revision" bigint NOT NULL,
	"ordinal" smallint NOT NULL,
	CONSTRAINT "discord_notification_attendance_order_check" CHECK ("discord_notification_attendance"."aggregate_revision" >= 0 AND "discord_notification_attendance"."ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "discord_notification_parts" (
	"notification_id" text NOT NULL,
	"part_no" integer NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"claim_token" uuid,
	"send_started_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"delivered_message_id" text,
	CONSTRAINT "discord_notification_parts_pk" PRIMARY KEY("notification_id","part_no"),
	CONSTRAINT "discord_notification_parts_number_check" CHECK ("discord_notification_parts"."part_no" >= 0 AND "discord_notification_parts"."attempt_count" >= 0),
	CONSTRAINT "discord_notification_parts_status_check" CHECK ("discord_notification_parts"."status" IN ('PENDING','IN_FLIGHT','DELIVERED','CANCELLED')),
	CONSTRAINT "discord_notification_parts_claim_check" CHECK ("discord_notification_parts"."status" <> 'IN_FLIGHT' OR ("discord_notification_parts"."claim_token" IS NOT NULL AND "discord_notification_parts"."send_started_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "discord_notification_results" (
	"notification_id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"source_job_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"settings_generation" bigint NOT NULL,
	CONSTRAINT "discord_notification_results_generation_check" CHECK ("discord_notification_results"."settings_generation" >= 0)
);
--> statement-breakpoint
CREATE TABLE "discord_notification_settings" (
	"kind" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"generation" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discord_notification_settings_kind_check" CHECK ("discord_notification_settings"."kind" IN ('ocr_completed','analysis_completed')),
	CONSTRAINT "discord_notification_settings_generation_check" CHECK ("discord_notification_settings"."generation" >= 0)
);
--> statement-breakpoint
CREATE TABLE "discord_notification_targets" (
	"notification_id" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text NOT NULL,
	CONSTRAINT "discord_notification_targets_pk" PRIMARY KEY("notification_id","target_kind","target_id"),
	CONSTRAINT "discord_notification_targets_kind_check" CHECK ("discord_notification_targets"."target_kind" IN ('match_draft','match'))
);
--> statement-breakpoint
CREATE TABLE "discord_notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"family" text NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"payload" jsonb,
	"payload_hash" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 10 NOT NULL,
	"retry_cycle" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"cancel_reason" text,
	"claim_token" uuid,
	"claim_expires_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"part_count" integer DEFAULT 0 NOT NULL,
	"renderer_version" integer,
	"delivered_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discord_notifications_kind_check" CHECK (("discord_notifications"."family" = 'attendance' AND "discord_notifications"."kind" = 'send_message') OR ("discord_notifications"."family" = 'result' AND "discord_notifications"."kind" IN ('ocr_completed','analysis_completed'))),
	CONSTRAINT "discord_notifications_status_check" CHECK ("discord_notifications"."status" IN ('PENDING','IN_FLIGHT','DELIVERED','FAILED','CANCELLED')),
	CONSTRAINT "discord_notifications_attempts_check" CHECK ("discord_notifications"."attempt_count" >= 0 AND "discord_notifications"."max_attempts" BETWEEN 1 AND 100 AND "discord_notifications"."retry_cycle" >= 0),
	CONSTRAINT "discord_notifications_version_check" CHECK ("discord_notifications"."schema_version" > 0),
	CONSTRAINT "discord_notifications_hash_check" CHECK ("discord_notifications"."payload_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "discord_notifications_claim_check" CHECK (("discord_notifications"."claim_token" IS NULL) = ("discord_notifications"."claim_expires_at" IS NULL) AND ("discord_notifications"."status" <> 'IN_FLIGHT' OR "discord_notifications"."claim_token" IS NOT NULL)),
	CONSTRAINT "discord_notifications_parts_check" CHECK (("discord_notifications"."part_count" = 0 AND "discord_notifications"."renderer_version" IS NULL) OR ("discord_notifications"."part_count" > 0 AND "discord_notifications"."renderer_version" > 0)),
	CONSTRAINT "discord_notifications_purge_check" CHECK (("discord_notifications"."payload" IS NOT NULL AND "discord_notifications"."purged_at" IS NULL) OR ("discord_notifications"."payload" IS NULL AND "discord_notifications"."purged_at" IS NOT NULL AND "discord_notifications"."status" IN ('DELIVERED','FAILED','CANCELLED') AND "discord_notifications"."claim_token" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "held_events" DROP CONSTRAINT "held_events_session_id_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "discord_notification_attendance" ADD CONSTRAINT "discord_notification_attendance_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_notification_attendance" ADD CONSTRAINT "discord_attendance_notification_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."discord_notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_notification_parts" ADD CONSTRAINT "discord_parts_notification_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."discord_notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_notification_results" ADD CONSTRAINT "discord_results_notification_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."discord_notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_notification_results" ADD CONSTRAINT "discord_results_settings_fk" FOREIGN KEY ("kind") REFERENCES "public"."discord_notification_settings"("kind") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_notification_targets" ADD CONSTRAINT "discord_targets_notification_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."discord_notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "discord_notification_attendance_order_unique" ON "discord_notification_attendance" USING btree ("session_id","aggregate_revision","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "discord_notification_results_job_unique" ON "discord_notification_results" USING btree ("kind","source_job_id");--> statement-breakpoint
CREATE INDEX "discord_notification_targets_lookup_idx" ON "discord_notification_targets" USING btree ("target_kind","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "discord_notifications_dedupe_unique" ON "discord_notifications" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "discord_notifications_dispatch_idx" ON "discord_notifications" USING btree ("family","status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "discord_notifications_claim_expiry_idx" ON "discord_notifications" USING btree ("claim_expires_at") WHERE "discord_notifications"."claim_token" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "discord_notifications_retention_idx" ON "discord_notifications" USING btree ("terminal_at") WHERE "discord_notifications"."purged_at" IS NULL AND "discord_notifications"."status" IN ('DELIVERED','FAILED','CANCELLED');--> statement-breakpoint
ALTER TABLE "held_events" ADD CONSTRAINT "held_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;