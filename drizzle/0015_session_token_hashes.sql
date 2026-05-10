DELETE FROM "app_sessions";--> statement-breakpoint
ALTER TABLE "app_sessions" RENAME COLUMN "id" TO "id_hash";--> statement-breakpoint
ALTER TABLE "app_sessions" RENAME COLUMN "csrf_secret" TO "csrf_secret_hash";
