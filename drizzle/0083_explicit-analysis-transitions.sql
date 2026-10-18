-- Requires the explicit consumer transitions validated in momo-result PR98.
-- Writer admission remains stopped until the matching consumer generation is active.
-- Lock the complete maintenance cutover before any expansion or trigger change.
LOCK TABLE public."app_sessions",
  public."discord_notification_attendance",
  public."discord_notification_parts",
  public."discord_notification_results",
  public."discord_notification_settings",
  public."discord_notification_targets",
  public."discord_notifications",
  public."game_titles",
  public."held_event_participants",
  public."held_events",
  public."idempotency_keys",
  public."incident_masters",
  public."map_masters",
  public."match_drafts",
  public."match_incidents",
  public."match_players",
  public."matches",
  public."member_aliases",
  public."members",
  public."momo_login_accounts",
  public."oauth_state_consumptions",
  public."ocr_drafts",
  public."ocr_jobs",
  public."ocr_submission_members",
  public."ocr_submissions",
  public."responses",
  public."season_masters",
  public."series_analysis_artifacts",
  public."series_analysis_campaign_targets",
  public."series_analysis_campaigns",
  public."series_analysis_drilldown_artifacts",
  public."series_analysis_job_attempts",
  public."series_analysis_job_requests",
  public."series_analysis_jobs",
  public."series_analysis_match_context_artifacts",
  public."series_analysis_operation_requests",
  public."series_analysis_outlook_reference_artifacts",
  public."series_analysis_outlook_summary_artifacts",
  public."series_analysis_reader_capabilities",
  public."series_analysis_release_state",
  public."series_analysis_scope_aggregate_artifacts",
  public."series_analysis_scope_review_artifacts",
  public."series_analysis_title_states",
  public."series_analysis_worker_capabilities",
  public."series_radar_acknowledgements",
  public."series_radar_bases",
  public."series_radar_candidates",
  public."series_radar_operations",
  public."series_radar_preview_scopes",
  public."series_radar_previews",
  public."series_radar_revisions",
  public."series_radar_title_states",
  public."sessions",
  public."source_images",
  public."worker_execution_slots"
  IN ACCESS EXCLUSIVE MODE NOWAIT;
--> statement-breakpoint
DROP TRIGGER game_titles_series_analysis_state_insert ON public.game_titles;
--> statement-breakpoint
DROP FUNCTION public.ensure_series_analysis_title_state();
--> statement-breakpoint
DROP TRIGGER series_analysis_jobs_radar_binding ON public.series_analysis_jobs;
--> statement-breakpoint
DROP FUNCTION public.bind_series_analysis_radar_job();
--> statement-breakpoint
DROP TRIGGER series_analysis_jobs_lease_validation_cleanup ON public.series_analysis_jobs;
--> statement-breakpoint
DROP FUNCTION public.clear_series_analysis_lease_validation_contract();
--> statement-breakpoint
-- Native constraints and child guards remain. The application full validator
-- owns supported-contract and outlook resource semantics; DB guards retain the
-- exact seal, publication, desired tuple and legacy v1/v2 storage transitions.
CREATE OR REPLACE FUNCTION "public"."validate_series_analysis_artifact_pointers"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  candidate "public"."series_analysis_artifacts"%ROWTYPE;

