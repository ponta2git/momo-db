-- Migration 0036 moved an untouched empty database to algorithm v3/schema v2,
-- but left the validation contract unattested. Repair only that incomplete
-- empty-database baseline; promoted environments and databases with titles are
-- intentionally left unchanged.
SELECT pg_advisory_xact_lock(hashtext('momo-series-analysis-release'));--> statement-breakpoint
LOCK TABLE "public"."game_titles" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
UPDATE "public"."series_analysis_release_state"
SET "validation_contract_id" = 'series-analysis-artifact-v2-full-validation-v1',
    "updated_at" = clock_timestamp()
WHERE "singleton_key" = 'current'
  AND "algorithm_version" = 'series-analysis-v3'
  AND "artifact_schema_version" = 2
  AND "validation_contract_id" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "public"."game_titles");
