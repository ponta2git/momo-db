-- Drizzle Kit 0.31.10 cannot infer existing inline PRIMARY KEY names, and
-- omits the drop when the former PK column is removed in the same transition.
-- These exact *_pkey names are defined by the applied CREATE TABLE history and
-- verified on a fresh prefix database. Only the declared PK replacement is
-- completed here; metadata and all other generated DDL remain unchanged.
CREATE TABLE "idempotency_keys" (
	"key" uuid NOT NULL,
	"member_id" uuid,
	"account_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"request_hash" "bytea" NOT NULL,
	"response_status" integer NOT NULL,
	"response_headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"response_body" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_keys_key_account_id_endpoint_pk" PRIMARY KEY("key","account_id","endpoint")
);
--> statement-breakpoint
CREATE TABLE "series_analysis_artifact_identities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"legacy_id" text NOT NULL,
	"game_title_id" uuid NOT NULL,
	"legacy_game_title_id" text NOT NULL,
	CONSTRAINT "series_analysis_artifact_identities_legacy_id_unique" UNIQUE("legacy_id")
);
--> statement-breakpoint
CREATE TABLE "series_radar_basis_identities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"legacy_id" text NOT NULL,
	"game_title_id" uuid NOT NULL,
	"legacy_game_title_id" text NOT NULL,
	CONSTRAINT "series_radar_basis_identities_legacy_id_unique" UNIQUE("legacy_id")
);
--> statement-breakpoint
ALTER TABLE "held_events" DROP CONSTRAINT "held_events_legacy_session_id_unique";--> statement-breakpoint
ALTER TABLE "series_analysis_campaigns" DROP CONSTRAINT "series_analysis_campaigns_legacy_operation_request_id_unique";--> statement-breakpoint
ALTER TABLE "series_radar_candidates" DROP CONSTRAINT "series_radar_candidates_id_title_unique";--> statement-breakpoint
ALTER TABLE "series_radar_operations" DROP CONSTRAINT "series_radar_operations_id_title_unique";--> statement-breakpoint
ALTER TABLE "series_radar_previews" DROP CONSTRAINT "series_radar_previews_id_title_unique";--> statement-breakpoint
ALTER TABLE "matches" DROP CONSTRAINT "matches_note_shape_check";--> statement-breakpoint
ALTER TABLE "ocr_jobs" DROP CONSTRAINT "ocr_jobs_input_snapshot_check";--> statement-breakpoint
ALTER TABLE "ocr_submission_members" DROP CONSTRAINT "ocr_submission_members_shape_check";--> statement-breakpoint
ALTER TABLE "series_analysis_jobs" DROP CONSTRAINT "series_analysis_jobs_radar_purpose_check";--> statement-breakpoint
ALTER TABLE "series_analysis_jobs" DROP CONSTRAINT "series_analysis_jobs_lease_shape_check";--> statement-breakpoint
ALTER TABLE "series_analysis_operation_requests" DROP CONSTRAINT "series_analysis_operation_requests_scope_title_check";--> statement-breakpoint
ALTER TABLE "series_analysis_title_states" DROP CONSTRAINT "series_analysis_title_states_artifact_pointer_distinct_check";--> statement-breakpoint
ALTER TABLE "series_analysis_title_states" DROP CONSTRAINT "series_analysis_title_states_notification_baseline_check";--> statement-breakpoint
ALTER TABLE "series_radar_title_states" DROP CONSTRAINT "series_radar_states_current_pair_check";--> statement-breakpoint
ALTER TABLE "series_radar_title_states" DROP CONSTRAINT "series_radar_states_previous_pair_check";--> statement-breakpoint
ALTER TABLE "series_radar_title_states" DROP CONSTRAINT "series_radar_states_distinct_check";--> statement-breakpoint
ALTER TABLE "worker_execution_slots" DROP CONSTRAINT "worker_execution_slots_holder_shape_check";--> statement-breakpoint
DROP INDEX "app_sessions_member_id_idx";--> statement-breakpoint
DROP INDEX "app_sessions_account_id_idx";--> statement-breakpoint
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
DROP INDEX "member_aliases_member_alias_unique";--> statement-breakpoint
DROP INDEX "momo_login_accounts_player_member_id_idx";--> statement-breakpoint
DROP INDEX "ocr_drafts_job_id_unique";--> statement-breakpoint
DROP INDEX "ocr_jobs_draft_id_unique";--> statement-breakpoint
DROP INDEX "ocr_jobs_source_image_id_idx";--> statement-breakpoint
DROP INDEX "ocr_submission_members_job_unique";--> statement-breakpoint
DROP INDEX "ocr_submission_members_upload_unique";--> statement-breakpoint
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
DROP INDEX "series_analysis_jobs_active_title_unique";--> statement-breakpoint
DROP INDEX "series_analysis_operation_requests_idempotency_unique";--> statement-breakpoint
DROP INDEX "series_radar_candidates_active_unique";--> statement-breakpoint
DROP INDEX "series_radar_candidates_title_created_idx";--> statement-breakpoint
DROP INDEX "series_radar_operations_idempotency_unique";--> statement-breakpoint
DROP INDEX "series_radar_operations_pending_idx";--> statement-breakpoint
DROP INDEX "series_radar_operations_title_created_idx";--> statement-breakpoint
DROP INDEX "series_radar_previews_candidate_created_idx";--> statement-breakpoint
DROP INDEX "source_images_owner_idempotency_unique";--> statement-breakpoint
ALTER TABLE "held_event_participants" DROP CONSTRAINT "held_event_participants_legacy_held_event_id_legacy_member_id_pk";--> statement-breakpoint
ALTER TABLE "match_incidents" DROP CONSTRAINT "match_incidents_legacy_match_id_legacy_member_id_legacy_incident_master_id_pk";--> statement-breakpoint
ALTER TABLE "match_players" DROP CONSTRAINT "match_players_legacy_match_id_legacy_member_id_pk";--> statement-breakpoint
ALTER TABLE "ocr_submission_members" DROP CONSTRAINT "ocr_submission_members_legacy_submission_id_screen_type_pk";--> statement-breakpoint
ALTER TABLE "series_analysis_campaign_targets" DROP CONSTRAINT "series_analysis_campaign_targets_legacy_campaign_id_legacy_game_title_id_pk";--> statement-breakpoint
ALTER TABLE "series_radar_acknowledgements" DROP CONSTRAINT "series_radar_acknowledgements_legacy_game_title_id_evidence_key_pk";--> statement-breakpoint
ALTER TABLE "series_radar_preview_scopes" DROP CONSTRAINT "series_radar_preview_scopes_legacy_preview_id_scope_key_pk";--> statement-breakpoint
ALTER TABLE "app_sessions" ALTER COLUMN "account_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "game_titles" DROP CONSTRAINT "game_titles_pkey";--> statement-breakpoint
ALTER TABLE "game_titles" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "game_titles" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "held_event_participants" ALTER COLUMN "held_event_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "held_event_participants" ALTER COLUMN "member_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "held_events" DROP CONSTRAINT "held_events_pkey";--> statement-breakpoint
ALTER TABLE "held_events" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "held_events" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "incident_masters" DROP CONSTRAINT "incident_masters_pkey";--> statement-breakpoint
ALTER TABLE "incident_masters" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "incident_masters" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "map_masters" DROP CONSTRAINT "map_masters_pkey";--> statement-breakpoint
ALTER TABLE "map_masters" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "map_masters" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "map_masters" ALTER COLUMN "game_title_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "match_drafts" DROP CONSTRAINT "match_drafts_pkey";--> statement-breakpoint
ALTER TABLE "match_drafts" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "match_drafts" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "match_drafts" ALTER COLUMN "created_by_account_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "match_incidents" ALTER COLUMN "match_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "match_incidents" ALTER COLUMN "member_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "match_incidents" ALTER COLUMN "incident_master_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "match_players" ALTER COLUMN "match_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "match_players" ALTER COLUMN "member_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "matches" DROP CONSTRAINT "matches_pkey";--> statement-breakpoint
ALTER TABLE "matches" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "matches" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "matches" ALTER COLUMN "held_event_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "matches" ALTER COLUMN "game_title_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "matches" ALTER COLUMN "season_master_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "matches" ALTER COLUMN "owner_member_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "matches" ALTER COLUMN "map_master_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "matches" ALTER COLUMN "created_by_account_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "member_aliases" DROP CONSTRAINT "member_aliases_pkey";--> statement-breakpoint
ALTER TABLE "member_aliases" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "member_aliases" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "member_aliases" ALTER COLUMN "member_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "members" DROP CONSTRAINT "members_pkey";--> statement-breakpoint
ALTER TABLE "members" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "members" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "momo_login_accounts" DROP CONSTRAINT "momo_login_accounts_pkey";--> statement-breakpoint
ALTER TABLE "momo_login_accounts" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "momo_login_accounts" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ocr_drafts" DROP CONSTRAINT "ocr_drafts_pkey";--> statement-breakpoint
ALTER TABLE "ocr_drafts" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "ocr_drafts" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ocr_drafts" ALTER COLUMN "job_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ocr_jobs" DROP CONSTRAINT "ocr_jobs_pkey";--> statement-breakpoint
ALTER TABLE "ocr_jobs" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "ocr_jobs" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ocr_jobs" ALTER COLUMN "draft_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ocr_submission_members" ALTER COLUMN "submission_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ocr_submissions" DROP CONSTRAINT "ocr_submissions_pkey";--> statement-breakpoint
ALTER TABLE "ocr_submissions" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "ocr_submissions" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ocr_submissions" ALTER COLUMN "owner_account_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ocr_submissions" ALTER COLUMN "match_draft_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "responses" DROP CONSTRAINT "responses_pkey";--> statement-breakpoint
ALTER TABLE "responses" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "responses" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "responses" ALTER COLUMN "session_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "responses" ALTER COLUMN "member_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "season_masters" DROP CONSTRAINT "season_masters_pkey";--> statement-breakpoint
ALTER TABLE "season_masters" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "season_masters" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "season_masters" ALTER COLUMN "game_title_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "series_analysis_campaign_targets" ALTER COLUMN "campaign_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "series_analysis_campaign_targets" ALTER COLUMN "game_title_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "series_analysis_campaigns" DROP CONSTRAINT "series_analysis_campaigns_pkey";--> statement-breakpoint
ALTER TABLE "series_analysis_campaigns" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "series_analysis_campaigns" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "series_analysis_campaigns" ALTER COLUMN "operation_request_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "series_analysis_job_attempts" DROP CONSTRAINT "series_analysis_job_attempts_pkey";--> statement-breakpoint
ALTER TABLE "series_analysis_job_attempts" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "series_analysis_job_attempts" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "series_analysis_job_attempts" ALTER COLUMN "job_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "series_analysis_job_requests" DROP CONSTRAINT "series_analysis_job_requests_pkey";--> statement-breakpoint
ALTER TABLE "series_analysis_job_requests" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "series_analysis_job_requests" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "series_analysis_job_requests" ALTER COLUMN "game_title_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "series_analysis_jobs" DROP CONSTRAINT "series_analysis_jobs_pkey";--> statement-breakpoint
ALTER TABLE "series_analysis_jobs" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "series_analysis_jobs" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "series_analysis_jobs" ALTER COLUMN "game_title_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "series_analysis_operation_requests" DROP CONSTRAINT "series_analysis_operation_requests_pkey";--> statement-breakpoint
ALTER TABLE "series_analysis_operation_requests" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "series_analysis_operation_requests" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "series_analysis_title_states" DROP CONSTRAINT "series_analysis_title_states_pkey";--> statement-breakpoint
ALTER TABLE "series_analysis_title_states" ADD PRIMARY KEY ("game_title_id");--> statement-breakpoint
ALTER TABLE "series_analysis_title_states" ALTER COLUMN "game_title_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "series_radar_acknowledgements" ALTER COLUMN "game_title_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "series_radar_acknowledgements" ALTER COLUMN "requested_by" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "series_radar_candidates" DROP CONSTRAINT "series_radar_candidates_pkey";--> statement-breakpoint
ALTER TABLE "series_radar_candidates" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "series_radar_candidates" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "series_radar_candidates" ALTER COLUMN "game_title_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "series_radar_operations" DROP CONSTRAINT "series_radar_operations_pkey";--> statement-breakpoint
ALTER TABLE "series_radar_operations" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "series_radar_operations" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "series_radar_operations" ALTER COLUMN "game_title_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "series_radar_operations" ALTER COLUMN "requested_by" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "series_radar_preview_scopes" ALTER COLUMN "preview_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "series_radar_previews" DROP CONSTRAINT "series_radar_previews_pkey";--> statement-breakpoint
ALTER TABLE "series_radar_previews" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "series_radar_previews" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "series_radar_previews" ALTER COLUMN "game_title_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "series_radar_previews" ALTER COLUMN "candidate_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "series_radar_title_states" DROP CONSTRAINT "series_radar_title_states_pkey";--> statement-breakpoint
ALTER TABLE "series_radar_title_states" ADD PRIMARY KEY ("game_title_id");--> statement-breakpoint
ALTER TABLE "series_radar_title_states" ALTER COLUMN "game_title_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_pkey";--> statement-breakpoint
ALTER TABLE "sessions" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "source_images" DROP CONSTRAINT "source_images_pkey";--> statement-breakpoint
ALTER TABLE "source_images" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "source_images" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "source_images" ALTER COLUMN "owner_account_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "held_event_participants" ADD CONSTRAINT "held_event_participants_held_event_id_member_id_pk" PRIMARY KEY("held_event_id","member_id");--> statement-breakpoint
ALTER TABLE "match_incidents" ADD CONSTRAINT "match_incidents_match_id_member_id_incident_master_id_pk" PRIMARY KEY("match_id","member_id","incident_master_id");--> statement-breakpoint
ALTER TABLE "match_players" ADD CONSTRAINT "match_players_match_id_member_id_pk" PRIMARY KEY("match_id","member_id");--> statement-breakpoint
ALTER TABLE "ocr_submission_members" ADD CONSTRAINT "ocr_submission_members_submission_id_screen_type_pk" PRIMARY KEY("submission_id","screen_type");--> statement-breakpoint
ALTER TABLE "series_analysis_campaign_targets" ADD CONSTRAINT "series_analysis_campaign_targets_campaign_id_game_title_id_pk" PRIMARY KEY("campaign_id","game_title_id");--> statement-breakpoint
ALTER TABLE "series_radar_acknowledgements" ADD CONSTRAINT "series_radar_acknowledgements_game_title_id_evidence_key_pk" PRIMARY KEY("game_title_id","evidence_key");--> statement-breakpoint
ALTER TABLE "series_radar_preview_scopes" ADD CONSTRAINT "series_radar_preview_scopes_preview_id_scope_key_pk" PRIMARY KEY("preview_id","scope_key");--> statement-breakpoint
ALTER TABLE "series_analysis_artifact_identities" ADD CONSTRAINT "series_analysis_artifact_identities_source_fk" FOREIGN KEY ("legacy_id","legacy_game_title_id") REFERENCES "public"."series_analysis_artifacts"("id","game_title_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_radar_basis_identities" ADD CONSTRAINT "series_radar_basis_identities_source_fk" FOREIGN KEY ("legacy_id","legacy_game_title_id") REFERENCES "public"."series_radar_bases"("id","game_title_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idempotency_keys_account_expires_at_idx" ON "idempotency_keys" USING btree ("account_id","expires_at");--> statement-breakpoint
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "series_analysis_artifact_identities_id_title_unique" ON "series_analysis_artifact_identities" USING btree ("id","game_title_id");--> statement-breakpoint
CREATE UNIQUE INDEX "series_analysis_artifact_identities_legacy_title_unique" ON "series_analysis_artifact_identities" USING btree ("legacy_id","game_title_id");--> statement-breakpoint
CREATE UNIQUE INDEX "series_radar_basis_identities_id_title_unique" ON "series_radar_basis_identities" USING btree ("id","game_title_id");--> statement-breakpoint
CREATE UNIQUE INDEX "series_radar_basis_identities_legacy_title_unique" ON "series_radar_basis_identities" USING btree ("legacy_id","game_title_id");--> statement-breakpoint
CREATE INDEX "app_sessions_member_id_idx" ON "app_sessions" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "app_sessions_account_id_idx" ON "app_sessions" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "map_masters_title_name_unique" ON "map_masters" USING btree ("game_title_id","name");--> statement-breakpoint
CREATE INDEX "match_drafts_created_by_status_idx" ON "match_drafts" USING btree ("created_by_member_id","status");--> statement-breakpoint
CREATE INDEX "match_drafts_created_by_account_status_idx" ON "match_drafts" USING btree ("created_by_account_id","status");--> statement-breakpoint
CREATE INDEX "match_drafts_held_event_id_idx" ON "match_drafts" USING btree ("held_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "match_drafts_confirmed_match_id_unique" ON "match_drafts" USING btree ("confirmed_match_id");--> statement-breakpoint
CREATE INDEX "match_incidents_match_id_idx" ON "match_incidents" USING btree ("match_id");--> statement-breakpoint
CREATE UNIQUE INDEX "match_players_match_play_order_unique" ON "match_players" USING btree ("match_id","play_order");--> statement-breakpoint
CREATE UNIQUE INDEX "match_players_match_rank_unique" ON "match_players" USING btree ("match_id","rank");--> statement-breakpoint
CREATE UNIQUE INDEX "matches_event_match_no_unique" ON "matches" USING btree ("held_event_id","match_no_in_event");--> statement-breakpoint
CREATE INDEX "matches_title_held_event_idx" ON "matches" USING btree ("game_title_id","held_event_id");--> statement-breakpoint
CREATE INDEX "matches_title_scope_idx" ON "matches" USING btree ("game_title_id","season_master_id","map_master_id");--> statement-breakpoint
CREATE INDEX "matches_held_event_id_idx" ON "matches" USING btree ("held_event_id");--> statement-breakpoint
CREATE INDEX "matches_created_by_account_id_idx" ON "matches" USING btree ("created_by_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "member_aliases_member_alias_unique" ON "member_aliases" USING btree ("member_id","alias");--> statement-breakpoint
CREATE INDEX "momo_login_accounts_player_member_id_idx" ON "momo_login_accounts" USING btree ("player_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ocr_drafts_job_id_unique" ON "ocr_drafts" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ocr_jobs_draft_id_unique" ON "ocr_jobs" USING btree ("draft_id");--> statement-breakpoint
CREATE INDEX "ocr_jobs_source_image_id_idx" ON "ocr_jobs" USING btree ("source_image_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ocr_submission_members_job_unique" ON "ocr_submission_members" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ocr_submission_members_upload_unique" ON "ocr_submission_members" USING btree ("submission_id","upload_idempotency_key_hash");--> statement-breakpoint
CREATE INDEX "ocr_submissions_owner_status_idx" ON "ocr_submissions" USING btree ("owner_account_id","status");--> statement-breakpoint
CREATE INDEX "ocr_submissions_draft_status_idx" ON "ocr_submissions" USING btree ("match_draft_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "responses_session_member_unique" ON "responses" USING btree ("session_id","member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "season_masters_title_name_unique" ON "season_masters" USING btree ("game_title_id","name");--> statement-breakpoint
CREATE INDEX "series_analysis_campaign_targets_pending_idx" ON "series_analysis_campaign_targets" USING btree ("accepted_at","campaign_id","game_title_id") WHERE "series_analysis_campaign_targets"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "series_analysis_campaign_targets_job_request_unique" ON "series_analysis_campaign_targets" USING btree ("job_request_id") WHERE "series_analysis_campaign_targets"."job_request_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "series_analysis_job_attempts_job_no_unique" ON "series_analysis_job_attempts" USING btree ("job_id","attempt_no");--> statement-breakpoint
CREATE INDEX "series_analysis_job_requests_pending_title_idx" ON "series_analysis_job_requests" USING btree ("game_title_id","accepted_at","legacy_id") WHERE "series_analysis_job_requests"."status" IN ('pending','assigned');--> statement-breakpoint
CREATE INDEX "series_analysis_job_requests_operation_idx" ON "series_analysis_job_requests" USING btree ("operation_request_id") WHERE "series_analysis_job_requests"."operation_request_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "series_analysis_job_requests_campaign_idx" ON "series_analysis_job_requests" USING btree ("campaign_id") WHERE "series_analysis_job_requests"."campaign_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "series_analysis_job_requests_job_idx" ON "series_analysis_job_requests" USING btree ("assigned_job_id","accepted_at","legacy_id") WHERE "series_analysis_job_requests"."assigned_job_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "series_analysis_job_requests_attempt_idx" ON "series_analysis_job_requests" USING btree ("assigned_attempt_id") WHERE "series_analysis_job_requests"."assigned_attempt_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "series_analysis_jobs_title_terminal_idx" ON "series_analysis_jobs" USING btree ("game_title_id","finished_at" DESC NULLS LAST,"legacy_id" DESC NULLS FIRST) WHERE "series_analysis_jobs"."work_kind" = 'analysis' AND "series_analysis_jobs"."status" IN ('succeeded','failed','timed_out');--> statement-breakpoint
CREATE UNIQUE INDEX "series_analysis_jobs_active_title_unique" ON "series_analysis_jobs" USING btree ("game_title_id") WHERE "series_analysis_jobs"."status" IN ('queued','running');--> statement-breakpoint
CREATE UNIQUE INDEX "series_analysis_operation_requests_idempotency_unique" ON "series_analysis_operation_requests" USING btree ("requested_by_account_id","endpoint","idempotency_key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "series_radar_candidates_active_unique" ON "series_radar_candidates" USING btree ("game_title_id") WHERE "series_radar_candidates"."status" IN ('pending','ready','unavailable','failed');--> statement-breakpoint
CREATE INDEX "series_radar_candidates_title_created_idx" ON "series_radar_candidates" USING btree ("game_title_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "series_radar_operations_idempotency_unique" ON "series_radar_operations" USING btree ("game_title_id","requested_by","idempotency_key_hash");--> statement-breakpoint
CREATE INDEX "series_radar_operations_pending_idx" ON "series_radar_operations" USING btree ("requested_at","legacy_id") WHERE "series_radar_operations"."status" = 'pending' AND "series_radar_operations"."job_id" IS NULL;--> statement-breakpoint
CREATE INDEX "series_radar_operations_title_created_idx" ON "series_radar_operations" USING btree ("game_title_id","requested_at");--> statement-breakpoint
CREATE INDEX "series_radar_previews_candidate_created_idx" ON "series_radar_previews" USING btree ("candidate_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "source_images_owner_idempotency_unique" ON "source_images" USING btree ("owner_account_id","idempotency_key_hash");--> statement-breakpoint
ALTER TABLE "app_sessions" DROP COLUMN "legacy_account_id";--> statement-breakpoint
ALTER TABLE "held_event_participants" DROP COLUMN "legacy_held_event_id";--> statement-breakpoint
ALTER TABLE "held_event_participants" DROP COLUMN "legacy_member_id";--> statement-breakpoint
ALTER TABLE "held_events" DROP COLUMN "legacy_session_id";--> statement-breakpoint
ALTER TABLE "map_masters" DROP COLUMN "legacy_game_title_id";--> statement-breakpoint
ALTER TABLE "match_drafts" DROP COLUMN "legacy_created_by_member_id";--> statement-breakpoint
ALTER TABLE "match_drafts" DROP COLUMN "legacy_created_by_account_id";--> statement-breakpoint
ALTER TABLE "match_drafts" DROP COLUMN "legacy_held_event_id";--> statement-breakpoint
ALTER TABLE "match_drafts" DROP COLUMN "legacy_game_title_id";--> statement-breakpoint
ALTER TABLE "match_drafts" DROP COLUMN "legacy_season_master_id";--> statement-breakpoint
ALTER TABLE "match_drafts" DROP COLUMN "legacy_owner_member_id";--> statement-breakpoint
ALTER TABLE "match_drafts" DROP COLUMN "legacy_map_master_id";--> statement-breakpoint
ALTER TABLE "match_drafts" DROP COLUMN "legacy_confirmed_match_id";--> statement-breakpoint
ALTER TABLE "match_incidents" DROP COLUMN "legacy_match_id";--> statement-breakpoint
ALTER TABLE "match_incidents" DROP COLUMN "legacy_member_id";--> statement-breakpoint
ALTER TABLE "match_incidents" DROP COLUMN "legacy_incident_master_id";--> statement-breakpoint
ALTER TABLE "match_players" DROP COLUMN "legacy_match_id";--> statement-breakpoint
ALTER TABLE "match_players" DROP COLUMN "legacy_member_id";--> statement-breakpoint
ALTER TABLE "matches" DROP COLUMN "legacy_game_title_id";--> statement-breakpoint
ALTER TABLE "matches" DROP COLUMN "legacy_season_master_id";--> statement-breakpoint
ALTER TABLE "matches" DROP COLUMN "legacy_owner_member_id";--> statement-breakpoint
ALTER TABLE "matches" DROP COLUMN "legacy_map_master_id";--> statement-breakpoint
ALTER TABLE "matches" DROP COLUMN "legacy_created_by_member_id";--> statement-breakpoint
ALTER TABLE "matches" DROP COLUMN "legacy_created_by_account_id";--> statement-breakpoint
ALTER TABLE "matches" DROP COLUMN "legacy_note_updated_by_account_id";--> statement-breakpoint
ALTER TABLE "member_aliases" DROP COLUMN "legacy_member_id";--> statement-breakpoint
ALTER TABLE "momo_login_accounts" DROP COLUMN "legacy_player_member_id";--> statement-breakpoint
ALTER TABLE "ocr_jobs" DROP COLUMN "legacy_source_image_id";--> statement-breakpoint
ALTER TABLE "ocr_submission_members" DROP COLUMN "legacy_submission_id";--> statement-breakpoint
ALTER TABLE "ocr_submission_members" DROP COLUMN "legacy_job_id";--> statement-breakpoint
ALTER TABLE "ocr_submissions" DROP COLUMN "legacy_owner_account_id";--> statement-breakpoint
ALTER TABLE "responses" DROP COLUMN "legacy_session_id";--> statement-breakpoint
ALTER TABLE "responses" DROP COLUMN "legacy_member_id";--> statement-breakpoint
ALTER TABLE "season_masters" DROP COLUMN "legacy_game_title_id";--> statement-breakpoint
ALTER TABLE "series_analysis_campaign_targets" DROP COLUMN "legacy_campaign_id";--> statement-breakpoint
ALTER TABLE "series_analysis_campaigns" DROP COLUMN "legacy_operation_request_id";--> statement-breakpoint
ALTER TABLE "series_analysis_job_attempts" DROP COLUMN "legacy_job_id";--> statement-breakpoint
ALTER TABLE "series_analysis_job_requests" DROP COLUMN "legacy_operation_request_id";--> statement-breakpoint
ALTER TABLE "series_analysis_job_requests" DROP COLUMN "legacy_campaign_id";--> statement-breakpoint
ALTER TABLE "series_analysis_job_requests" DROP COLUMN "legacy_assigned_job_id";--> statement-breakpoint
ALTER TABLE "series_analysis_jobs" DROP COLUMN "legacy_radar_basis_id";--> statement-breakpoint
ALTER TABLE "series_analysis_jobs" DROP COLUMN "legacy_game_title_id";--> statement-breakpoint
ALTER TABLE "series_analysis_operation_requests" DROP COLUMN "legacy_requested_by_account_id";--> statement-breakpoint
ALTER TABLE "series_analysis_title_states" DROP COLUMN "legacy_game_title_id";--> statement-breakpoint
ALTER TABLE "series_analysis_title_states" DROP COLUMN "legacy_current_artifact_id";--> statement-breakpoint
ALTER TABLE "series_analysis_title_states" DROP COLUMN "legacy_previous_artifact_id";--> statement-breakpoint
ALTER TABLE "series_analysis_title_states" DROP COLUMN "legacy_notification_baseline_artifact_id";--> statement-breakpoint
ALTER TABLE "series_radar_acknowledgements" DROP COLUMN "legacy_game_title_id";--> statement-breakpoint
ALTER TABLE "series_radar_candidates" DROP COLUMN "legacy_basis_id";--> statement-breakpoint
ALTER TABLE "series_radar_operations" DROP COLUMN "legacy_candidate_id";--> statement-breakpoint
ALTER TABLE "series_radar_operations" DROP COLUMN "legacy_preview_id";--> statement-breakpoint
ALTER TABLE "series_radar_operations" DROP COLUMN "legacy_basis_id";--> statement-breakpoint
ALTER TABLE "series_radar_preview_scopes" DROP COLUMN "legacy_preview_id";--> statement-breakpoint
ALTER TABLE "series_radar_previews" DROP COLUMN "legacy_game_title_id";--> statement-breakpoint
ALTER TABLE "series_radar_previews" DROP COLUMN "legacy_candidate_id";--> statement-breakpoint
ALTER TABLE "series_radar_previews" DROP COLUMN "legacy_before_basis_id";--> statement-breakpoint
ALTER TABLE "series_radar_title_states" DROP COLUMN "legacy_game_title_id";--> statement-breakpoint
ALTER TABLE "series_radar_title_states" DROP COLUMN "legacy_desired_basis_id";--> statement-breakpoint
ALTER TABLE "series_radar_title_states" DROP COLUMN "legacy_current_basis_id";--> statement-breakpoint
ALTER TABLE "series_radar_title_states" DROP COLUMN "legacy_previous_basis_id";--> statement-breakpoint
ALTER TABLE "series_radar_title_states" DROP COLUMN "legacy_active_operation_id";--> statement-breakpoint
ALTER TABLE "source_images" DROP COLUMN "legacy_owner_account_id";--> statement-breakpoint
ALTER TABLE "game_titles" ADD CONSTRAINT "game_titles_legacy_id_unique" UNIQUE("legacy_id");--> statement-breakpoint
ALTER TABLE "game_titles" ADD CONSTRAINT "game_titles_id_legacy_unique" UNIQUE("id","legacy_id");--> statement-breakpoint
ALTER TABLE "held_events" ADD CONSTRAINT "held_events_legacy_id_unique" UNIQUE("legacy_id");--> statement-breakpoint
ALTER TABLE "held_events" ADD CONSTRAINT "held_events_session_id_unique" UNIQUE("session_id");--> statement-breakpoint
ALTER TABLE "held_events" ADD CONSTRAINT "held_events_id_legacy_unique" UNIQUE("id","legacy_id");--> statement-breakpoint
ALTER TABLE "incident_masters" ADD CONSTRAINT "incident_masters_legacy_id_unique" UNIQUE("legacy_id");--> statement-breakpoint
ALTER TABLE "map_masters" ADD CONSTRAINT "map_masters_legacy_id_unique" UNIQUE("legacy_id");--> statement-breakpoint
ALTER TABLE "match_drafts" ADD CONSTRAINT "match_drafts_legacy_id_unique" UNIQUE("legacy_id");--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_legacy_id_unique" UNIQUE("legacy_id");--> statement-breakpoint
ALTER TABLE "member_aliases" ADD CONSTRAINT "member_aliases_legacy_id_unique" UNIQUE("legacy_id");--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_legacy_id_unique" UNIQUE("legacy_id");--> statement-breakpoint
ALTER TABLE "momo_login_accounts" ADD CONSTRAINT "momo_login_accounts_legacy_id_unique" UNIQUE("legacy_id");--> statement-breakpoint
ALTER TABLE "ocr_drafts" ADD CONSTRAINT "ocr_drafts_legacy_id_unique" UNIQUE("legacy_id");--> statement-breakpoint
ALTER TABLE "ocr_jobs" ADD CONSTRAINT "ocr_jobs_legacy_id_unique" UNIQUE("legacy_id");--> statement-breakpoint
ALTER TABLE "ocr_submissions" ADD CONSTRAINT "ocr_submissions_legacy_id_unique" UNIQUE("legacy_id");--> statement-breakpoint
ALTER TABLE "responses" ADD CONSTRAINT "responses_legacy_id_unique" UNIQUE("legacy_id");--> statement-breakpoint
ALTER TABLE "season_masters" ADD CONSTRAINT "season_masters_legacy_id_unique" UNIQUE("legacy_id");--> statement-breakpoint
ALTER TABLE "series_analysis_campaigns" ADD CONSTRAINT "series_analysis_campaigns_legacy_id_unique" UNIQUE("legacy_id");--> statement-breakpoint
ALTER TABLE "series_analysis_campaigns" ADD CONSTRAINT "series_analysis_campaigns_operation_request_id_unique" UNIQUE("operation_request_id");--> statement-breakpoint
ALTER TABLE "series_analysis_job_attempts" ADD CONSTRAINT "series_analysis_job_attempts_legacy_id_unique" UNIQUE("legacy_id");--> statement-breakpoint
ALTER TABLE "series_analysis_job_requests" ADD CONSTRAINT "series_analysis_job_requests_legacy_id_unique" UNIQUE("legacy_id");--> statement-breakpoint
ALTER TABLE "series_analysis_jobs" ADD CONSTRAINT "series_analysis_jobs_legacy_id_unique" UNIQUE("legacy_id");--> statement-breakpoint
ALTER TABLE "series_analysis_operation_requests" ADD CONSTRAINT "series_analysis_operation_requests_legacy_id_unique" UNIQUE("legacy_id");--> statement-breakpoint
ALTER TABLE "series_radar_candidates" ADD CONSTRAINT "series_radar_candidates_legacy_id_unique" UNIQUE("legacy_id");--> statement-breakpoint
ALTER TABLE "series_radar_candidates" ADD CONSTRAINT "series_radar_candidates_legacy_title_unique" UNIQUE("legacy_id","legacy_game_title_id");--> statement-breakpoint
ALTER TABLE "series_radar_candidates" ADD CONSTRAINT "series_radar_candidates_id_title_unique" UNIQUE("id","game_title_id");--> statement-breakpoint
ALTER TABLE "series_radar_operations" ADD CONSTRAINT "series_radar_operations_legacy_id_unique" UNIQUE("legacy_id");--> statement-breakpoint
ALTER TABLE "series_radar_operations" ADD CONSTRAINT "series_radar_operations_legacy_title_unique" UNIQUE("legacy_id","legacy_game_title_id");--> statement-breakpoint
ALTER TABLE "series_radar_operations" ADD CONSTRAINT "series_radar_operations_id_title_unique" UNIQUE("id","game_title_id");--> statement-breakpoint
ALTER TABLE "series_radar_previews" ADD CONSTRAINT "series_radar_previews_legacy_id_unique" UNIQUE("legacy_id");--> statement-breakpoint
ALTER TABLE "series_radar_previews" ADD CONSTRAINT "series_radar_previews_id_title_unique" UNIQUE("id","game_title_id");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_legacy_id_unique" UNIQUE("legacy_id");--> statement-breakpoint
ALTER TABLE "source_images" ADD CONSTRAINT "source_images_legacy_id_unique" UNIQUE("legacy_id");--> statement-breakpoint
ALTER TABLE "app_sessions" ADD CONSTRAINT "app_sessions_member_legacy_null_check" CHECK (("app_sessions"."member_id" IS NULL) = ("app_sessions"."legacy_member_id" IS NULL));--> statement-breakpoint
ALTER TABLE "match_drafts" ADD CONSTRAINT "match_drafts_total_assets_draft_legacy_null_check" CHECK (("match_drafts"."total_assets_draft_id" IS NULL) = ("match_drafts"."legacy_total_assets_draft_id" IS NULL));--> statement-breakpoint
ALTER TABLE "match_drafts" ADD CONSTRAINT "match_drafts_revenue_draft_legacy_null_check" CHECK (("match_drafts"."revenue_draft_id" IS NULL) = ("match_drafts"."legacy_revenue_draft_id" IS NULL));--> statement-breakpoint
ALTER TABLE "match_drafts" ADD CONSTRAINT "match_drafts_incident_log_draft_legacy_null_check" CHECK (("match_drafts"."incident_log_draft_id" IS NULL) = ("match_drafts"."legacy_incident_log_draft_id" IS NULL));--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_note_shape_check" CHECK ((
        ("matches"."note_version" = 0 AND "matches"."note_body" IS NULL AND "matches"."note_updated_by_account_id" IS NULL AND "matches"."note_updated_at" IS NULL)
        OR
        ("matches"."note_version" > 0 AND "matches"."note_updated_by_account_id" IS NOT NULL AND "matches"."note_updated_at" IS NOT NULL)
      ));--> statement-breakpoint
ALTER TABLE "ocr_jobs" ADD CONSTRAINT "ocr_jobs_input_snapshot_check" CHECK (("ocr_jobs"."input_snapshot" IS NULL AND "ocr_jobs"."status" IN ('succeeded','failed','cancelled')) OR ("ocr_jobs"."input_snapshot" IS NOT NULL AND jsonb_typeof("ocr_jobs"."input_snapshot") = 'object' AND COALESCE("ocr_jobs"."input_snapshot"->'schemaVersion' = '"2"'::jsonb, false) AND "ocr_jobs"."source_image_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "ocr_submission_members" ADD CONSTRAINT "ocr_submission_members_shape_check" CHECK (("ocr_submission_members"."status" = 'pending' AND "ocr_submission_members"."job_id" IS NULL AND "ocr_submission_members"."failure_code" IS NULL) OR ("ocr_submission_members"."status" = 'registered' AND "ocr_submission_members"."job_id" IS NOT NULL AND "ocr_submission_members"."failure_code" IS NULL) OR ("ocr_submission_members"."status" = 'failed' AND "ocr_submission_members"."job_id" IS NULL AND "ocr_submission_members"."failure_code" IS NOT NULL AND "ocr_submission_members"."failure_code" IN ('admission_failed','admission_timeout')));--> statement-breakpoint
ALTER TABLE "series_analysis_campaign_targets" ADD CONSTRAINT "series_analysis_campaign_targets_job_request_legacy_null_check" CHECK (("series_analysis_campaign_targets"."job_request_id" IS NULL) = ("series_analysis_campaign_targets"."legacy_job_request_id" IS NULL));--> statement-breakpoint
ALTER TABLE "series_analysis_job_requests" ADD CONSTRAINT "series_analysis_job_requests_assigned_attempt_legacy_null_check" CHECK (("series_analysis_job_requests"."assigned_attempt_id" IS NULL) = ("series_analysis_job_requests"."legacy_assigned_attempt_id" IS NULL));--> statement-breakpoint
ALTER TABLE "series_analysis_jobs" ADD CONSTRAINT "series_analysis_jobs_radar_operation_legacy_null_check" CHECK (("series_analysis_jobs"."radar_operation_id" IS NULL) = ("series_analysis_jobs"."legacy_radar_operation_id" IS NULL));--> statement-breakpoint
ALTER TABLE "series_analysis_jobs" ADD CONSTRAINT "series_analysis_jobs_lease_attempt_legacy_null_check" CHECK (("series_analysis_jobs"."lease_attempt_id" IS NULL) = ("series_analysis_jobs"."legacy_lease_attempt_id" IS NULL));--> statement-breakpoint
ALTER TABLE "series_analysis_jobs" ADD CONSTRAINT "series_analysis_jobs_radar_purpose_check" CHECK (("series_analysis_jobs"."work_kind" = 'radar_prepare') = ("series_analysis_jobs"."radar_operation_id" IS NOT NULL) AND "series_analysis_jobs"."radar_generation" >= 0);--> statement-breakpoint
ALTER TABLE "series_analysis_jobs" ADD CONSTRAINT "series_analysis_jobs_lease_shape_check" CHECK (("series_analysis_jobs"."status" = 'running' AND "series_analysis_jobs"."lease_owner" IS NOT NULL AND "series_analysis_jobs"."lease_attempt_id" IS NOT NULL AND "series_analysis_jobs"."lease_fencing_token" IS NOT NULL AND "series_analysis_jobs"."lease_expires_at" IS NOT NULL) OR ("series_analysis_jobs"."status" <> 'running' AND "series_analysis_jobs"."lease_owner" IS NULL AND "series_analysis_jobs"."lease_attempt_id" IS NULL AND "series_analysis_jobs"."lease_fencing_token" IS NULL AND "series_analysis_jobs"."lease_expires_at" IS NULL));--> statement-breakpoint
ALTER TABLE "series_analysis_operation_requests" ADD CONSTRAINT "series_analysis_operation_requests_game_title_legacy_null_check" CHECK (("series_analysis_operation_requests"."game_title_id" IS NULL) = ("series_analysis_operation_requests"."legacy_game_title_id" IS NULL));--> statement-breakpoint
ALTER TABLE "series_analysis_operation_requests" ADD CONSTRAINT "series_analysis_operation_requests_scope_title_check" CHECK (("series_analysis_operation_requests"."scope" = 'title' AND "series_analysis_operation_requests"."game_title_id" IS NOT NULL) OR ("series_analysis_operation_requests"."scope" = 'all_titles' AND "series_analysis_operation_requests"."game_title_id" IS NULL));--> statement-breakpoint
ALTER TABLE "series_analysis_title_states" ADD CONSTRAINT "series_analysis_title_states_artifact_pointer_distinct_check" CHECK ("series_analysis_title_states"."current_artifact_id" IS NULL OR "series_analysis_title_states"."previous_artifact_id" IS NULL OR "series_analysis_title_states"."current_artifact_id" <> "series_analysis_title_states"."previous_artifact_id");--> statement-breakpoint
ALTER TABLE "series_analysis_title_states" ADD CONSTRAINT "series_analysis_title_states_notification_baseline_check" CHECK (("series_analysis_title_states"."notification_baseline_state" = 'artifact' AND "series_analysis_title_states"."notification_baseline_artifact_id" IS NOT NULL) OR ("series_analysis_title_states"."notification_baseline_state" IN ('initial', 'unknown') AND "series_analysis_title_states"."notification_baseline_artifact_id" IS NULL));--> statement-breakpoint
ALTER TABLE "series_radar_operations" ADD CONSTRAINT "series_radar_operations_origin_operation_legacy_null_check" CHECK (("series_radar_operations"."origin_operation_id" IS NULL) = ("series_radar_operations"."legacy_origin_operation_id" IS NULL));--> statement-breakpoint
ALTER TABLE "series_radar_operations" ADD CONSTRAINT "series_radar_operations_job_legacy_null_check" CHECK (("series_radar_operations"."job_id" IS NULL) = ("series_radar_operations"."legacy_job_id" IS NULL));--> statement-breakpoint
ALTER TABLE "series_radar_title_states" ADD CONSTRAINT "series_radar_states_current_pair_check" CHECK (("series_radar_title_states"."current_basis_id" IS NULL) = ("series_radar_title_states"."current_applied_at" IS NULL));--> statement-breakpoint
ALTER TABLE "series_radar_title_states" ADD CONSTRAINT "series_radar_states_previous_pair_check" CHECK (("series_radar_title_states"."previous_basis_id" IS NULL) = ("series_radar_title_states"."previous_applied_at" IS NULL));--> statement-breakpoint
ALTER TABLE "series_radar_title_states" ADD CONSTRAINT "series_radar_states_distinct_check" CHECK ("series_radar_title_states"."current_basis_id" IS NULL OR "series_radar_title_states"."previous_basis_id" IS NULL OR "series_radar_title_states"."current_basis_id" <> "series_radar_title_states"."previous_basis_id");--> statement-breakpoint
ALTER TABLE "worker_execution_slots" ADD CONSTRAINT "worker_execution_slots_job_legacy_null_check" CHECK (("worker_execution_slots"."job_id" IS NULL) = ("worker_execution_slots"."legacy_job_id" IS NULL));--> statement-breakpoint
ALTER TABLE "worker_execution_slots" ADD CONSTRAINT "worker_execution_slots_attempt_legacy_null_check" CHECK (("worker_execution_slots"."attempt_id" IS NULL) = ("worker_execution_slots"."legacy_attempt_id" IS NULL));--> statement-breakpoint
ALTER TABLE "worker_execution_slots" ADD CONSTRAINT "worker_execution_slots_holder_shape_check" CHECK (("worker_execution_slots"."owner" IS NULL AND "worker_execution_slots"."task_kind" IS NULL AND "worker_execution_slots"."job_id" IS NULL AND "worker_execution_slots"."attempt_id" IS NULL AND "worker_execution_slots"."holder_preemptible" IS NULL AND "worker_execution_slots"."lease_expires_at" IS NULL) OR ("worker_execution_slots"."owner" IS NOT NULL AND "worker_execution_slots"."task_kind" IS NOT NULL AND "worker_execution_slots"."job_id" IS NOT NULL AND "worker_execution_slots"."attempt_id" IS NOT NULL AND "worker_execution_slots"."holder_preemptible" IS NOT NULL AND "worker_execution_slots"."lease_expires_at" IS NOT NULL));