DROP INDEX "sessions_week_key_postpone_count_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_candidate_date_unique" ON "sessions" USING btree ("candidate_date_iso") WHERE "sessions"."occupies_date";--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_active_unique" ON "sessions" USING btree ((true)) WHERE "sessions"."status" IN ('ASKING','POSTPONE_VOTING','DECIDED','CANCELLED');--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_weekly_auto_unique" ON "sessions" USING btree ("week_key") WHERE "sessions"."source" = 'weekly_auto';