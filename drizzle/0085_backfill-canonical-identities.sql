-- Frozen sha256-uuidv8-v1 / docs/canonical-identities.md. Only new nullable
-- canonical columns are populated. Original IDs, saved payloads and operational
-- values remain untouched. All writer admission stays stopped through contract.
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
CREATE OR REPLACE FUNCTION pg_temp.momo_canonical_identity(entity_name text, legacy_id text)
RETURNS uuid LANGUAGE plpgsql IMMUTABLE STRICT
SET search_path = pg_catalog
AS $mapping$
DECLARE
  value bytea;
BEGIN
  IF entity_name <> ALL (ARRAY['members', 'member_aliases', 'momo_login_accounts', 'sessions', 'responses', 'held_events', 'game_titles', 'map_masters', 'season_masters', 'incident_masters', 'matches', 'match_drafts', 'source_images', 'ocr_jobs', 'ocr_drafts', 'ocr_submissions', 'series_analysis_operation_requests', 'series_analysis_campaigns', 'series_analysis_job_requests', 'series_analysis_jobs', 'series_analysis_job_attempts', 'series_analysis_artifacts', 'series_radar_bases', 'series_radar_candidates', 'series_radar_operations', 'series_radar_previews']) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'CANONICAL_ID_UNKNOWN_ENTITY';
  END IF;
  IF pg_input_is_valid(legacy_id, 'uuid') THEN
    RETURN legacy_id::uuid;
  END IF;
  value := substr(sha256(
    decode('deabc659a5ca4dc09711eae0614fa478', 'hex')
    || convert_to(entity_name, 'UTF8') || decode('00', 'hex')
    || convert_to(legacy_id, 'UTF8')
  ), 1, 16);
  value := set_byte(value, 6, (get_byte(value, 6) & 15) | 128);
  value := set_byte(value, 8, (get_byte(value, 8) & 63) | 128);
  RETURN encode(value, 'hex')::uuid;
END;
$mapping$;

