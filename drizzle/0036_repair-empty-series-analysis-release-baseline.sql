-- Fresh databases have no title tuple for migration 0034 to inherit. Repair only
-- the untouched historical singleton; existing-title and explicitly promoted
-- environments remain unchanged.
SELECT pg_advisory_xact_lock(hashtext('momo-series-analysis-release'));--> statement-breakpoint
LOCK TABLE "public"."game_titles" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
UPDATE "public"."series_analysis_release_state"
SET "algorithm_version" = 'series-analysis-v3',
    "artifact_schema_version" = 2,
    "updated_at" = clock_timestamp()
WHERE "singleton_key" = 'current'
  AND "algorithm_version" = 'series-analysis-v1'
  AND "artifact_schema_version" = 1
  AND "validation_contract_id" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "public"."game_titles");