BEGIN
  IF NEW."current_artifact_id" IS NOT NULL THEN
    SELECT * INTO STRICT candidate
    FROM "public"."series_analysis_artifacts"
    WHERE "id" = NEW."current_artifact_id"
      AND "game_title_id" = NEW."game_title_id";

    IF candidate."status" <> 'published'
       OR candidate."input_revision" <> NEW."input_revision"
       OR candidate."algorithm_version" <> NEW."algorithm_version"
       OR candidate."artifact_schema_version" <> NEW."artifact_schema_version"
       OR (
         NEW."validation_contract_id" IS NOT NULL
         AND (
           candidate."artifact_schema_version" <> NEW."artifact_schema_version"
           OR candidate."validation_contract_id" IS DISTINCT FROM NEW."validation_contract_id"
         )
       ) THEN
      RAISE EXCEPTION 'current series analysis artifact is not an attested published desired-version artifact';
    END IF;
  END IF;

  IF NEW."current_artifact_id" IS NOT NULL AND NEW."artifact_schema_version" >= 5 THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.series_radar_title_states r
      WHERE r.game_title_id = NEW.game_title_id
        AND r.desired_basis_id IS NOT DISTINCT FROM candidate.radar_basis_id
        AND r.generation = candidate.radar_generation
    ) AND (
      EXISTS (SELECT 1 FROM public.series_radar_title_states r WHERE r.game_title_id = NEW.game_title_id)
      OR candidate.radar_basis_id IS NOT NULL OR candidate.radar_generation <> 0
    ) THEN
      RAISE EXCEPTION 'radar publication does not match the desired basis generation';
    END IF;
  END IF;

  IF NEW."previous_artifact_id" IS NOT NULL THEN
    SELECT * INTO STRICT candidate
    FROM "public"."series_analysis_artifacts"
    WHERE "id" = NEW."previous_artifact_id"
      AND "game_title_id" = NEW."game_title_id";

    IF candidate."status" <> 'published'
       OR (
         NEW."validation_contract_id" IS NOT NULL
         AND (
           candidate."artifact_schema_version" <> NEW."artifact_schema_version"
           OR candidate."validation_contract_id" IS DISTINCT FROM NEW."validation_contract_id"
         )
       ) THEN
      RAISE EXCEPTION 'previous series analysis artifact is not an attested publication';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."guard_series_analysis_artifact_publication"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'staging'
       OR NEW."published_at" IS NOT NULL
       OR NEW."validation_contract_id" IS NOT NULL THEN
      RAISE EXCEPTION 'series analysis artifacts must begin as unattested staging rows';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'published'
     AND (
       (to_jsonb(NEW) - 'attempt_id') IS DISTINCT FROM (to_jsonb(OLD) - 'attempt_id')
       OR NOT (
         NEW."attempt_id" IS NOT DISTINCT FROM OLD."attempt_id"
         OR (OLD."attempt_id" IS NOT NULL AND NEW."attempt_id" IS NULL)
       )
     ) THEN
    RAISE EXCEPTION 'published series analysis artifact headers are immutable';
  ELSIF OLD."status" = 'staging'
        AND OLD."validation_contract_id" IS NULL
        AND NEW."validation_contract_id" IS NOT NULL
        AND (
          NEW."status" <> 'staging'
          OR NEW."published_at" IS NOT NULL
          OR (to_jsonb(NEW) - 'validation_contract_id')
             IS DISTINCT FROM (to_jsonb(OLD) - 'validation_contract_id')
        ) THEN
    RAISE EXCEPTION 'series analysis artifact attestation must be an exact seal-only transition';
  ELSIF OLD."status" = 'staging'
        AND OLD."validation_contract_id" IS NOT NULL
        AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)
        AND NOT (
          (
            NEW."status" = 'published'
            AND NEW."published_at" IS NOT NULL
            AND (to_jsonb(NEW) - 'status' - 'published_at' - 'radar_applied_at')
                IS NOT DISTINCT FROM (to_jsonb(OLD) - 'status' - 'published_at' - 'radar_applied_at')
            AND (NEW.radar_basis_id IS NULL OR NEW.radar_applied_at IS NOT NULL)
            AND (OLD.radar_applied_at IS NULL OR NEW.radar_applied_at IS NOT DISTINCT FROM OLD.radar_applied_at)
          )
          OR (
            NEW."status" = 'staging'
            AND OLD."attempt_id" IS NOT NULL
            AND NEW."attempt_id" IS NULL
            AND (to_jsonb(NEW) - 'attempt_id')
                IS NOT DISTINCT FROM (to_jsonb(OLD) - 'attempt_id')
          )
        ) THEN
    RAISE EXCEPTION 'attested staging series analysis artifact headers are immutable until publication';
  ELSIF OLD."status" = 'staging'
        AND OLD."validation_contract_id" IS NULL
        AND NEW."status" = 'published'
        AND (
          NEW."artifact_schema_version" >= 3
          OR NEW."published_at" IS NULL
          OR (to_jsonb(NEW) - 'status' - 'published_at')
             IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'published_at')
        ) THEN
    RAISE EXCEPTION 'legacy series analysis artifact publication must be a status-only transition';
  END IF;
  RETURN NEW;
END;
$$;