--> statement-breakpoint
DO $precondition$
BEGIN
  IF current_setting('server_encoding') <> 'UTF8' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'CANONICAL_ID_UTF8_REQUIRED';
  END IF;
  IF EXISTS (SELECT 1 FROM public."app_sessions" WHERE "canonical_member_id" IS NOT NULL OR "canonical_account_id" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public."game_titles" WHERE "canonical_id" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public."held_event_participants" WHERE "canonical_held_event_id" IS NOT NULL OR "canonical_member_id" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public."held_events" WHERE "canonical_id" IS NOT NULL OR "canonical_session_id" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public."incident_masters" WHERE "canonical_id" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public."map_masters" WHERE "canonical_id" IS NOT NULL OR "canonical_game_title_id" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public."match_drafts" WHERE "canonical_id" IS NOT NULL OR "canonical_created_by_member_id" IS NOT NULL OR "canonical_created_by_account_id" IS NOT NULL OR "canonical_held_event_id" IS NOT NULL OR "canonical_game_title_id" IS NOT NULL OR "canonical_season_master_id" IS NOT NULL OR "canonical_owner_member_id" IS NOT NULL OR "canonical_map_master_id" IS NOT NULL OR "canonical_total_assets_draft_id" IS NOT NULL OR "canonical_revenue_draft_id" IS NOT NULL OR "canonical_incident_log_draft_id" IS NOT NULL OR "canonical_confirmed_match_id" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public."match_incidents" WHERE "canonical_match_id" IS NOT NULL OR "canonical_member_id" IS NOT NULL OR "canonical_incident_master_id" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public."match_players" WHERE "canonical_match_id" IS NOT NULL OR "canonical_member_id" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public."matches" WHERE "canonical_id" IS NOT NULL OR "canonical_held_event_id" IS NOT NULL OR "canonical_game_title_id" IS NOT NULL OR "canonical_season_master_id" IS NOT NULL OR "canonical_owner_member_id" IS NOT NULL OR "canonical_map_master_id" IS NOT NULL OR "canonical_created_by_member_id" IS NOT NULL OR "canonical_created_by_account_id" IS NOT NULL OR "canonical_note_updated_by_account_id" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public."member_aliases" WHERE "canonical_id" IS NOT NULL OR "canonical_member_id" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public."members" WHERE "canonical_id" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public."momo_login_accounts" WHERE "canonical_id" IS NOT NULL OR "canonical_player_member_id" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public."ocr_drafts" WHERE "canonical_id" IS NOT NULL OR "canonical_job_id" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public."ocr_jobs" WHERE "canonical_id" IS NOT NULL OR "canonical_draft_id" IS NOT NULL OR "canonical_source_image_id" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public."ocr_submission_members" WHERE "canonical_submission_id" IS NOT NULL OR "canonical_job_id" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public."ocr_submissions" WHERE "canonical_id" IS NOT NULL OR "canonical_owner_account_id" IS NOT NULL OR "canonical_match_draft_id" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public."responses" WHERE "canonical_id" IS NOT NULL OR "canonical_session_id" IS NOT NULL OR "canonical_member_id" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public."season_masters" WHERE "canonical_id" IS NOT NULL OR "canonical_game_title_id" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public."series_analysis_campaign_targets" WHERE "canonical_campaign_id" IS NOT NULL OR "canonical_game_title_id" IS NOT NULL OR "canonical_job_request_id" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public."series_analysis_campaigns" WHERE "canonical_id" IS NOT NULL OR "canonical_operation_request_id" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public."series_analysis_job_attempts" WHERE "canonical_id" IS NOT NULL OR "canonical_job_id" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public."series_analysis_job_requests" WHERE "canonical_id" IS NOT NULL OR "canonical_game_title_id" IS NOT NULL OR "canonical_operation_request_id" IS NOT NULL OR "canonical_campaign_id" IS NOT NULL OR "canonical_assigned_job_id" IS NOT NULL OR "canonical_assigned_attempt_id" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public."series_analysis_jobs" WHERE "canonical_id" IS NOT NULL OR "canonical_radar_operation_id" IS NOT NULL OR "canonical_radar_basis_id" IS NOT NULL OR "canonical_game_title_id" IS NOT NULL OR "canonical_lease_attempt_id" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public."series_analysis_operation_requests" WHERE "canonical_id" IS NOT NULL OR "canonical_game_title_id" IS NOT NULL OR "canonical_requested_by_account_id" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public."series_analysis_title_states" WHERE "canonical_game_title_id" IS NOT NULL OR "canonical_current_artifact_id" IS NOT NULL OR "canonical_previous_artifact_id" IS NOT NULL OR "canonical_notification_baseline_artifact_id" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public."series_radar_acknowledgements" WHERE "canonical_game_title_id" IS NOT NULL OR "canonical_requested_by" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public."series_radar_candidates" WHERE "canonical_id" IS NOT NULL OR "canonical_game_title_id" IS NOT NULL OR "canonical_basis_id" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public."series_radar_operations" WHERE "canonical_id" IS NOT NULL OR "canonical_game_title_id" IS NOT NULL OR "canonical_candidate_id" IS NOT NULL OR "canonical_preview_id" IS NOT NULL OR "canonical_basis_id" IS NOT NULL OR "canonical_origin_operation_id" IS NOT NULL OR "canonical_requested_by" IS NOT NULL OR "canonical_job_id" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public."series_radar_preview_scopes" WHERE "canonical_preview_id" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public."series_radar_previews" WHERE "canonical_id" IS NOT NULL OR "canonical_game_title_id" IS NOT NULL OR "canonical_candidate_id" IS NOT NULL OR "canonical_before_basis_id" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public."series_radar_title_states" WHERE "canonical_game_title_id" IS NOT NULL OR "canonical_desired_basis_id" IS NOT NULL OR "canonical_current_basis_id" IS NOT NULL OR "canonical_previous_basis_id" IS NOT NULL OR "canonical_active_operation_id" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public."sessions" WHERE "canonical_id" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public."source_images" WHERE "canonical_id" IS NOT NULL OR "canonical_owner_account_id" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public."worker_execution_slots" WHERE "canonical_job_id" IS NOT NULL OR "canonical_attempt_id" IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'CANONICAL_ID_EXPANSION_ALREADY_USED';
  END IF;
  IF EXISTS (SELECT 1 FROM public.worker_execution_slots
    WHERE task_kind = 'ocr' AND attempt_id IS NOT NULL
      AND NOT pg_input_is_valid(attempt_id, 'uuid')) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'CANONICAL_ID_OCR_ATTEMPT_INVALID';
  END IF;
END;
$precondition$;
--> statement-breakpoint
CREATE TEMP TABLE momo_canonical_identity_mapping ON COMMIT DROP AS
SELECT entity, legacy_id, pg_temp.momo_canonical_identity(entity, legacy_id) AS canonical_id
FROM (
  SELECT 'game_titles'::text AS entity, id COLLATE "C" AS legacy_id FROM public."game_titles"
  UNION
  SELECT 'held_events'::text AS entity, id COLLATE "C" AS legacy_id FROM public."held_events"
  UNION
  SELECT 'incident_masters'::text AS entity, id COLLATE "C" AS legacy_id FROM public."incident_masters"
  UNION
  SELECT 'map_masters'::text AS entity, id COLLATE "C" AS legacy_id FROM public."map_masters"
  UNION
  SELECT 'match_drafts'::text AS entity, id COLLATE "C" AS legacy_id FROM public."match_drafts"
  UNION
  SELECT 'matches'::text AS entity, id COLLATE "C" AS legacy_id FROM public."matches"
  UNION
  SELECT 'member_aliases'::text AS entity, id COLLATE "C" AS legacy_id FROM public."member_aliases"
  UNION
  SELECT 'members'::text AS entity, id COLLATE "C" AS legacy_id FROM public."members"
  UNION
  SELECT 'momo_login_accounts'::text AS entity, id COLLATE "C" AS legacy_id FROM public."momo_login_accounts"
  UNION
  SELECT 'ocr_drafts'::text AS entity, id COLLATE "C" AS legacy_id FROM public."ocr_drafts"
  UNION
  SELECT 'ocr_jobs'::text AS entity, id COLLATE "C" AS legacy_id FROM public."ocr_jobs"
  UNION
  SELECT 'ocr_submissions'::text AS entity, id COLLATE "C" AS legacy_id FROM public."ocr_submissions"
  UNION
  SELECT 'responses'::text AS entity, id COLLATE "C" AS legacy_id FROM public."responses"
  UNION
  SELECT 'season_masters'::text AS entity, id COLLATE "C" AS legacy_id FROM public."season_masters"
  UNION
  SELECT 'series_analysis_campaigns'::text AS entity, id COLLATE "C" AS legacy_id FROM public."series_analysis_campaigns"
  UNION
  SELECT 'series_analysis_job_attempts'::text AS entity, id COLLATE "C" AS legacy_id FROM public."series_analysis_job_attempts"
  UNION
  SELECT 'series_analysis_job_requests'::text AS entity, id COLLATE "C" AS legacy_id FROM public."series_analysis_job_requests"
  UNION
  SELECT 'series_analysis_jobs'::text AS entity, id COLLATE "C" AS legacy_id FROM public."series_analysis_jobs"
  UNION
  SELECT 'series_analysis_operation_requests'::text AS entity, id COLLATE "C" AS legacy_id FROM public."series_analysis_operation_requests"
  UNION
  SELECT 'series_radar_candidates'::text AS entity, id COLLATE "C" AS legacy_id FROM public."series_radar_candidates"
  UNION
  SELECT 'series_radar_operations'::text AS entity, id COLLATE "C" AS legacy_id FROM public."series_radar_operations"
  UNION
  SELECT 'series_radar_previews'::text AS entity, id COLLATE "C" AS legacy_id FROM public."series_radar_previews"
  UNION
  SELECT 'sessions'::text AS entity, id COLLATE "C" AS legacy_id FROM public."sessions"
  UNION
  SELECT 'source_images'::text AS entity, id COLLATE "C" AS legacy_id FROM public."source_images"
  UNION
  SELECT 'series_analysis_artifacts'::text AS entity, id COLLATE "C" AS legacy_id FROM public."series_analysis_artifacts"
  UNION
  SELECT 'series_radar_bases'::text AS entity, id COLLATE "C" AS legacy_id FROM public."series_radar_bases"
  UNION
  SELECT 'members', "member_id" COLLATE "C" FROM public."app_sessions" WHERE "member_id" IS NOT NULL
  UNION
  SELECT 'momo_login_accounts', "account_id" COLLATE "C" FROM public."app_sessions" WHERE "account_id" IS NOT NULL
  UNION
  SELECT 'held_events', "held_event_id" COLLATE "C" FROM public."held_event_participants" WHERE "held_event_id" IS NOT NULL
  UNION
  SELECT 'members', "member_id" COLLATE "C" FROM public."held_event_participants" WHERE "member_id" IS NOT NULL
  UNION
  SELECT 'sessions', "session_id" COLLATE "C" FROM public."held_events" WHERE "session_id" IS NOT NULL
  UNION
  SELECT 'game_titles', "game_title_id" COLLATE "C" FROM public."map_masters" WHERE "game_title_id" IS NOT NULL
  UNION
  SELECT 'members', "created_by_member_id" COLLATE "C" FROM public."match_drafts" WHERE "created_by_member_id" IS NOT NULL
  UNION
  SELECT 'momo_login_accounts', "created_by_account_id" COLLATE "C" FROM public."match_drafts" WHERE "created_by_account_id" IS NOT NULL
  UNION
  SELECT 'held_events', "held_event_id" COLLATE "C" FROM public."match_drafts" WHERE "held_event_id" IS NOT NULL
  UNION
  SELECT 'game_titles', "game_title_id" COLLATE "C" FROM public."match_drafts" WHERE "game_title_id" IS NOT NULL
  UNION
  SELECT 'season_masters', "season_master_id" COLLATE "C" FROM public."match_drafts" WHERE "season_master_id" IS NOT NULL
  UNION
  SELECT 'members', "owner_member_id" COLLATE "C" FROM public."match_drafts" WHERE "owner_member_id" IS NOT NULL
  UNION
  SELECT 'map_masters', "map_master_id" COLLATE "C" FROM public."match_drafts" WHERE "map_master_id" IS NOT NULL
  UNION
  SELECT 'ocr_drafts', "total_assets_draft_id" COLLATE "C" FROM public."match_drafts" WHERE "total_assets_draft_id" IS NOT NULL
  UNION
  SELECT 'ocr_drafts', "revenue_draft_id" COLLATE "C" FROM public."match_drafts" WHERE "revenue_draft_id" IS NOT NULL
  UNION
  SELECT 'ocr_drafts', "incident_log_draft_id" COLLATE "C" FROM public."match_drafts" WHERE "incident_log_draft_id" IS NOT NULL
  UNION
  SELECT 'matches', "confirmed_match_id" COLLATE "C" FROM public."match_drafts" WHERE "confirmed_match_id" IS NOT NULL
  UNION
  SELECT 'matches', "match_id" COLLATE "C" FROM public."match_incidents" WHERE "match_id" IS NOT NULL
  UNION
  SELECT 'members', "member_id" COLLATE "C" FROM public."match_incidents" WHERE "member_id" IS NOT NULL
  UNION
  SELECT 'incident_masters', "incident_master_id" COLLATE "C" FROM public."match_incidents" WHERE "incident_master_id" IS NOT NULL
  UNION
  SELECT 'matches', "match_id" COLLATE "C" FROM public."match_players" WHERE "match_id" IS NOT NULL
  UNION
  SELECT 'members', "member_id" COLLATE "C" FROM public."match_players" WHERE "member_id" IS NOT NULL
  UNION
  SELECT 'held_events', "held_event_id" COLLATE "C" FROM public."matches" WHERE "held_event_id" IS NOT NULL
  UNION
  SELECT 'game_titles', "game_title_id" COLLATE "C" FROM public."matches" WHERE "game_title_id" IS NOT NULL
  UNION
  SELECT 'season_masters', "season_master_id" COLLATE "C" FROM public."matches" WHERE "season_master_id" IS NOT NULL
  UNION
  SELECT 'members', "owner_member_id" COLLATE "C" FROM public."matches" WHERE "owner_member_id" IS NOT NULL
  UNION
  SELECT 'map_masters', "map_master_id" COLLATE "C" FROM public."matches" WHERE "map_master_id" IS NOT NULL
  UNION
  SELECT 'members', "created_by_member_id" COLLATE "C" FROM public."matches" WHERE "created_by_member_id" IS NOT NULL
  UNION
  SELECT 'momo_login_accounts', "created_by_account_id" COLLATE "C" FROM public."matches" WHERE "created_by_account_id" IS NOT NULL
  UNION
  SELECT 'momo_login_accounts', "note_updated_by_account_id" COLLATE "C" FROM public."matches" WHERE "note_updated_by_account_id" IS NOT NULL
  UNION
  SELECT 'members', "member_id" COLLATE "C" FROM public."member_aliases" WHERE "member_id" IS NOT NULL
  UNION
  SELECT 'members', "player_member_id" COLLATE "C" FROM public."momo_login_accounts" WHERE "player_member_id" IS NOT NULL
  UNION
  SELECT 'ocr_jobs', "job_id" COLLATE "C" FROM public."ocr_drafts" WHERE "job_id" IS NOT NULL
  UNION
  SELECT 'ocr_drafts', "draft_id" COLLATE "C" FROM public."ocr_jobs" WHERE "draft_id" IS NOT NULL
  UNION
  SELECT 'source_images', "source_image_id" COLLATE "C" FROM public."ocr_jobs" WHERE "source_image_id" IS NOT NULL
  UNION
  SELECT 'ocr_submissions', "submission_id" COLLATE "C" FROM public."ocr_submission_members" WHERE "submission_id" IS NOT NULL
  UNION
  SELECT 'ocr_jobs', "job_id" COLLATE "C" FROM public."ocr_submission_members" WHERE "job_id" IS NOT NULL
  UNION
  SELECT 'momo_login_accounts', "owner_account_id" COLLATE "C" FROM public."ocr_submissions" WHERE "owner_account_id" IS NOT NULL
  UNION
  SELECT 'match_drafts', "match_draft_id" COLLATE "C" FROM public."ocr_submissions" WHERE "match_draft_id" IS NOT NULL
  UNION
  SELECT 'sessions', "session_id" COLLATE "C" FROM public."responses" WHERE "session_id" IS NOT NULL
  UNION
  SELECT 'members', "member_id" COLLATE "C" FROM public."responses" WHERE "member_id" IS NOT NULL
  UNION
  SELECT 'game_titles', "game_title_id" COLLATE "C" FROM public."season_masters" WHERE "game_title_id" IS NOT NULL
  UNION
  SELECT 'series_analysis_campaigns', "campaign_id" COLLATE "C" FROM public."series_analysis_campaign_targets" WHERE "campaign_id" IS NOT NULL
  UNION
  SELECT 'game_titles', "game_title_id" COLLATE "C" FROM public."series_analysis_campaign_targets" WHERE "game_title_id" IS NOT NULL
  UNION
  SELECT 'series_analysis_job_requests', "job_request_id" COLLATE "C" FROM public."series_analysis_campaign_targets" WHERE "job_request_id" IS NOT NULL
  UNION
  SELECT 'series_analysis_operation_requests', "operation_request_id" COLLATE "C" FROM public."series_analysis_campaigns" WHERE "operation_request_id" IS NOT NULL
  UNION
  SELECT 'series_analysis_jobs', "job_id" COLLATE "C" FROM public."series_analysis_job_attempts" WHERE "job_id" IS NOT NULL
  UNION
  SELECT 'game_titles', "game_title_id" COLLATE "C" FROM public."series_analysis_job_requests" WHERE "game_title_id" IS NOT NULL
  UNION
  SELECT 'series_analysis_operation_requests', "operation_request_id" COLLATE "C" FROM public."series_analysis_job_requests" WHERE "operation_request_id" IS NOT NULL
  UNION
  SELECT 'series_analysis_campaigns', "campaign_id" COLLATE "C" FROM public."series_analysis_job_requests" WHERE "campaign_id" IS NOT NULL
  UNION
  SELECT 'series_analysis_jobs', "assigned_job_id" COLLATE "C" FROM public."series_analysis_job_requests" WHERE "assigned_job_id" IS NOT NULL
  UNION
  SELECT 'series_analysis_job_attempts', "assigned_attempt_id" COLLATE "C" FROM public."series_analysis_job_requests" WHERE "assigned_attempt_id" IS NOT NULL
  UNION
  SELECT 'series_radar_operations', "radar_operation_id" COLLATE "C" FROM public."series_analysis_jobs" WHERE "radar_operation_id" IS NOT NULL
  UNION
  SELECT 'series_radar_bases', "radar_basis_id" COLLATE "C" FROM public."series_analysis_jobs" WHERE "radar_basis_id" IS NOT NULL
  UNION
  SELECT 'game_titles', "game_title_id" COLLATE "C" FROM public."series_analysis_jobs" WHERE "game_title_id" IS NOT NULL
  UNION
  SELECT 'series_analysis_job_attempts', "lease_attempt_id" COLLATE "C" FROM public."series_analysis_jobs" WHERE "lease_attempt_id" IS NOT NULL
  UNION
  SELECT 'game_titles', "game_title_id" COLLATE "C" FROM public."series_analysis_operation_requests" WHERE "game_title_id" IS NOT NULL
  UNION
  SELECT 'momo_login_accounts', "requested_by_account_id" COLLATE "C" FROM public."series_analysis_operation_requests" WHERE "requested_by_account_id" IS NOT NULL
  UNION
  SELECT 'game_titles', "game_title_id" COLLATE "C" FROM public."series_analysis_title_states" WHERE "game_title_id" IS NOT NULL
  UNION
  SELECT 'series_analysis_artifacts', "current_artifact_id" COLLATE "C" FROM public."series_analysis_title_states" WHERE "current_artifact_id" IS NOT NULL
  UNION
  SELECT 'series_analysis_artifacts', "previous_artifact_id" COLLATE "C" FROM public."series_analysis_title_states" WHERE "previous_artifact_id" IS NOT NULL
  UNION
  SELECT 'series_analysis_artifacts', "notification_baseline_artifact_id" COLLATE "C" FROM public."series_analysis_title_states" WHERE "notification_baseline_artifact_id" IS NOT NULL
  UNION
  SELECT 'game_titles', "game_title_id" COLLATE "C" FROM public."series_radar_acknowledgements" WHERE "game_title_id" IS NOT NULL
  UNION
  SELECT 'momo_login_accounts', "requested_by" COLLATE "C" FROM public."series_radar_acknowledgements" WHERE "requested_by" IS NOT NULL
  UNION
  SELECT 'game_titles', "game_title_id" COLLATE "C" FROM public."series_radar_candidates" WHERE "game_title_id" IS NOT NULL
  UNION
  SELECT 'series_radar_bases', "basis_id" COLLATE "C" FROM public."series_radar_candidates" WHERE "basis_id" IS NOT NULL
  UNION
  SELECT 'game_titles', "game_title_id" COLLATE "C" FROM public."series_radar_operations" WHERE "game_title_id" IS NOT NULL
  UNION
  SELECT 'series_radar_candidates', "candidate_id" COLLATE "C" FROM public."series_radar_operations" WHERE "candidate_id" IS NOT NULL
  UNION
  SELECT 'series_radar_previews', "preview_id" COLLATE "C" FROM public."series_radar_operations" WHERE "preview_id" IS NOT NULL
  UNION
  SELECT 'series_radar_bases', "basis_id" COLLATE "C" FROM public."series_radar_operations" WHERE "basis_id" IS NOT NULL
  UNION
  SELECT 'series_radar_operations', "origin_operation_id" COLLATE "C" FROM public."series_radar_operations" WHERE "origin_operation_id" IS NOT NULL
  UNION
  SELECT 'momo_login_accounts', "requested_by" COLLATE "C" FROM public."series_radar_operations" WHERE "requested_by" IS NOT NULL
  UNION
  SELECT 'series_analysis_jobs', "job_id" COLLATE "C" FROM public."series_radar_operations" WHERE "job_id" IS NOT NULL
  UNION
  SELECT 'series_radar_previews', "preview_id" COLLATE "C" FROM public."series_radar_preview_scopes" WHERE "preview_id" IS NOT NULL
  UNION
  SELECT 'game_titles', "game_title_id" COLLATE "C" FROM public."series_radar_previews" WHERE "game_title_id" IS NOT NULL
  UNION
  SELECT 'series_radar_candidates', "candidate_id" COLLATE "C" FROM public."series_radar_previews" WHERE "candidate_id" IS NOT NULL
  UNION
  SELECT 'series_radar_bases', "before_basis_id" COLLATE "C" FROM public."series_radar_previews" WHERE "before_basis_id" IS NOT NULL
  UNION
  SELECT 'game_titles', "game_title_id" COLLATE "C" FROM public."series_radar_title_states" WHERE "game_title_id" IS NOT NULL
  UNION
  SELECT 'series_radar_bases', "desired_basis_id" COLLATE "C" FROM public."series_radar_title_states" WHERE "desired_basis_id" IS NOT NULL
  UNION
  SELECT 'series_radar_bases', "current_basis_id" COLLATE "C" FROM public."series_radar_title_states" WHERE "current_basis_id" IS NOT NULL
  UNION
  SELECT 'series_radar_bases', "previous_basis_id" COLLATE "C" FROM public."series_radar_title_states" WHERE "previous_basis_id" IS NOT NULL
  UNION
  SELECT 'series_radar_operations', "active_operation_id" COLLATE "C" FROM public."series_radar_title_states" WHERE "active_operation_id" IS NOT NULL
  UNION
  SELECT 'momo_login_accounts', "owner_account_id" COLLATE "C" FROM public."source_images" WHERE "owner_account_id" IS NOT NULL
  UNION
  SELECT CASE task_kind WHEN 'analysis' THEN 'series_analysis_jobs' WHEN 'ocr' THEN 'ocr_jobs' END, job_id COLLATE "C" FROM public.worker_execution_slots WHERE job_id IS NOT NULL
  UNION
  SELECT 'series_analysis_job_attempts', attempt_id COLLATE "C" FROM public.worker_execution_slots WHERE task_kind = 'analysis' AND attempt_id IS NOT NULL
) originals
WHERE legacy_id IS NOT NULL;
--> statement-breakpoint
DO $collision$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_temp.momo_canonical_identity_mapping
    GROUP BY entity, canonical_id HAVING count(*) > 1) THEN
    -- Never include legacy values or canonical UUIDs in migration diagnostics.
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'CANONICAL_ID_COLLISION';
  END IF;
