-- Only bootstrap an untouched database before connecting runtime consumers.
-- Registered readers/workers count even when stale or draining. A previously
-- operated database keeps its active tuple and uses normal checked promotion.
SELECT pg_advisory_xact_lock(hashtext('momo-series-analysis-release'));--> statement-breakpoint
LOCK TABLE "public"."series_analysis_reader_capabilities" IN SHARE MODE;--> statement-breakpoint
LOCK TABLE "public"."series_analysis_worker_capabilities" IN SHARE MODE;--> statement-breakpoint
LOCK TABLE "public"."game_titles" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
UPDATE "public"."series_analysis_release_state"
SET "algorithm_version" = 'series-analysis-v5',
    "artifact_schema_version" = 3,
    "validation_contract_id" = 'series-analysis-artifact-v3-full-validation-v1',
    "updated_at" = clock_timestamp()
WHERE "singleton_key" = 'current'
  AND "algorithm_version" = 'series-analysis-v4'
  AND "artifact_schema_version" = 2
  AND "validation_contract_id" = 'series-analysis-artifact-v2-full-validation-v1'
  AND NOT EXISTS (SELECT 1 FROM "public"."game_titles")
  AND NOT EXISTS (SELECT 1 FROM "public"."series_analysis_title_states")
  AND NOT EXISTS (SELECT 1 FROM "public"."series_analysis_operation_requests")
  AND NOT EXISTS (SELECT 1 FROM "public"."series_analysis_jobs")
  AND NOT EXISTS (SELECT 1 FROM "public"."series_analysis_job_requests")
  AND NOT EXISTS (SELECT 1 FROM "public"."series_analysis_job_attempts")
  AND NOT EXISTS (SELECT 1 FROM "public"."series_analysis_campaigns")
  AND NOT EXISTS (SELECT 1 FROM "public"."series_analysis_artifacts")
  AND NOT EXISTS (SELECT 1 FROM "public"."series_analysis_reader_capabilities")
  AND NOT EXISTS (SELECT 1 FROM "public"."series_analysis_worker_capabilities");
