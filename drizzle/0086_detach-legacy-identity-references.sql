ALTER TABLE "app_sessions" DROP CONSTRAINT "app_sessions_account_id_momo_login_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "discord_notification_attendance" DROP CONSTRAINT "discord_notification_attendance_session_id_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "held_event_participants" DROP CONSTRAINT "held_event_participants_held_event_id_held_events_id_fk";
--> statement-breakpoint
ALTER TABLE "held_event_participants" DROP CONSTRAINT "held_event_participants_member_id_members_id_fk";
--> statement-breakpoint
ALTER TABLE "held_events" DROP CONSTRAINT "held_events_session_id_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "idempotency_keys" DROP CONSTRAINT "idempotency_keys_member_id_members_id_fk";
--> statement-breakpoint
ALTER TABLE "idempotency_keys" DROP CONSTRAINT "idempotency_keys_account_id_momo_login_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "map_masters" DROP CONSTRAINT "map_masters_game_title_id_game_titles_id_fk";
--> statement-breakpoint
ALTER TABLE "match_drafts" DROP CONSTRAINT "match_drafts_created_by_member_id_members_id_fk";
--> statement-breakpoint
ALTER TABLE "match_drafts" DROP CONSTRAINT "match_drafts_created_by_account_id_momo_login_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "match_drafts" DROP CONSTRAINT "match_drafts_held_event_id_held_events_id_fk";
--> statement-breakpoint
ALTER TABLE "match_drafts" DROP CONSTRAINT "match_drafts_game_title_id_game_titles_id_fk";
--> statement-breakpoint
ALTER TABLE "match_drafts" DROP CONSTRAINT "match_drafts_season_master_id_season_masters_id_fk";
--> statement-breakpoint
ALTER TABLE "match_drafts" DROP CONSTRAINT "match_drafts_owner_member_id_members_id_fk";
--> statement-breakpoint
ALTER TABLE "match_drafts" DROP CONSTRAINT "match_drafts_map_master_id_map_masters_id_fk";
--> statement-breakpoint
ALTER TABLE "match_drafts" DROP CONSTRAINT "match_drafts_confirmed_match_id_matches_id_fk";
--> statement-breakpoint
ALTER TABLE "match_incidents" DROP CONSTRAINT "match_incidents_match_id_matches_id_fk";
--> statement-breakpoint
ALTER TABLE "match_incidents" DROP CONSTRAINT "match_incidents_member_id_members_id_fk";
--> statement-breakpoint
ALTER TABLE "match_incidents" DROP CONSTRAINT "match_incidents_incident_master_id_incident_masters_id_fk";
--> statement-breakpoint
ALTER TABLE "match_players" DROP CONSTRAINT "match_players_match_id_matches_id_fk";
--> statement-breakpoint
ALTER TABLE "match_players" DROP CONSTRAINT "match_players_member_id_members_id_fk";
--> statement-breakpoint
ALTER TABLE "matches" DROP CONSTRAINT "matches_held_event_id_held_events_id_fk";
--> statement-breakpoint
ALTER TABLE "matches" DROP CONSTRAINT "matches_game_title_id_game_titles_id_fk";
--> statement-breakpoint
ALTER TABLE "matches" DROP CONSTRAINT "matches_season_master_id_season_masters_id_fk";
--> statement-breakpoint
ALTER TABLE "matches" DROP CONSTRAINT "matches_owner_member_id_members_id_fk";
--> statement-breakpoint
ALTER TABLE "matches" DROP CONSTRAINT "matches_map_master_id_map_masters_id_fk";
--> statement-breakpoint
ALTER TABLE "matches" DROP CONSTRAINT "matches_created_by_member_id_members_id_fk";
--> statement-breakpoint
ALTER TABLE "matches" DROP CONSTRAINT "matches_created_by_account_id_momo_login_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "matches" DROP CONSTRAINT "matches_note_updated_by_account_id_momo_login_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "member_aliases" DROP CONSTRAINT "member_aliases_member_id_members_id_fk";
--> statement-breakpoint
ALTER TABLE "momo_login_accounts" DROP CONSTRAINT "momo_login_accounts_player_member_id_members_id_fk";
--> statement-breakpoint
ALTER TABLE "ocr_jobs" DROP CONSTRAINT "ocr_jobs_source_image_id_source_images_id_fk";
--> statement-breakpoint
ALTER TABLE "ocr_submission_members" DROP CONSTRAINT "ocr_submission_members_submission_id_ocr_submissions_id_fk";
--> statement-breakpoint
ALTER TABLE "ocr_submission_members" DROP CONSTRAINT "ocr_submission_members_job_id_ocr_jobs_id_fk";
--> statement-breakpoint
ALTER TABLE "ocr_submissions" DROP CONSTRAINT "ocr_submissions_owner_account_id_momo_login_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "responses" DROP CONSTRAINT "responses_session_id_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "responses" DROP CONSTRAINT "responses_member_id_members_id_fk";
--> statement-breakpoint
ALTER TABLE "season_masters" DROP CONSTRAINT "season_masters_game_title_id_game_titles_id_fk";
--> statement-breakpoint
ALTER TABLE "series_analysis_artifacts" DROP CONSTRAINT "series_analysis_artifacts_game_title_id_game_titles_id_fk";
--> statement-breakpoint
ALTER TABLE "series_analysis_artifacts" DROP CONSTRAINT "series_analysis_artifacts_attempt_id_series_analysis_job_attempts_id_fk";
--> statement-breakpoint
ALTER TABLE "series_analysis_campaign_targets" DROP CONSTRAINT "series_analysis_campaign_targets_campaign_id_series_analysis_campaigns_id_fk";
--> statement-breakpoint
ALTER TABLE "series_analysis_campaigns" DROP CONSTRAINT "series_analysis_campaigns_operation_request_id_series_analysis_operation_requests_id_fk";
--> statement-breakpoint
ALTER TABLE "series_analysis_job_attempts" DROP CONSTRAINT "series_analysis_job_attempts_job_id_series_analysis_jobs_id_fk";
--> statement-breakpoint
ALTER TABLE "series_analysis_job_requests" DROP CONSTRAINT "series_analysis_job_requests_operation_request_id_series_analysis_operation_requests_id_fk";
--> statement-breakpoint
ALTER TABLE "series_analysis_job_requests" DROP CONSTRAINT "series_analysis_job_requests_campaign_id_series_analysis_campaigns_id_fk";
--> statement-breakpoint
ALTER TABLE "series_analysis_job_requests" DROP CONSTRAINT "series_analysis_job_requests_assigned_job_id_series_analysis_jobs_id_fk";
--> statement-breakpoint
ALTER TABLE "series_analysis_jobs" DROP CONSTRAINT "series_analysis_jobs_radar_basis_id_series_radar_bases_id_fk";
--> statement-breakpoint
ALTER TABLE "series_analysis_jobs" DROP CONSTRAINT "series_analysis_jobs_game_title_id_game_titles_id_fk";
--> statement-breakpoint
ALTER TABLE "series_analysis_operation_requests" DROP CONSTRAINT "series_analysis_operation_requests_requested_by_account_id_momo_login_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "series_analysis_title_states" DROP CONSTRAINT "series_analysis_title_states_game_title_id_game_titles_id_fk";
--> statement-breakpoint
ALTER TABLE "series_analysis_title_states" DROP CONSTRAINT "series_analysis_title_states_notification_baseline_artifact_fk";
--> statement-breakpoint
ALTER TABLE "series_analysis_title_states" DROP CONSTRAINT "series_analysis_title_states_current_artifact_fk";
--> statement-breakpoint
ALTER TABLE "series_analysis_title_states" DROP CONSTRAINT "series_analysis_title_states_previous_artifact_fk";
--> statement-breakpoint
ALTER TABLE "series_radar_acknowledgements" DROP CONSTRAINT "series_radar_acknowledgements_game_title_id_game_titles_id_fk";
--> statement-breakpoint
ALTER TABLE "series_radar_bases" DROP CONSTRAINT "series_radar_bases_game_title_id_game_titles_id_fk";
--> statement-breakpoint
ALTER TABLE "series_radar_candidates" DROP CONSTRAINT "series_radar_candidates_game_title_id_game_titles_id_fk";
--> statement-breakpoint
ALTER TABLE "series_radar_candidates" DROP CONSTRAINT "series_radar_candidate_basis_fk";
--> statement-breakpoint
ALTER TABLE "series_radar_candidates" DROP CONSTRAINT "series_radar_candidate_source_basis_fk";
--> statement-breakpoint
ALTER TABLE "series_radar_operations" DROP CONSTRAINT "series_radar_operations_game_title_id_game_titles_id_fk";
--> statement-breakpoint
ALTER TABLE "series_radar_operations" DROP CONSTRAINT "series_radar_operation_candidate_fk";
--> statement-breakpoint
ALTER TABLE "series_radar_operations" DROP CONSTRAINT "series_radar_operation_preview_fk";
--> statement-breakpoint
ALTER TABLE "series_radar_operations" DROP CONSTRAINT "series_radar_operation_basis_fk";
--> statement-breakpoint
ALTER TABLE "series_radar_preview_scopes" DROP CONSTRAINT "series_radar_preview_scopes_preview_id_series_radar_previews_id_fk";
--> statement-breakpoint
ALTER TABLE "series_radar_previews" DROP CONSTRAINT "series_radar_previews_game_title_id_game_titles_id_fk";
--> statement-breakpoint
ALTER TABLE "series_radar_previews" DROP CONSTRAINT "series_radar_preview_candidate_fk";
--> statement-breakpoint
ALTER TABLE "series_radar_previews" DROP CONSTRAINT "series_radar_preview_basis_fk";
--> statement-breakpoint
ALTER TABLE "series_radar_revisions" DROP CONSTRAINT "series_radar_revisions_game_title_id_game_titles_id_fk";
--> statement-breakpoint
ALTER TABLE "series_radar_revisions" DROP CONSTRAINT "series_radar_revision_operation_fk";
--> statement-breakpoint
ALTER TABLE "series_radar_revisions" DROP CONSTRAINT "series_radar_revision_candidate_fk";
--> statement-breakpoint
ALTER TABLE "series_radar_title_states" DROP CONSTRAINT "series_radar_title_states_game_title_id_game_titles_id_fk";
--> statement-breakpoint
ALTER TABLE "series_radar_title_states" DROP CONSTRAINT "series_radar_state_desired_basis_fk";
--> statement-breakpoint
ALTER TABLE "series_radar_title_states" DROP CONSTRAINT "series_radar_state_current_basis_fk";
--> statement-breakpoint
ALTER TABLE "series_radar_title_states" DROP CONSTRAINT "series_radar_state_previous_basis_fk";
--> statement-breakpoint
ALTER TABLE "series_radar_title_states" DROP CONSTRAINT "series_radar_state_operation_fk";
--> statement-breakpoint
ALTER TABLE "source_images" DROP CONSTRAINT "source_images_owner_account_id_momo_login_accounts_id_fk";