END;
$collision$;
--> statement-breakpoint
UPDATE public."app_sessions"
SET "canonical_member_id" = pg_temp.momo_canonical_identity('members', "member_id"),
    "canonical_account_id" = pg_temp.momo_canonical_identity('momo_login_accounts', "account_id");
--> statement-breakpoint
UPDATE public."game_titles"
SET "canonical_id" = pg_temp.momo_canonical_identity('game_titles', "id");
--> statement-breakpoint
UPDATE public."held_event_participants"
SET "canonical_held_event_id" = pg_temp.momo_canonical_identity('held_events', "held_event_id"),
    "canonical_member_id" = pg_temp.momo_canonical_identity('members', "member_id");
--> statement-breakpoint
UPDATE public."held_events"
SET "canonical_id" = pg_temp.momo_canonical_identity('held_events', "id"),
    "canonical_session_id" = pg_temp.momo_canonical_identity('sessions', "session_id");
--> statement-breakpoint
UPDATE public."incident_masters"
SET "canonical_id" = pg_temp.momo_canonical_identity('incident_masters', "id");
--> statement-breakpoint
UPDATE public."map_masters"
SET "canonical_id" = pg_temp.momo_canonical_identity('map_masters', "id"),
    "canonical_game_title_id" = pg_temp.momo_canonical_identity('game_titles', "game_title_id");
