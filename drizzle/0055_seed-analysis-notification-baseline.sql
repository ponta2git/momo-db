-- Preserve only a reliably published input baseline. Missing, detached or
-- unattested history remains unknown; absence of history does not prove initial.
-- Desired input may already have advanced, so do not require matching revisions.
UPDATE "public"."series_analysis_title_states" AS state
SET "notification_baseline_state" = 'artifact',
    "notification_baseline_artifact_id" = artifact."id"
FROM "public"."series_analysis_artifacts" AS artifact
WHERE state."notification_baseline_state" = 'unknown'
  AND state."notification_baseline_artifact_id" IS NULL
  AND state."current_artifact_id" = artifact."id"
  AND state."game_title_id" = artifact."game_title_id"
  AND artifact."status" = 'published'
  AND artifact."published_at" IS NOT NULL
  AND (artifact."artifact_schema_version", artifact."validation_contract_id") IN (
    (2, 'series-analysis-artifact-v2-full-validation-v1'),
    (3, 'series-analysis-artifact-v3-full-validation-v1'),
    (4, 'series-analysis-artifact-v4-full-validation-v1')
  );
