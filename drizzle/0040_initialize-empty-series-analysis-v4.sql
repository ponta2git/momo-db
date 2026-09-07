-- Advance only an untouched empty baseline. Databases with titles or a prior
-- release operation retain their active tuple and use capability-checked promotion.
SELECT pg_advisory_xact_lock(hashtext('momo-series-analysis-release'));--> statement-breakpoint
LOCK TABLE "public"."game_titles" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
UPDATE "public"."series_analysis_release_state"
SET "algorithm_version" = 'series-analysis-v4',
    "updated_at" = clock_timestamp()
WHERE "singleton_key" = 'current'
  AND "algorithm_version" = 'series-analysis-v3'
  AND "artifact_schema_version" = 2
  AND "validation_contract_id" = 'series-analysis-artifact-v2-full-validation-v1'
  AND NOT EXISTS (SELECT 1 FROM "public"."game_titles")
  AND NOT EXISTS (SELECT 1 FROM "public"."series_analysis_operation_requests");