--> statement-breakpoint
UPDATE public."match_drafts"
SET "canonical_id" = pg_temp.momo_canonical_identity('match_drafts', "id"),
    "canonical_created_by_member_id" = pg_temp.momo_canonical_identity('members', "created_by_member_id"),
    "canonical_created_by_account_id" = pg_temp.momo_canonical_identity('momo_login_accounts', "created_by_account_id"),
    "canonical_held_event_id" = pg_temp.momo_canonical_identity('held_events', "held_event_id"),
    "canonical_game_title_id" = pg_temp.momo_canonical_identity('game_titles', "game_title_id"),
    "canonical_season_master_id" = pg_temp.momo_canonical_identity('season_masters', "season_master_id"),
    "canonical_owner_member_id" = pg_temp.momo_canonical_identity('members', "owner_member_id"),
    "canonical_map_master_id" = pg_temp.momo_canonical_identity('map_masters', "map_master_id"),
    "canonical_total_assets_draft_id" = pg_temp.momo_canonical_identity('ocr_drafts', "total_assets_draft_id"),
    "canonical_revenue_draft_id" = pg_temp.momo_canonical_identity('ocr_drafts', "revenue_draft_id"),
    "canonical_incident_log_draft_id" = pg_temp.momo_canonical_identity('ocr_drafts', "incident_log_draft_id"),
    "canonical_confirmed_match_id" = pg_temp.momo_canonical_identity('matches', "confirmed_match_id");
