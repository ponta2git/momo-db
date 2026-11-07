CREATE TABLE "weekly_ask_schedules" (
	"week_key" text PRIMARY KEY NOT NULL,
	"auto_session_id" uuid,
	"disabled_at" timestamp with time zone,
	"disabled_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weekly_ask_schedules_auto_session_id_unique" UNIQUE("auto_session_id"),
	CONSTRAINT "weekly_ask_schedules_outcome_check" CHECK ("weekly_ask_schedules"."auto_session_id" IS NULL OR "weekly_ask_schedules"."disabled_at" IS NULL),
	CONSTRAINT "weekly_ask_schedules_actor_check" CHECK ("weekly_ask_schedules"."disabled_by" IS NULL OR "weekly_ask_schedules"."disabled_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "discord_notification_attendance" ADD COLUMN "week_key" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "source" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "parent_session_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "request_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "occupies_date" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "weekly_ask_schedules" ADD CONSTRAINT "weekly_ask_schedules_auto_session_id_sessions_id_fk" FOREIGN KEY ("auto_session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_notification_attendance" ADD CONSTRAINT "discord_attendance_week_fk" FOREIGN KEY ("week_key") REFERENCES "public"."weekly_ask_schedules"("week_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_parent_session_id_sessions_id_fk" FOREIGN KEY ("parent_session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "discord_attendance_week_order_unique" ON "discord_notification_attendance" USING btree ("week_key","aggregate_revision","ordinal");--> statement-breakpoint
CREATE INDEX "sessions_week_key_idx" ON "sessions" USING btree ("week_key");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_parent_session_id_unique" UNIQUE("parent_session_id");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_request_id_unique" UNIQUE("request_id");--> statement-breakpoint
ALTER TABLE "discord_notification_attendance" ADD CONSTRAINT "discord_attendance_owner_check" CHECK ("discord_notification_attendance"."session_id" IS NULL OR "discord_notification_attendance"."week_key" IS NULL);--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_source_check" CHECK ("sessions"."source" IN ('manual','weekly_auto','postponed','legacy'));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_origin_check" CHECK ("sessions"."source" = 'legacy' OR
      ("sessions"."source" IN ('manual','weekly_auto') AND "sessions"."postpone_count" = 0 AND "sessions"."parent_session_id" IS NULL) OR
      ("sessions"."source" = 'postponed' AND "sessions"."postpone_count" = 1 AND "sessions"."parent_session_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_date_occupancy_check" CHECK ("sessions"."occupies_date" OR ("sessions"."source" = 'legacy' AND "sessions"."status" = 'SKIPPED'));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_parent_not_self_check" CHECK ("sessions"."parent_session_id" IS NULL OR "sessions"."parent_session_id" <> "sessions"."id");