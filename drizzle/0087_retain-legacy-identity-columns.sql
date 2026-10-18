ALTER TABLE "idempotency_keys" RENAME TO "idempotency_keys_legacy";--> statement-breakpoint
ALTER TABLE "app_sessions" RENAME COLUMN "member_id" TO "legacy_member_id";--> statement-breakpoint
ALTER TABLE "app_sessions" RENAME COLUMN "account_id" TO "legacy_account_id";--> statement-breakpoint
ALTER TABLE "game_titles" RENAME COLUMN "id" TO "legacy_id";--> statement-breakpoint
ALTER TABLE "held_event_participants" RENAME COLUMN "held_event_id" TO "legacy_held_event_id";--> statement-breakpoint
ALTER TABLE "held_event_participants" RENAME COLUMN "member_id" TO "legacy_member_id";--> statement-breakpoint
ALTER TABLE "held_events" RENAME COLUMN "id" TO "legacy_id";--> statement-breakpoint
ALTER TABLE "held_events" RENAME COLUMN "session_id" TO "legacy_session_id";--> statement-breakpoint
ALTER TABLE "incident_masters" RENAME COLUMN "id" TO "legacy_id";--> statement-breakpoint
ALTER TABLE "map_masters" RENAME COLUMN "id" TO "legacy_id";--> statement-breakpoint
ALTER TABLE "map_masters" RENAME COLUMN "game_title_id" TO "legacy_game_title_id";--> statement-breakpoint
ALTER TABLE "match_drafts" RENAME COLUMN "id" TO "legacy_id";--> statement-breakpoint
ALTER TABLE "match_drafts" RENAME COLUMN "created_by_member_id" TO "legacy_created_by_member_id";--> statement-breakpoint
ALTER TABLE "match_drafts" RENAME COLUMN "created_by_account_id" TO "legacy_created_by_account_id";--> statement-breakpoint
ALTER TABLE "match_drafts" RENAME COLUMN "held_event_id" TO "legacy_held_event_id";--> statement-breakpoint
ALTER TABLE "match_drafts" RENAME COLUMN "game_title_id" TO "legacy_game_title_id";--> statement-breakpoint
ALTER TABLE "match_drafts" RENAME COLUMN "season_master_id" TO "legacy_season_master_id";--> statement-breakpoint
ALTER TABLE "match_drafts" RENAME COLUMN "owner_member_id" TO "legacy_owner_member_id";--> statement-breakpoint
ALTER TABLE "match_drafts" RENAME COLUMN "map_master_id" TO "legacy_map_master_id";--> statement-breakpoint
ALTER TABLE "match_drafts" RENAME COLUMN "total_assets_draft_id" TO "legacy_total_assets_draft_id";--> statement-breakpoint
ALTER TABLE "match_drafts" RENAME COLUMN "revenue_draft_id" TO "legacy_revenue_draft_id";--> statement-breakpoint
ALTER TABLE "match_drafts" RENAME COLUMN "incident_log_draft_id" TO "legacy_incident_log_draft_id";--> statement-breakpoint
ALTER TABLE "match_drafts" RENAME COLUMN "confirmed_match_id" TO "legacy_confirmed_match_id";--> statement-breakpoint
ALTER TABLE "match_incidents" RENAME COLUMN "match_id" TO "legacy_match_id";--> statement-breakpoint
ALTER TABLE "match_incidents" RENAME COLUMN "member_id" TO "legacy_member_id";--> statement-breakpoint
ALTER TABLE "match_incidents" RENAME COLUMN "incident_master_id" TO "legacy_incident_master_id";--> statement-breakpoint
ALTER TABLE "match_players" RENAME COLUMN "match_id" TO "legacy_match_id";--> statement-breakpoint
ALTER TABLE "match_players" RENAME COLUMN "member_id" TO "legacy_member_id";--> statement-breakpoint
ALTER TABLE "matches" RENAME COLUMN "id" TO "legacy_id";--> statement-breakpoint
ALTER TABLE "matches" RENAME COLUMN "held_event_id" TO "legacy_held_event_id";--> statement-breakpoint
ALTER TABLE "matches" RENAME COLUMN "game_title_id" TO "legacy_game_title_id";--> statement-breakpoint
ALTER TABLE "matches" RENAME COLUMN "season_master_id" TO "legacy_season_master_id";--> statement-breakpoint
ALTER TABLE "matches" RENAME COLUMN "owner_member_id" TO "legacy_owner_member_id";--> statement-breakpoint
ALTER TABLE "matches" RENAME COLUMN "map_master_id" TO "legacy_map_master_id";--> statement-breakpoint
ALTER TABLE "matches" RENAME COLUMN "created_by_member_id" TO "legacy_created_by_member_id";--> statement-breakpoint
ALTER TABLE "matches" RENAME COLUMN "created_by_account_id" TO "legacy_created_by_account_id";--> statement-breakpoint
ALTER TABLE "matches" RENAME COLUMN "note_updated_by_account_id" TO "legacy_note_updated_by_account_id";--> statement-breakpoint
ALTER TABLE "member_aliases" RENAME COLUMN "id" TO "legacy_id";--> statement-breakpoint
ALTER TABLE "member_aliases" RENAME COLUMN "member_id" TO "legacy_member_id";--> statement-breakpoint
ALTER TABLE "members" RENAME COLUMN "id" TO "legacy_id";--> statement-breakpoint
ALTER TABLE "momo_login_accounts" RENAME COLUMN "id" TO "legacy_id";--> statement-breakpoint
ALTER TABLE "momo_login_accounts" RENAME COLUMN "player_member_id" TO "legacy_player_member_id";--> statement-breakpoint
ALTER TABLE "ocr_drafts" RENAME COLUMN "id" TO "legacy_id";--> statement-breakpoint
ALTER TABLE "ocr_drafts" RENAME COLUMN "job_id" TO "legacy_job_id";--> statement-breakpoint
ALTER TABLE "ocr_jobs" RENAME COLUMN "id" TO "legacy_id";--> statement-breakpoint
ALTER TABLE "ocr_jobs" RENAME COLUMN "draft_id" TO "legacy_draft_id";--> statement-breakpoint
ALTER TABLE "ocr_jobs" RENAME COLUMN "source_image_id" TO "legacy_source_image_id";--> statement-breakpoint
ALTER TABLE "ocr_submission_members" RENAME COLUMN "submission_id" TO "legacy_submission_id";--> statement-breakpoint
ALTER TABLE "ocr_submission_members" RENAME COLUMN "job_id" TO "legacy_job_id";--> statement-breakpoint
ALTER TABLE "ocr_submissions" RENAME COLUMN "id" TO "legacy_id";--> statement-breakpoint
ALTER TABLE "ocr_submissions" RENAME COLUMN "owner_account_id" TO "legacy_owner_account_id";--> statement-breakpoint
ALTER TABLE "ocr_submissions" RENAME COLUMN "match_draft_id" TO "legacy_match_draft_id";--> statement-breakpoint
ALTER TABLE "responses" RENAME COLUMN "id" TO "legacy_id";--> statement-breakpoint
ALTER TABLE "responses" RENAME COLUMN "session_id" TO "legacy_session_id";--> statement-breakpoint
ALTER TABLE "responses" RENAME COLUMN "member_id" TO "legacy_member_id";--> statement-breakpoint
ALTER TABLE "season_masters" RENAME COLUMN "id" TO "legacy_id";--> statement-breakpoint
ALTER TABLE "season_masters" RENAME COLUMN "game_title_id" TO "legacy_game_title_id";--> statement-breakpoint
ALTER TABLE "series_analysis_campaign_targets" RENAME COLUMN "campaign_id" TO "legacy_campaign_id";--> statement-breakpoint
ALTER TABLE "series_analysis_campaign_targets" RENAME COLUMN "game_title_id" TO "legacy_game_title_id";--> statement-breakpoint
ALTER TABLE "series_analysis_campaign_targets" RENAME COLUMN "job_request_id" TO "legacy_job_request_id";--> statement-breakpoint
ALTER TABLE "series_analysis_campaigns" RENAME COLUMN "id" TO "legacy_id";--> statement-breakpoint
ALTER TABLE "series_analysis_campaigns" RENAME COLUMN "operation_request_id" TO "legacy_operation_request_id";--> statement-breakpoint
ALTER TABLE "series_analysis_job_attempts" RENAME COLUMN "id" TO "legacy_id";--> statement-breakpoint
ALTER TABLE "series_analysis_job_attempts" RENAME COLUMN "job_id" TO "legacy_job_id";--> statement-breakpoint
ALTER TABLE "series_analysis_job_requests" RENAME COLUMN "id" TO "legacy_id";--> statement-breakpoint
ALTER TABLE "series_analysis_job_requests" RENAME COLUMN "game_title_id" TO "legacy_game_title_id";--> statement-breakpoint
ALTER TABLE "series_analysis_job_requests" RENAME COLUMN "operation_request_id" TO "legacy_operation_request_id";--> statement-breakpoint
ALTER TABLE "series_analysis_job_requests" RENAME COLUMN "campaign_id" TO "legacy_campaign_id";--> statement-breakpoint
ALTER TABLE "series_analysis_job_requests" RENAME COLUMN "assigned_job_id" TO "legacy_assigned_job_id";--> statement-breakpoint
ALTER TABLE "series_analysis_job_requests" RENAME COLUMN "assigned_attempt_id" TO "legacy_assigned_attempt_id";--> statement-breakpoint
ALTER TABLE "series_analysis_jobs" RENAME COLUMN "id" TO "legacy_id";--> statement-breakpoint
ALTER TABLE "series_analysis_jobs" RENAME COLUMN "radar_operation_id" TO "legacy_radar_operation_id";--> statement-breakpoint
ALTER TABLE "series_analysis_jobs" RENAME COLUMN "radar_basis_id" TO "legacy_radar_basis_id";--> statement-breakpoint
ALTER TABLE "series_analysis_jobs" RENAME COLUMN "game_title_id" TO "legacy_game_title_id";--> statement-breakpoint
ALTER TABLE "series_analysis_jobs" RENAME COLUMN "lease_attempt_id" TO "legacy_lease_attempt_id";--> statement-breakpoint
ALTER TABLE "series_analysis_operation_requests" RENAME COLUMN "id" TO "legacy_id";--> statement-breakpoint
ALTER TABLE "series_analysis_operation_requests" RENAME COLUMN "game_title_id" TO "legacy_game_title_id";--> statement-breakpoint
ALTER TABLE "series_analysis_operation_requests" RENAME COLUMN "requested_by_account_id" TO "legacy_requested_by_account_id";--> statement-breakpoint
ALTER TABLE "series_analysis_title_states" RENAME COLUMN "game_title_id" TO "legacy_game_title_id";--> statement-breakpoint
ALTER TABLE "series_analysis_title_states" RENAME COLUMN "current_artifact_id" TO "legacy_current_artifact_id";--> statement-breakpoint
ALTER TABLE "series_analysis_title_states" RENAME COLUMN "previous_artifact_id" TO "legacy_previous_artifact_id";--> statement-breakpoint
ALTER TABLE "series_analysis_title_states" RENAME COLUMN "notification_baseline_artifact_id" TO "legacy_notification_baseline_artifact_id";--> statement-breakpoint
ALTER TABLE "series_radar_acknowledgements" RENAME COLUMN "game_title_id" TO "legacy_game_title_id";--> statement-breakpoint
ALTER TABLE "series_radar_acknowledgements" RENAME COLUMN "requested_by" TO "legacy_requested_by";--> statement-breakpoint
ALTER TABLE "series_radar_candidates" RENAME COLUMN "id" TO "legacy_id";--> statement-breakpoint
ALTER TABLE "series_radar_candidates" RENAME COLUMN "game_title_id" TO "legacy_game_title_id";--> statement-breakpoint
ALTER TABLE "series_radar_candidates" RENAME COLUMN "basis_id" TO "legacy_basis_id";--> statement-breakpoint
ALTER TABLE "series_radar_operations" RENAME COLUMN "id" TO "legacy_id";--> statement-breakpoint
ALTER TABLE "series_radar_operations" RENAME COLUMN "game_title_id" TO "legacy_game_title_id";--> statement-breakpoint
ALTER TABLE "series_radar_operations" RENAME COLUMN "candidate_id" TO "legacy_candidate_id";--> statement-breakpoint
ALTER TABLE "series_radar_operations" RENAME COLUMN "preview_id" TO "legacy_preview_id";--> statement-breakpoint
ALTER TABLE "series_radar_operations" RENAME COLUMN "basis_id" TO "legacy_basis_id";--> statement-breakpoint
ALTER TABLE "series_radar_operations" RENAME COLUMN "origin_operation_id" TO "legacy_origin_operation_id";--> statement-breakpoint
ALTER TABLE "series_radar_operations" RENAME COLUMN "requested_by" TO "legacy_requested_by";--> statement-breakpoint
ALTER TABLE "series_radar_operations" RENAME COLUMN "job_id" TO "legacy_job_id";--> statement-breakpoint
ALTER TABLE "series_radar_preview_scopes" RENAME COLUMN "preview_id" TO "legacy_preview_id";--> statement-breakpoint
ALTER TABLE "series_radar_previews" RENAME COLUMN "id" TO "legacy_id";--> statement-breakpoint
ALTER TABLE "series_radar_previews" RENAME COLUMN "game_title_id" TO "legacy_game_title_id";--> statement-breakpoint
ALTER TABLE "series_radar_previews" RENAME COLUMN "candidate_id" TO "legacy_candidate_id";--> statement-breakpoint
ALTER TABLE "series_radar_previews" RENAME COLUMN "before_basis_id" TO "legacy_before_basis_id";--> statement-breakpoint
ALTER TABLE "series_radar_title_states" RENAME COLUMN "game_title_id" TO "legacy_game_title_id";--> statement-breakpoint
ALTER TABLE "series_radar_title_states" RENAME COLUMN "desired_basis_id" TO "legacy_desired_basis_id";--> statement-breakpoint
ALTER TABLE "series_radar_title_states" RENAME COLUMN "current_basis_id" TO "legacy_current_basis_id";--> statement-breakpoint
ALTER TABLE "series_radar_title_states" RENAME COLUMN "previous_basis_id" TO "legacy_previous_basis_id";--> statement-breakpoint
ALTER TABLE "series_radar_title_states" RENAME COLUMN "active_operation_id" TO "legacy_active_operation_id";--> statement-breakpoint
ALTER TABLE "sessions" RENAME COLUMN "id" TO "legacy_id";--> statement-breakpoint
ALTER TABLE "source_images" RENAME COLUMN "id" TO "legacy_id";--> statement-breakpoint
ALTER TABLE "source_images" RENAME COLUMN "owner_account_id" TO "legacy_owner_account_id";--> statement-breakpoint
ALTER TABLE "worker_execution_slots" RENAME COLUMN "job_id" TO "legacy_job_id";--> statement-breakpoint
ALTER TABLE "worker_execution_slots" RENAME COLUMN "attempt_id" TO "legacy_attempt_id";--> statement-breakpoint
ALTER TABLE "held_events" DROP CONSTRAINT "held_events_session_id_unique";--> statement-breakpoint
ALTER TABLE "series_analysis_campaigns" DROP CONSTRAINT "series_analysis_campaigns_operation_request_id_unique";--> statement-breakpoint
ALTER TABLE "series_radar_candidates" DROP CONSTRAINT "series_radar_candidates_id_title_unique";--> statement-breakpoint
ALTER TABLE "series_radar_operations" DROP CONSTRAINT "series_radar_operations_id_title_unique";--> statement-breakpoint
ALTER TABLE "series_radar_previews" DROP CONSTRAINT "series_radar_previews_id_title_unique";--> statement-breakpoint
ALTER TABLE "matches" DROP CONSTRAINT "matches_note_shape_check";--> statement-breakpoint
ALTER TABLE "ocr_jobs" DROP CONSTRAINT "ocr_jobs_input_snapshot_check";--> statement-breakpoint
ALTER TABLE "ocr_submission_members" DROP CONSTRAINT "ocr_submission_members_shape_check";--> statement-breakpoint
ALTER TABLE "ocr_submissions" DROP CONSTRAINT "ocr_submissions_id_check";--> statement-breakpoint
ALTER TABLE "series_analysis_jobs" DROP CONSTRAINT "series_analysis_jobs_radar_purpose_check";--> statement-breakpoint
ALTER TABLE "series_analysis_jobs" DROP CONSTRAINT "series_analysis_jobs_lease_shape_check";--> statement-breakpoint
ALTER TABLE "series_analysis_operation_requests" DROP CONSTRAINT "series_analysis_operation_requests_scope_title_check";--> statement-breakpoint
ALTER TABLE "series_analysis_title_states" DROP CONSTRAINT "series_analysis_title_states_artifact_pointer_distinct_check";--> statement-breakpoint
ALTER TABLE "series_analysis_title_states" DROP CONSTRAINT "series_analysis_title_states_notification_baseline_check";--> statement-breakpoint
ALTER TABLE "series_radar_title_states" DROP CONSTRAINT "series_radar_states_current_pair_check";--> statement-breakpoint
ALTER TABLE "series_radar_title_states" DROP CONSTRAINT "series_radar_states_previous_pair_check";--> statement-breakpoint
ALTER TABLE "series_radar_title_states" DROP CONSTRAINT "series_radar_states_distinct_check";--> statement-breakpoint
ALTER TABLE "worker_execution_slots" DROP CONSTRAINT "worker_execution_slots_holder_shape_check";--> statement-breakpoint
DROP INDEX "idempotency_keys_account_expires_at_idx";--> statement-breakpoint
DROP INDEX "idempotency_keys_expires_at_idx";--> statement-breakpoint
DROP INDEX "app_sessions_member_id_idx";--> statement-breakpoint
DROP INDEX "app_sessions_account_id_idx";--> statement-breakpoint
DROP INDEX "held_events_navigation_idx";--> statement-breakpoint
DROP INDEX "map_masters_title_name_unique";--> statement-breakpoint
DROP INDEX "match_drafts_created_by_status_idx";--> statement-breakpoint
DROP INDEX "match_drafts_created_by_account_status_idx";--> statement-breakpoint
DROP INDEX "match_drafts_held_event_id_idx";--> statement-breakpoint
DROP INDEX "match_drafts_confirmed_match_id_unique";--> statement-breakpoint
DROP INDEX "match_incidents_match_id_idx";--> statement-breakpoint
DROP INDEX "match_players_match_play_order_unique";--> statement-breakpoint
DROP INDEX "match_players_match_rank_unique";--> statement-breakpoint
DROP INDEX "matches_event_match_no_unique";--> statement-breakpoint
DROP INDEX "matches_title_held_event_idx";--> statement-breakpoint
DROP INDEX "matches_title_scope_idx";--> statement-breakpoint
DROP INDEX "matches_held_event_id_idx";--> statement-breakpoint
DROP INDEX "matches_created_by_account_id_idx";--> statement-breakpoint
DROP INDEX "matches_navigation_idx";--> statement-breakpoint
DROP INDEX "member_aliases_member_alias_unique";--> statement-breakpoint
DROP INDEX "momo_login_accounts_player_member_id_idx";--> statement-breakpoint
DROP INDEX "ocr_drafts_job_id_unique";--> statement-breakpoint
DROP INDEX "ocr_jobs_draft_id_unique";--> statement-breakpoint
DROP INDEX "ocr_jobs_source_image_id_idx";--> statement-breakpoint
DROP INDEX "ocr_jobs_claimable_idx";--> statement-breakpoint
DROP INDEX "ocr_submission_members_job_unique";--> statement-breakpoint
DROP INDEX "ocr_submission_members_upload_unique";--> statement-breakpoint
DROP INDEX "ocr_submissions_status_id_idx";--> statement-breakpoint
DROP INDEX "ocr_submissions_status_deadline_idx";--> statement-breakpoint
DROP INDEX "ocr_submissions_owner_status_idx";--> statement-breakpoint
DROP INDEX "ocr_submissions_draft_status_idx";--> statement-breakpoint
DROP INDEX "responses_session_member_unique";--> statement-breakpoint
DROP INDEX "season_masters_title_name_unique";--> statement-breakpoint
DROP INDEX "series_analysis_campaign_targets_pending_idx";--> statement-breakpoint
DROP INDEX "series_analysis_campaign_targets_job_request_unique";--> statement-breakpoint
DROP INDEX "series_analysis_job_attempts_job_no_unique";--> statement-breakpoint
DROP INDEX "series_analysis_job_requests_pending_title_idx";--> statement-breakpoint
DROP INDEX "series_analysis_job_requests_operation_idx";--> statement-breakpoint
DROP INDEX "series_analysis_job_requests_campaign_idx";--> statement-breakpoint
DROP INDEX "series_analysis_job_requests_job_idx";--> statement-breakpoint
DROP INDEX "series_analysis_job_requests_attempt_idx";--> statement-breakpoint
DROP INDEX "series_analysis_jobs_title_terminal_idx";--> statement-breakpoint
DROP INDEX "series_analysis_jobs_recent_idx";--> statement-breakpoint
DROP INDEX "series_analysis_jobs_active_title_unique";--> statement-breakpoint
DROP INDEX "series_analysis_jobs_claim_idx";--> statement-breakpoint
DROP INDEX "series_analysis_operation_requests_idempotency_unique";--> statement-breakpoint
DROP INDEX "series_radar_candidates_active_unique";--> statement-breakpoint
DROP INDEX "series_radar_candidates_title_created_idx";--> statement-breakpoint
DROP INDEX "series_radar_operations_idempotency_unique";--> statement-breakpoint
DROP INDEX "series_radar_operations_pending_idx";--> statement-breakpoint
DROP INDEX "series_radar_operations_title_created_idx";--> statement-breakpoint
DROP INDEX "series_radar_previews_candidate_created_idx";--> statement-breakpoint
DROP INDEX "source_images_owner_idempotency_unique";--> statement-breakpoint
ALTER TABLE "held_event_participants" DROP CONSTRAINT "held_event_participants_held_event_id_member_id_pk";--> statement-breakpoint
-- Applied migration 0013 names this PK idempotency_keys_pkey; the old
-- snapshot inferred a different name. Preserve the generated replacement
-- transition using the actual applied constraint name.
ALTER TABLE "idempotency_keys_legacy" DROP CONSTRAINT "idempotency_keys_pkey";--> statement-breakpoint
ALTER TABLE "match_incidents" DROP CONSTRAINT "match_incidents_match_id_member_id_incident_master_id_pk";--> statement-breakpoint
ALTER TABLE "match_players" DROP CONSTRAINT "match_players_match_id_member_id_pk";--> statement-breakpoint
ALTER TABLE "ocr_submission_members" DROP CONSTRAINT "ocr_submission_members_submission_id_screen_type_pk";--> statement-breakpoint
ALTER TABLE "series_analysis_campaign_targets" DROP CONSTRAINT "series_analysis_campaign_targets_campaign_id_game_title_id_pk";--> statement-breakpoint
ALTER TABLE "series_radar_acknowledgements" DROP CONSTRAINT "series_radar_acknowledgements_game_title_id_evidence_key_pk";--> statement-breakpoint
ALTER TABLE "series_radar_preview_scopes" DROP CONSTRAINT "series_radar_preview_scopes_preview_id_scope_key_pk";--> statement-breakpoint
ALTER TABLE "held_event_participants" ADD CONSTRAINT "held_event_participants_legacy_held_event_id_legacy_member_id_pk" PRIMARY KEY("legacy_held_event_id","legacy_member_id");--> statement-breakpoint
ALTER TABLE "idempotency_keys_legacy" ADD CONSTRAINT "idempotency_keys_legacy_key_account_id_endpoint_pk" PRIMARY KEY("key","account_id","endpoint");--> statement-breakpoint
ALTER TABLE "match_incidents" ADD CONSTRAINT "match_incidents_legacy_match_id_legacy_member_id_legacy_incident_master_id_pk" PRIMARY KEY("legacy_match_id","legacy_member_id","legacy_incident_master_id");--> statement-breakpoint
ALTER TABLE "match_players" ADD CONSTRAINT "match_players_legacy_match_id_legacy_member_id_pk" PRIMARY KEY("legacy_match_id","legacy_member_id");--> statement-breakpoint
ALTER TABLE "ocr_submission_members" ADD CONSTRAINT "ocr_submission_members_legacy_submission_id_screen_type_pk" PRIMARY KEY("legacy_submission_id","screen_type");--> statement-breakpoint
ALTER TABLE "series_analysis_campaign_targets" ADD CONSTRAINT "series_analysis_campaign_targets_legacy_campaign_id_legacy_game_title_id_pk" PRIMARY KEY("legacy_campaign_id","legacy_game_title_id");--> statement-breakpoint
ALTER TABLE "series_radar_acknowledgements" ADD CONSTRAINT "series_radar_acknowledgements_legacy_game_title_id_evidence_key_pk" PRIMARY KEY("legacy_game_title_id","evidence_key");--> statement-breakpoint
ALTER TABLE "series_radar_preview_scopes" ADD CONSTRAINT "series_radar_preview_scopes_legacy_preview_id_scope_key_pk" PRIMARY KEY("legacy_preview_id","scope_key");--> statement-breakpoint
CREATE INDEX "idempotency_keys_legacy_account_expires_at_idx" ON "idempotency_keys_legacy" USING btree ("account_id","expires_at");--> statement-breakpoint
CREATE INDEX "idempotency_keys_legacy_expires_at_idx" ON "idempotency_keys_legacy" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "app_sessions_member_id_idx" ON "app_sessions" USING btree ("legacy_member_id");--> statement-breakpoint
CREATE INDEX "app_sessions_account_id_idx" ON "app_sessions" USING btree ("legacy_account_id");--> statement-breakpoint
CREATE INDEX "held_events_navigation_idx" ON "held_events" USING btree ("start_at","legacy_id" COLLATE "C");--> statement-breakpoint
CREATE UNIQUE INDEX "map_masters_title_name_unique" ON "map_masters" USING btree ("legacy_game_title_id","name");--> statement-breakpoint
CREATE INDEX "match_drafts_created_by_status_idx" ON "match_drafts" USING btree ("legacy_created_by_member_id","status");--> statement-breakpoint
CREATE INDEX "match_drafts_created_by_account_status_idx" ON "match_drafts" USING btree ("legacy_created_by_account_id","status");--> statement-breakpoint
CREATE INDEX "match_drafts_held_event_id_idx" ON "match_drafts" USING btree ("legacy_held_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "match_drafts_confirmed_match_id_unique" ON "match_drafts" USING btree ("legacy_confirmed_match_id");--> statement-breakpoint
CREATE INDEX "match_incidents_match_id_idx" ON "match_incidents" USING btree ("legacy_match_id");--> statement-breakpoint
CREATE UNIQUE INDEX "match_players_match_play_order_unique" ON "match_players" USING btree ("legacy_match_id","play_order");--> statement-breakpoint
CREATE UNIQUE INDEX "match_players_match_rank_unique" ON "match_players" USING btree ("legacy_match_id","rank");--> statement-breakpoint
CREATE UNIQUE INDEX "matches_event_match_no_unique" ON "matches" USING btree ("legacy_held_event_id","match_no_in_event");--> statement-breakpoint
CREATE INDEX "matches_title_held_event_idx" ON "matches" USING btree ("legacy_game_title_id","legacy_held_event_id");--> statement-breakpoint
CREATE INDEX "matches_title_scope_idx" ON "matches" USING btree ("legacy_game_title_id","legacy_season_master_id","legacy_map_master_id");--> statement-breakpoint
CREATE INDEX "matches_held_event_id_idx" ON "matches" USING btree ("legacy_held_event_id");--> statement-breakpoint
CREATE INDEX "matches_created_by_account_id_idx" ON "matches" USING btree ("legacy_created_by_account_id");--> statement-breakpoint
CREATE INDEX "matches_navigation_idx" ON "matches" USING btree ("played_at","legacy_held_event_id" COLLATE "C","match_no_in_event","legacy_id" COLLATE "C");--> statement-breakpoint
CREATE UNIQUE INDEX "member_aliases_member_alias_unique" ON "member_aliases" USING btree ("legacy_member_id","alias");--> statement-breakpoint
CREATE INDEX "momo_login_accounts_player_member_id_idx" ON "momo_login_accounts" USING btree ("legacy_player_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ocr_drafts_job_id_unique" ON "ocr_drafts" USING btree ("legacy_job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ocr_jobs_draft_id_unique" ON "ocr_jobs" USING btree ("legacy_draft_id");--> statement-breakpoint
CREATE INDEX "ocr_jobs_source_image_id_idx" ON "ocr_jobs" USING btree ("legacy_source_image_id");--> statement-breakpoint
CREATE INDEX "ocr_jobs_claimable_idx" ON "ocr_jobs" USING btree ("available_at","created_at","legacy_id") WHERE "ocr_jobs"."status" = 'queued';--> statement-breakpoint
CREATE UNIQUE INDEX "ocr_submission_members_job_unique" ON "ocr_submission_members" USING btree ("legacy_job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ocr_submission_members_upload_unique" ON "ocr_submission_members" USING btree ("legacy_submission_id","upload_idempotency_key_hash");--> statement-breakpoint
CREATE INDEX "ocr_submissions_status_id_idx" ON "ocr_submissions" USING btree ("status","legacy_id");--> statement-breakpoint
CREATE INDEX "ocr_submissions_status_deadline_idx" ON "ocr_submissions" USING btree ("status","admission_deadline","legacy_id");--> statement-breakpoint
CREATE INDEX "ocr_submissions_owner_status_idx" ON "ocr_submissions" USING btree ("legacy_owner_account_id","status");--> statement-breakpoint
CREATE INDEX "ocr_submissions_draft_status_idx" ON "ocr_submissions" USING btree ("legacy_match_draft_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "responses_session_member_unique" ON "responses" USING btree ("legacy_session_id","legacy_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "season_masters_title_name_unique" ON "season_masters" USING btree ("legacy_game_title_id","name");--> statement-breakpoint
CREATE INDEX "series_analysis_campaign_targets_pending_idx" ON "series_analysis_campaign_targets" USING btree ("accepted_at","legacy_campaign_id","legacy_game_title_id") WHERE "series_analysis_campaign_targets"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "series_analysis_campaign_targets_job_request_unique" ON "series_analysis_campaign_targets" USING btree ("legacy_job_request_id") WHERE "series_analysis_campaign_targets"."legacy_job_request_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "series_analysis_job_attempts_job_no_unique" ON "series_analysis_job_attempts" USING btree ("legacy_job_id","attempt_no");--> statement-breakpoint
CREATE INDEX "series_analysis_job_requests_pending_title_idx" ON "series_analysis_job_requests" USING btree ("legacy_game_title_id","accepted_at","legacy_id") WHERE "series_analysis_job_requests"."status" IN ('pending','assigned');--> statement-breakpoint
CREATE INDEX "series_analysis_job_requests_operation_idx" ON "series_analysis_job_requests" USING btree ("legacy_operation_request_id") WHERE "series_analysis_job_requests"."legacy_operation_request_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "series_analysis_job_requests_campaign_idx" ON "series_analysis_job_requests" USING btree ("legacy_campaign_id") WHERE "series_analysis_job_requests"."legacy_campaign_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "series_analysis_job_requests_job_idx" ON "series_analysis_job_requests" USING btree ("legacy_assigned_job_id","accepted_at","legacy_id") WHERE "series_analysis_job_requests"."legacy_assigned_job_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "series_analysis_job_requests_attempt_idx" ON "series_analysis_job_requests" USING btree ("legacy_assigned_attempt_id") WHERE "series_analysis_job_requests"."legacy_assigned_attempt_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "series_analysis_jobs_title_terminal_idx" ON "series_analysis_jobs" USING btree ("legacy_game_title_id","finished_at" DESC NULLS LAST,"legacy_id" DESC NULLS FIRST) WHERE "series_analysis_jobs"."work_kind" = 'analysis' AND "series_analysis_jobs"."status" IN ('succeeded','failed','timed_out');--> statement-breakpoint
CREATE INDEX "series_analysis_jobs_recent_idx" ON "series_analysis_jobs" USING btree ("created_at" DESC NULLS FIRST,"legacy_id" DESC NULLS FIRST) WHERE "series_analysis_jobs"."work_kind" = 'analysis';--> statement-breakpoint
CREATE UNIQUE INDEX "series_analysis_jobs_active_title_unique" ON "series_analysis_jobs" USING btree ("legacy_game_title_id") WHERE "series_analysis_jobs"."status" IN ('queued','running');--> statement-breakpoint
CREATE INDEX "series_analysis_jobs_claim_idx" ON "series_analysis_jobs" USING btree ("available_at","requested_at","legacy_id") WHERE "series_analysis_jobs"."status" = 'queued';--> statement-breakpoint
CREATE UNIQUE INDEX "series_analysis_operation_requests_idempotency_unique" ON "series_analysis_operation_requests" USING btree ("legacy_requested_by_account_id","endpoint","idempotency_key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "series_radar_candidates_active_unique" ON "series_radar_candidates" USING btree ("legacy_game_title_id") WHERE "series_radar_candidates"."status" IN ('pending','ready','unavailable','failed');--> statement-breakpoint
CREATE INDEX "series_radar_candidates_title_created_idx" ON "series_radar_candidates" USING btree ("legacy_game_title_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "series_radar_operations_idempotency_unique" ON "series_radar_operations" USING btree ("legacy_game_title_id","legacy_requested_by","idempotency_key_hash");--> statement-breakpoint
CREATE INDEX "series_radar_operations_pending_idx" ON "series_radar_operations" USING btree ("requested_at","legacy_id") WHERE "series_radar_operations"."status" = 'pending' AND "series_radar_operations"."legacy_job_id" IS NULL;--> statement-breakpoint
CREATE INDEX "series_radar_operations_title_created_idx" ON "series_radar_operations" USING btree ("legacy_game_title_id","requested_at");--> statement-breakpoint
CREATE INDEX "series_radar_previews_candidate_created_idx" ON "series_radar_previews" USING btree ("legacy_candidate_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "source_images_owner_idempotency_unique" ON "source_images" USING btree ("legacy_owner_account_id","idempotency_key_hash");--> statement-breakpoint
ALTER TABLE "held_events" ADD CONSTRAINT "held_events_legacy_session_id_unique" UNIQUE("legacy_session_id");--> statement-breakpoint
ALTER TABLE "series_analysis_campaigns" ADD CONSTRAINT "series_analysis_campaigns_legacy_operation_request_id_unique" UNIQUE("legacy_operation_request_id");--> statement-breakpoint
ALTER TABLE "series_radar_candidates" ADD CONSTRAINT "series_radar_candidates_id_title_unique" UNIQUE("legacy_id","legacy_game_title_id");--> statement-breakpoint
ALTER TABLE "series_radar_operations" ADD CONSTRAINT "series_radar_operations_id_title_unique" UNIQUE("legacy_id","legacy_game_title_id");--> statement-breakpoint
ALTER TABLE "series_radar_previews" ADD CONSTRAINT "series_radar_previews_id_title_unique" UNIQUE("legacy_id","legacy_game_title_id");--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_note_shape_check" CHECK ((
        ("matches"."note_version" = 0 AND "matches"."note_body" IS NULL AND "matches"."legacy_note_updated_by_account_id" IS NULL AND "matches"."note_updated_at" IS NULL)
        OR
        ("matches"."note_version" > 0 AND "matches"."legacy_note_updated_by_account_id" IS NOT NULL AND "matches"."note_updated_at" IS NOT NULL)
      ));--> statement-breakpoint
ALTER TABLE "ocr_jobs" ADD CONSTRAINT "ocr_jobs_input_snapshot_check" CHECK (("ocr_jobs"."input_snapshot" IS NULL AND "ocr_jobs"."status" IN ('succeeded','failed','cancelled')) OR ("ocr_jobs"."input_snapshot" IS NOT NULL AND jsonb_typeof("ocr_jobs"."input_snapshot") = 'object' AND COALESCE("ocr_jobs"."input_snapshot"->'schemaVersion' = '"2"'::jsonb, false) AND "ocr_jobs"."legacy_source_image_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "ocr_submission_members" ADD CONSTRAINT "ocr_submission_members_shape_check" CHECK (("ocr_submission_members"."status" = 'pending' AND "ocr_submission_members"."legacy_job_id" IS NULL AND "ocr_submission_members"."failure_code" IS NULL) OR ("ocr_submission_members"."status" = 'registered' AND "ocr_submission_members"."legacy_job_id" IS NOT NULL AND "ocr_submission_members"."failure_code" IS NULL) OR ("ocr_submission_members"."status" = 'failed' AND "ocr_submission_members"."legacy_job_id" IS NULL AND "ocr_submission_members"."failure_code" IS NOT NULL AND "ocr_submission_members"."failure_code" IN ('admission_failed','admission_timeout')));--> statement-breakpoint
ALTER TABLE "ocr_submissions" ADD CONSTRAINT "ocr_submissions_id_check" CHECK (length("ocr_submissions"."legacy_id") = 36 AND "ocr_submissions"."legacy_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');--> statement-breakpoint
ALTER TABLE "series_analysis_jobs" ADD CONSTRAINT "series_analysis_jobs_radar_purpose_check" CHECK (("series_analysis_jobs"."work_kind" = 'radar_prepare') = ("series_analysis_jobs"."legacy_radar_operation_id" IS NOT NULL) AND "series_analysis_jobs"."radar_generation" >= 0);--> statement-breakpoint
ALTER TABLE "series_analysis_jobs" ADD CONSTRAINT "series_analysis_jobs_lease_shape_check" CHECK (("series_analysis_jobs"."status" = 'running' AND "series_analysis_jobs"."lease_owner" IS NOT NULL AND "series_analysis_jobs"."legacy_lease_attempt_id" IS NOT NULL AND "series_analysis_jobs"."lease_fencing_token" IS NOT NULL AND "series_analysis_jobs"."lease_expires_at" IS NOT NULL) OR ("series_analysis_jobs"."status" <> 'running' AND "series_analysis_jobs"."lease_owner" IS NULL AND "series_analysis_jobs"."legacy_lease_attempt_id" IS NULL AND "series_analysis_jobs"."lease_fencing_token" IS NULL AND "series_analysis_jobs"."lease_expires_at" IS NULL));--> statement-breakpoint
ALTER TABLE "series_analysis_operation_requests" ADD CONSTRAINT "series_analysis_operation_requests_scope_title_check" CHECK (("series_analysis_operation_requests"."scope" = 'title' AND "series_analysis_operation_requests"."legacy_game_title_id" IS NOT NULL) OR ("series_analysis_operation_requests"."scope" = 'all_titles' AND "series_analysis_operation_requests"."legacy_game_title_id" IS NULL));--> statement-breakpoint
ALTER TABLE "series_analysis_title_states" ADD CONSTRAINT "series_analysis_title_states_artifact_pointer_distinct_check" CHECK ("series_analysis_title_states"."legacy_current_artifact_id" IS NULL OR "series_analysis_title_states"."legacy_previous_artifact_id" IS NULL OR "series_analysis_title_states"."legacy_current_artifact_id" <> "series_analysis_title_states"."legacy_previous_artifact_id");--> statement-breakpoint
ALTER TABLE "series_analysis_title_states" ADD CONSTRAINT "series_analysis_title_states_notification_baseline_check" CHECK (("series_analysis_title_states"."notification_baseline_state" = 'artifact' AND "series_analysis_title_states"."legacy_notification_baseline_artifact_id" IS NOT NULL) OR ("series_analysis_title_states"."notification_baseline_state" IN ('initial', 'unknown') AND "series_analysis_title_states"."legacy_notification_baseline_artifact_id" IS NULL));--> statement-breakpoint
ALTER TABLE "series_radar_title_states" ADD CONSTRAINT "series_radar_states_current_pair_check" CHECK (("series_radar_title_states"."legacy_current_basis_id" IS NULL) = ("series_radar_title_states"."current_applied_at" IS NULL));--> statement-breakpoint
ALTER TABLE "series_radar_title_states" ADD CONSTRAINT "series_radar_states_previous_pair_check" CHECK (("series_radar_title_states"."legacy_previous_basis_id" IS NULL) = ("series_radar_title_states"."previous_applied_at" IS NULL));--> statement-breakpoint
ALTER TABLE "series_radar_title_states" ADD CONSTRAINT "series_radar_states_distinct_check" CHECK ("series_radar_title_states"."legacy_current_basis_id" IS NULL OR "series_radar_title_states"."legacy_previous_basis_id" IS NULL OR "series_radar_title_states"."legacy_current_basis_id" <> "series_radar_title_states"."legacy_previous_basis_id");--> statement-breakpoint
ALTER TABLE "worker_execution_slots" ADD CONSTRAINT "worker_execution_slots_holder_shape_check" CHECK (("worker_execution_slots"."owner" IS NULL AND "worker_execution_slots"."task_kind" IS NULL AND "worker_execution_slots"."legacy_job_id" IS NULL AND "worker_execution_slots"."legacy_attempt_id" IS NULL AND "worker_execution_slots"."holder_preemptible" IS NULL AND "worker_execution_slots"."lease_expires_at" IS NULL) OR ("worker_execution_slots"."owner" IS NOT NULL AND "worker_execution_slots"."task_kind" IS NOT NULL AND "worker_execution_slots"."legacy_job_id" IS NOT NULL AND "worker_execution_slots"."legacy_attempt_id" IS NOT NULL AND "worker_execution_slots"."holder_preemptible" IS NOT NULL AND "worker_execution_slots"."lease_expires_at" IS NOT NULL));