--> statement-breakpoint
UPDATE public."match_incidents"
SET "canonical_match_id" = pg_temp.momo_canonical_identity('matches', "match_id"),
    "canonical_member_id" = pg_temp.momo_canonical_identity('members', "member_id"),
    "canonical_incident_master_id" = pg_temp.momo_canonical_identity('incident_masters', "incident_master_id");
--> statement-breakpoint
UPDATE public."match_players"
SET "canonical_match_id" = pg_temp.momo_canonical_identity('matches', "match_id"),
    "canonical_member_id" = pg_temp.momo_canonical_identity('members', "member_id");
--> statement-breakpoint
UPDATE public."matches"
SET "canonical_id" = pg_temp.momo_canonical_identity('matches', "id"),
    "canonical_held_event_id" = pg_temp.momo_canonical_identity('held_events', "held_event_id"),
    "canonical_game_title_id" = pg_temp.momo_canonical_identity('game_titles', "game_title_id"),
    "canonical_season_master_id" = pg_temp.momo_canonical_identity('season_masters', "season_master_id"),
    "canonical_owner_member_id" = pg_temp.momo_canonical_identity('members', "owner_member_id"),
    "canonical_map_master_id" = pg_temp.momo_canonical_identity('map_masters', "map_master_id"),
    "canonical_created_by_member_id" = pg_temp.momo_canonical_identity('members', "created_by_member_id"),
    "canonical_created_by_account_id" = pg_temp.momo_canonical_identity('momo_login_accounts', "created_by_account_id"),
    "canonical_note_updated_by_account_id" = pg_temp.momo_canonical_identity('momo_login_accounts', "note_updated_by_account_id");
