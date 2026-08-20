DROP INDEX "idx_sessions_status_reminder";--> statement-breakpoint
CREATE INDEX "idx_sessions_status_reminder" ON "sessions" USING btree ("status","reminder_at");