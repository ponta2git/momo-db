-- Take the existing release locks before generated DDL takes table locks.
-- All pending migrations must run in one transaction through the normal migrator.
SELECT pg_advisory_xact_lock(hashtext('momo-series-analysis-release'));--> statement-breakpoint
LOCK TABLE "public"."series_analysis_reader_capabilities" IN SHARE MODE;--> statement-breakpoint
LOCK TABLE "public"."series_analysis_worker_capabilities" IN SHARE MODE;--> statement-breakpoint
-- Exclude title registration before locking its inherited release tuple.
LOCK TABLE "public"."game_titles" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
SELECT "singleton_key" FROM "public"."series_analysis_release_state"
WHERE "singleton_key" = 'current' FOR UPDATE;