--> statement-breakpoint
UPDATE public."member_aliases"
SET "canonical_id" = pg_temp.momo_canonical_identity('member_aliases', "id"),
    "canonical_member_id" = pg_temp.momo_canonical_identity('members', "member_id");
--> statement-breakpoint
UPDATE public."members"
SET "canonical_id" = pg_temp.momo_canonical_identity('members', "id");
--> statement-breakpoint
UPDATE public."momo_login_accounts"
SET "canonical_id" = pg_temp.momo_canonical_identity('momo_login_accounts', "id"),
    "canonical_player_member_id" = pg_temp.momo_canonical_identity('members', "player_member_id");
--> statement-breakpoint
UPDATE public."ocr_drafts"
SET "canonical_id" = pg_temp.momo_canonical_identity('ocr_drafts', "id"),
    "canonical_job_id" = pg_temp.momo_canonical_identity('ocr_jobs', "job_id");
--> statement-breakpoint
UPDATE public."ocr_jobs"
SET "canonical_id" = pg_temp.momo_canonical_identity('ocr_jobs', "id"),
    "canonical_draft_id" = pg_temp.momo_canonical_identity('ocr_drafts', "draft_id"),
    "canonical_source_image_id" = pg_temp.momo_canonical_identity('source_images', "source_image_id");
--> statement-breakpoint
UPDATE public."ocr_submission_members"
SET "canonical_submission_id" = pg_temp.momo_canonical_identity('ocr_submissions', "submission_id"),
    "canonical_job_id" = pg_temp.momo_canonical_identity('ocr_jobs', "job_id");
--> statement-breakpoint
UPDATE public."ocr_submissions"
SET "canonical_id" = pg_temp.momo_canonical_identity('ocr_submissions', "id"),
    "canonical_owner_account_id" = pg_temp.momo_canonical_identity('momo_login_accounts', "owner_account_id"),
    "canonical_match_draft_id" = pg_temp.momo_canonical_identity('match_drafts', "match_draft_id");
--> statement-breakpoint
UPDATE public."responses"
SET "canonical_id" = pg_temp.momo_canonical_identity('responses', "id"),
    "canonical_session_id" = pg_temp.momo_canonical_identity('sessions', "session_id"),
    "canonical_member_id" = pg_temp.momo_canonical_identity('members', "member_id");
--> statement-breakpoint
UPDATE public."season_masters"
SET "canonical_id" = pg_temp.momo_canonical_identity('season_masters', "id"),
    "canonical_game_title_id" = pg_temp.momo_canonical_identity('game_titles', "game_title_id");
--> statement-breakpoint
UPDATE public."series_analysis_campaign_targets"
SET "canonical_campaign_id" = pg_temp.momo_canonical_identity('series_analysis_campaigns', "campaign_id"),
    "canonical_game_title_id" = pg_temp.momo_canonical_identity('game_titles', "game_title_id"),
    "canonical_job_request_id" = pg_temp.momo_canonical_identity('series_analysis_job_requests', "job_request_id");
--> statement-breakpoint
UPDATE public."series_analysis_campaigns"
SET "canonical_id" = pg_temp.momo_canonical_identity('series_analysis_campaigns', "id"),
    "canonical_operation_request_id" = pg_temp.momo_canonical_identity('series_analysis_operation_requests', "operation_request_id");
--> statement-breakpoint
UPDATE public."series_analysis_job_attempts"
SET "canonical_id" = pg_temp.momo_canonical_identity('series_analysis_job_attempts', "id"),
    "canonical_job_id" = pg_temp.momo_canonical_identity('series_analysis_jobs', "job_id");
--> statement-breakpoint
UPDATE public."series_analysis_job_requests"
SET "canonical_id" = pg_temp.momo_canonical_identity('series_analysis_job_requests', "id"),
    "canonical_game_title_id" = pg_temp.momo_canonical_identity('game_titles', "game_title_id"),
    "canonical_operation_request_id" = pg_temp.momo_canonical_identity('series_analysis_operation_requests', "operation_request_id"),
    "canonical_campaign_id" = pg_temp.momo_canonical_identity('series_analysis_campaigns', "campaign_id"),
    "canonical_assigned_job_id" = pg_temp.momo_canonical_identity('series_analysis_jobs', "assigned_job_id"),
    "canonical_assigned_attempt_id" = pg_temp.momo_canonical_identity('series_analysis_job_attempts', "assigned_attempt_id");
--> statement-breakpoint
UPDATE public."series_analysis_jobs"
SET "canonical_id" = pg_temp.momo_canonical_identity('series_analysis_jobs', "id"),
    "canonical_radar_operation_id" = pg_temp.momo_canonical_identity('series_radar_operations', "radar_operation_id"),
    "canonical_radar_basis_id" = pg_temp.momo_canonical_identity('series_radar_bases', "radar_basis_id"),
    "canonical_game_title_id" = pg_temp.momo_canonical_identity('game_titles', "game_title_id"),
    "canonical_lease_attempt_id" = pg_temp.momo_canonical_identity('series_analysis_job_attempts', "lease_attempt_id");
--> statement-breakpoint
UPDATE public."series_analysis_operation_requests"
SET "canonical_id" = pg_temp.momo_canonical_identity('series_analysis_operation_requests', "id"),
    "canonical_game_title_id" = pg_temp.momo_canonical_identity('game_titles', "game_title_id"),
    "canonical_requested_by_account_id" = pg_temp.momo_canonical_identity('momo_login_accounts', "requested_by_account_id");
--> statement-breakpoint
UPDATE public."series_analysis_title_states"
SET "canonical_game_title_id" = pg_temp.momo_canonical_identity('game_titles', "game_title_id"),
    "canonical_current_artifact_id" = pg_temp.momo_canonical_identity('series_analysis_artifacts', "current_artifact_id"),
    "canonical_previous_artifact_id" = pg_temp.momo_canonical_identity('series_analysis_artifacts', "previous_artifact_id"),
    "canonical_notification_baseline_artifact_id" = pg_temp.momo_canonical_identity('series_analysis_artifacts', "notification_baseline_artifact_id");
--> statement-breakpoint
UPDATE public."series_radar_acknowledgements"
SET "canonical_game_title_id" = pg_temp.momo_canonical_identity('game_titles', "game_title_id"),
    "canonical_requested_by" = pg_temp.momo_canonical_identity('momo_login_accounts', "requested_by");
--> statement-breakpoint
UPDATE public."series_radar_candidates"
SET "canonical_id" = pg_temp.momo_canonical_identity('series_radar_candidates', "id"),
    "canonical_game_title_id" = pg_temp.momo_canonical_identity('game_titles', "game_title_id"),
    "canonical_basis_id" = pg_temp.momo_canonical_identity('series_radar_bases', "basis_id");
--> statement-breakpoint
UPDATE public."series_radar_operations"
SET "canonical_id" = pg_temp.momo_canonical_identity('series_radar_operations', "id"),
    "canonical_game_title_id" = pg_temp.momo_canonical_identity('game_titles', "game_title_id"),
    "canonical_candidate_id" = pg_temp.momo_canonical_identity('series_radar_candidates', "candidate_id"),
    "canonical_preview_id" = pg_temp.momo_canonical_identity('series_radar_previews', "preview_id"),
    "canonical_basis_id" = pg_temp.momo_canonical_identity('series_radar_bases', "basis_id"),
    "canonical_origin_operation_id" = pg_temp.momo_canonical_identity('series_radar_operations', "origin_operation_id"),
    "canonical_requested_by" = pg_temp.momo_canonical_identity('momo_login_accounts', "requested_by"),
    "canonical_job_id" = pg_temp.momo_canonical_identity('series_analysis_jobs', "job_id");
--> statement-breakpoint
UPDATE public."series_radar_preview_scopes"
SET "canonical_preview_id" = pg_temp.momo_canonical_identity('series_radar_previews', "preview_id");
--> statement-breakpoint
UPDATE public."series_radar_previews"
SET "canonical_id" = pg_temp.momo_canonical_identity('series_radar_previews', "id"),
    "canonical_game_title_id" = pg_temp.momo_canonical_identity('game_titles', "game_title_id"),
    "canonical_candidate_id" = pg_temp.momo_canonical_identity('series_radar_candidates', "candidate_id"),
    "canonical_before_basis_id" = pg_temp.momo_canonical_identity('series_radar_bases', "before_basis_id");
--> statement-breakpoint
UPDATE public."series_radar_title_states"
SET "canonical_game_title_id" = pg_temp.momo_canonical_identity('game_titles', "game_title_id"),
    "canonical_desired_basis_id" = pg_temp.momo_canonical_identity('series_radar_bases', "desired_basis_id"),
    "canonical_current_basis_id" = pg_temp.momo_canonical_identity('series_radar_bases', "current_basis_id"),
    "canonical_previous_basis_id" = pg_temp.momo_canonical_identity('series_radar_bases', "previous_basis_id"),
    "canonical_active_operation_id" = pg_temp.momo_canonical_identity('series_radar_operations', "active_operation_id");
--> statement-breakpoint
UPDATE public."sessions"
SET "canonical_id" = pg_temp.momo_canonical_identity('sessions', "id");
--> statement-breakpoint
UPDATE public."source_images"
SET "canonical_id" = pg_temp.momo_canonical_identity('source_images', "id"),
    "canonical_owner_account_id" = pg_temp.momo_canonical_identity('momo_login_accounts', "owner_account_id");
--> statement-breakpoint
UPDATE public."worker_execution_slots"
SET "canonical_job_id" = pg_temp.momo_canonical_identity(CASE task_kind WHEN 'analysis' THEN 'series_analysis_jobs' WHEN 'ocr' THEN 'ocr_jobs' END, job_id),
    "canonical_attempt_id" = CASE task_kind WHEN 'analysis' THEN pg_temp.momo_canonical_identity('series_analysis_job_attempts', attempt_id) WHEN 'ocr' THEN attempt_id::uuid END;
