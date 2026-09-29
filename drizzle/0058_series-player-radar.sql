CREATE TABLE "series_radar_acknowledgements" (
	"game_title_id" text NOT NULL,
	"evidence_key" text NOT NULL,
	"requested_by" text NOT NULL,
	"acknowledged_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "series_radar_acknowledgements_game_title_id_evidence_key_pk" PRIMARY KEY("game_title_id","evidence_key")
);
--> statement-breakpoint
CREATE TABLE "series_radar_bases" (
	"id" text PRIMARY KEY NOT NULL,
	"game_title_id" text NOT NULL,
	"checksum" text NOT NULL,
	"payload" jsonb NOT NULL,
	"source_snapshot" jsonb,
	"source_checksum" text NOT NULL,
	"source_input_revision" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "series_radar_bases_id_title_unique" UNIQUE("id","game_title_id"),
	CONSTRAINT "series_radar_bases_revision_check" CHECK ("series_radar_bases"."source_input_revision" >= 0),
	CONSTRAINT "series_radar_bases_checksum_check" CHECK ("series_radar_bases"."checksum" ~ '^sha256:[0-9a-f]{64}$' AND "series_radar_bases"."source_checksum" ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "series_radar_candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"game_title_id" text NOT NULL,
	"basis_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"source_input_revision" bigint,
	"safe_failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "series_radar_candidates_id_title_unique" UNIQUE("id","game_title_id"),
	CONSTRAINT "series_radar_candidates_status_check" CHECK ("series_radar_candidates"."status" IN ('pending','ready','unavailable','invalid','withdrawn','applied','failed'))
);
--> statement-breakpoint
CREATE TABLE "series_radar_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"game_title_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"candidate_id" text,
	"preview_id" text,
	"basis_id" text,
	"origin_operation_id" text,
	"requested_by" text NOT NULL,
	"idempotency_key_hash" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"job_id" text,
	"safe_failure_code" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "series_radar_operations_id_title_unique" UNIQUE("id","game_title_id"),
	CONSTRAINT "series_radar_operations_kind_check" CHECK ("series_radar_operations"."kind" IN ('candidate','preview','apply','withdraw','restore','acknowledge','retry')),
	CONSTRAINT "series_radar_operations_status_check" CHECK ("series_radar_operations"."status" IN ('pending','running','succeeded','failed','withdrawn'))
);
--> statement-breakpoint
CREATE TABLE "series_radar_preview_scopes" (
	"preview_id" text NOT NULL,
	"scope_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "series_radar_preview_scopes_preview_id_scope_key_pk" PRIMARY KEY("preview_id","scope_key")
);
--> statement-breakpoint
CREATE TABLE "series_radar_previews" (
	"id" text PRIMARY KEY NOT NULL,
	"game_title_id" text NOT NULL,
	"candidate_id" text NOT NULL,
	"before_basis_id" text,
	"input_revision" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"input_checksum" text,
	"evaluation_snapshot" jsonb,
	"scope_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "series_radar_previews_id_title_unique" UNIQUE("id","game_title_id"),
	CONSTRAINT "series_radar_previews_status_check" CHECK ("series_radar_previews"."status" IN ('pending','ready','stale','failed')),
	CONSTRAINT "series_radar_previews_revision_check" CHECK ("series_radar_previews"."input_revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "series_radar_title_states" (
	"game_title_id" text PRIMARY KEY NOT NULL,
	"desired_basis_id" text,
	"current_basis_id" text,
	"previous_basis_id" text,
	"current_applied_at" timestamp with time zone,
	"previous_applied_at" timestamp with time zone,
	"generation" bigint DEFAULT 0 NOT NULL,
	"active_operation_id" text,
	"monitor" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "series_radar_states_generation_check" CHECK ("series_radar_title_states"."generation" >= 0),
	CONSTRAINT "series_radar_states_current_pair_check" CHECK (("series_radar_title_states"."current_basis_id" IS NULL) = ("series_radar_title_states"."current_applied_at" IS NULL)),
	CONSTRAINT "series_radar_states_previous_pair_check" CHECK (("series_radar_title_states"."previous_basis_id" IS NULL) = ("series_radar_title_states"."previous_applied_at" IS NULL)),
	CONSTRAINT "series_radar_states_distinct_check" CHECK ("series_radar_title_states"."current_basis_id" IS NULL OR "series_radar_title_states"."previous_basis_id" IS NULL OR "series_radar_title_states"."current_basis_id" <> "series_radar_title_states"."previous_basis_id")
);
--> statement-breakpoint
ALTER TABLE "series_analysis_artifacts" DROP CONSTRAINT "series_analysis_artifacts_validation_schema_check";--> statement-breakpoint
ALTER TABLE "series_analysis_campaign_targets" DROP CONSTRAINT "series_analysis_campaign_targets_validation_schema_check";--> statement-breakpoint
ALTER TABLE "series_analysis_campaigns" DROP CONSTRAINT "series_analysis_campaigns_validation_schema_check";--> statement-breakpoint
ALTER TABLE "series_analysis_job_attempts" DROP CONSTRAINT "series_analysis_job_attempts_validation_schema_check";--> statement-breakpoint
ALTER TABLE "series_analysis_job_requests" DROP CONSTRAINT "series_analysis_job_requests_validation_schema_check";--> statement-breakpoint
ALTER TABLE "series_analysis_jobs" DROP CONSTRAINT "series_analysis_jobs_validation_schema_check";--> statement-breakpoint
ALTER TABLE "series_analysis_release_state" DROP CONSTRAINT "series_analysis_release_state_validation_schema_check";--> statement-breakpoint
ALTER TABLE "series_analysis_title_states" DROP CONSTRAINT "series_analysis_title_states_validation_schema_check";--> statement-breakpoint
ALTER TABLE "series_analysis_artifacts" ADD COLUMN "radar_basis_id" text;--> statement-breakpoint
ALTER TABLE "series_analysis_artifacts" ADD COLUMN "radar_generation" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "series_analysis_artifacts" ADD COLUMN "radar_applied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "series_analysis_artifacts" ADD COLUMN "scope_keys" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "series_analysis_jobs" ADD COLUMN "work_kind" text DEFAULT 'analysis' NOT NULL;--> statement-breakpoint
ALTER TABLE "series_analysis_jobs" ADD COLUMN "radar_operation_id" text;--> statement-breakpoint
ALTER TABLE "series_analysis_jobs" ADD COLUMN "radar_basis_id" text;--> statement-breakpoint
ALTER TABLE "series_analysis_jobs" ADD COLUMN "radar_generation" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "series_radar_acknowledgements" ADD CONSTRAINT "series_radar_acknowledgements_game_title_id_game_titles_id_fk" FOREIGN KEY ("game_title_id") REFERENCES "public"."game_titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_radar_bases" ADD CONSTRAINT "series_radar_bases_game_title_id_game_titles_id_fk" FOREIGN KEY ("game_title_id") REFERENCES "public"."game_titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_radar_candidates" ADD CONSTRAINT "series_radar_candidates_game_title_id_game_titles_id_fk" FOREIGN KEY ("game_title_id") REFERENCES "public"."game_titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_radar_candidates" ADD CONSTRAINT "series_radar_candidate_basis_fk" FOREIGN KEY ("basis_id","game_title_id") REFERENCES "public"."series_radar_bases"("id","game_title_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_radar_operations" ADD CONSTRAINT "series_radar_operations_game_title_id_game_titles_id_fk" FOREIGN KEY ("game_title_id") REFERENCES "public"."game_titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_radar_operations" ADD CONSTRAINT "series_radar_operation_candidate_fk" FOREIGN KEY ("candidate_id","game_title_id") REFERENCES "public"."series_radar_candidates"("id","game_title_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_radar_operations" ADD CONSTRAINT "series_radar_operation_preview_fk" FOREIGN KEY ("preview_id","game_title_id") REFERENCES "public"."series_radar_previews"("id","game_title_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_radar_operations" ADD CONSTRAINT "series_radar_operation_basis_fk" FOREIGN KEY ("basis_id","game_title_id") REFERENCES "public"."series_radar_bases"("id","game_title_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_radar_preview_scopes" ADD CONSTRAINT "series_radar_preview_scopes_preview_id_series_radar_previews_id_fk" FOREIGN KEY ("preview_id") REFERENCES "public"."series_radar_previews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_radar_previews" ADD CONSTRAINT "series_radar_previews_game_title_id_game_titles_id_fk" FOREIGN KEY ("game_title_id") REFERENCES "public"."game_titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_radar_previews" ADD CONSTRAINT "series_radar_preview_candidate_fk" FOREIGN KEY ("candidate_id","game_title_id") REFERENCES "public"."series_radar_candidates"("id","game_title_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_radar_previews" ADD CONSTRAINT "series_radar_preview_basis_fk" FOREIGN KEY ("before_basis_id","game_title_id") REFERENCES "public"."series_radar_bases"("id","game_title_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_radar_title_states" ADD CONSTRAINT "series_radar_title_states_game_title_id_game_titles_id_fk" FOREIGN KEY ("game_title_id") REFERENCES "public"."game_titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_radar_title_states" ADD CONSTRAINT "series_radar_state_desired_basis_fk" FOREIGN KEY ("desired_basis_id","game_title_id") REFERENCES "public"."series_radar_bases"("id","game_title_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_radar_title_states" ADD CONSTRAINT "series_radar_state_current_basis_fk" FOREIGN KEY ("current_basis_id","game_title_id") REFERENCES "public"."series_radar_bases"("id","game_title_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_radar_title_states" ADD CONSTRAINT "series_radar_state_previous_basis_fk" FOREIGN KEY ("previous_basis_id","game_title_id") REFERENCES "public"."series_radar_bases"("id","game_title_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_radar_title_states" ADD CONSTRAINT "series_radar_state_operation_fk" FOREIGN KEY ("active_operation_id","game_title_id") REFERENCES "public"."series_radar_operations"("id","game_title_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "series_radar_candidates_active_unique" ON "series_radar_candidates" USING btree ("game_title_id") WHERE "series_radar_candidates"."status" IN ('pending','ready','unavailable','failed');--> statement-breakpoint
CREATE INDEX "series_radar_candidates_title_created_idx" ON "series_radar_candidates" USING btree ("game_title_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "series_radar_operations_idempotency_unique" ON "series_radar_operations" USING btree ("game_title_id","requested_by","idempotency_key_hash");--> statement-breakpoint
CREATE INDEX "series_radar_operations_pending_idx" ON "series_radar_operations" USING btree ("requested_at","id") WHERE "series_radar_operations"."status" = 'pending' AND "series_radar_operations"."job_id" IS NULL;--> statement-breakpoint
CREATE INDEX "series_radar_operations_title_created_idx" ON "series_radar_operations" USING btree ("game_title_id","requested_at");--> statement-breakpoint
CREATE INDEX "series_radar_previews_candidate_created_idx" ON "series_radar_previews" USING btree ("candidate_id","created_at");--> statement-breakpoint
ALTER TABLE "series_analysis_artifacts" ADD CONSTRAINT "series_analysis_artifacts_radar_basis_id_series_radar_bases_id_fk" FOREIGN KEY ("radar_basis_id") REFERENCES "public"."series_radar_bases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_analysis_jobs" ADD CONSTRAINT "series_analysis_jobs_radar_basis_id_series_radar_bases_id_fk" FOREIGN KEY ("radar_basis_id") REFERENCES "public"."series_radar_bases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_analysis_artifacts" ADD CONSTRAINT "series_analysis_artifacts_validation_schema_check" CHECK (("series_analysis_artifacts"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v2-full-validation-v1' OR "series_analysis_artifacts"."artifact_schema_version" = 2)
      AND ("series_analysis_artifacts"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v3-full-validation-v1' OR "series_analysis_artifacts"."artifact_schema_version" = 3)
      AND ("series_analysis_artifacts"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v4-full-validation-v1' OR "series_analysis_artifacts"."artifact_schema_version" = 4)
      AND ("series_analysis_artifacts"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v5-full-validation-v1' OR "series_analysis_artifacts"."artifact_schema_version" = 5));--> statement-breakpoint
ALTER TABLE "series_analysis_campaign_targets" ADD CONSTRAINT "series_analysis_campaign_targets_validation_schema_check" CHECK (("series_analysis_campaign_targets"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v2-full-validation-v1' OR "series_analysis_campaign_targets"."artifact_schema_version" = 2)
      AND ("series_analysis_campaign_targets"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v3-full-validation-v1' OR "series_analysis_campaign_targets"."artifact_schema_version" = 3)
      AND ("series_analysis_campaign_targets"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v4-full-validation-v1' OR "series_analysis_campaign_targets"."artifact_schema_version" = 4)
      AND ("series_analysis_campaign_targets"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v5-full-validation-v1' OR "series_analysis_campaign_targets"."artifact_schema_version" = 5));--> statement-breakpoint
ALTER TABLE "series_analysis_campaigns" ADD CONSTRAINT "series_analysis_campaigns_validation_schema_check" CHECK (("series_analysis_campaigns"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v2-full-validation-v1' OR "series_analysis_campaigns"."artifact_schema_version" = 2)
      AND ("series_analysis_campaigns"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v3-full-validation-v1' OR "series_analysis_campaigns"."artifact_schema_version" = 3)
      AND ("series_analysis_campaigns"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v4-full-validation-v1' OR "series_analysis_campaigns"."artifact_schema_version" = 4)
      AND ("series_analysis_campaigns"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v5-full-validation-v1' OR "series_analysis_campaigns"."artifact_schema_version" = 5));--> statement-breakpoint
ALTER TABLE "series_analysis_job_attempts" ADD CONSTRAINT "series_analysis_job_attempts_validation_schema_check" CHECK (("series_analysis_job_attempts"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v2-full-validation-v1' OR "series_analysis_job_attempts"."artifact_schema_version" = 2)
      AND ("series_analysis_job_attempts"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v3-full-validation-v1' OR "series_analysis_job_attempts"."artifact_schema_version" = 3)
      AND ("series_analysis_job_attempts"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v4-full-validation-v1' OR "series_analysis_job_attempts"."artifact_schema_version" = 4)
      AND ("series_analysis_job_attempts"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v5-full-validation-v1' OR "series_analysis_job_attempts"."artifact_schema_version" = 5));--> statement-breakpoint
ALTER TABLE "series_analysis_job_requests" ADD CONSTRAINT "series_analysis_job_requests_validation_schema_check" CHECK (("series_analysis_job_requests"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v2-full-validation-v1' OR "series_analysis_job_requests"."artifact_schema_version" = 2)
      AND ("series_analysis_job_requests"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v3-full-validation-v1' OR "series_analysis_job_requests"."artifact_schema_version" = 3)
      AND ("series_analysis_job_requests"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v4-full-validation-v1' OR "series_analysis_job_requests"."artifact_schema_version" = 4)
      AND ("series_analysis_job_requests"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v5-full-validation-v1' OR "series_analysis_job_requests"."artifact_schema_version" = 5));--> statement-breakpoint
ALTER TABLE "series_analysis_jobs" ADD CONSTRAINT "series_analysis_jobs_work_kind_check" CHECK ("series_analysis_jobs"."work_kind" IN ('analysis','radar_prepare'));--> statement-breakpoint
ALTER TABLE "series_analysis_jobs" ADD CONSTRAINT "series_analysis_jobs_radar_purpose_check" CHECK (("series_analysis_jobs"."work_kind" = 'radar_prepare') = ("series_analysis_jobs"."radar_operation_id" IS NOT NULL) AND "series_analysis_jobs"."radar_generation" >= 0);--> statement-breakpoint
ALTER TABLE "series_analysis_jobs" ADD CONSTRAINT "series_analysis_jobs_validation_schema_check" CHECK (("series_analysis_jobs"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v2-full-validation-v1' OR "series_analysis_jobs"."artifact_schema_version" = 2)
      AND ("series_analysis_jobs"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v3-full-validation-v1' OR "series_analysis_jobs"."artifact_schema_version" = 3)
      AND ("series_analysis_jobs"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v4-full-validation-v1' OR "series_analysis_jobs"."artifact_schema_version" = 4)
      AND ("series_analysis_jobs"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v5-full-validation-v1' OR "series_analysis_jobs"."artifact_schema_version" = 5));--> statement-breakpoint
ALTER TABLE "series_analysis_release_state" ADD CONSTRAINT "series_analysis_release_state_validation_schema_check" CHECK (("series_analysis_release_state"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v2-full-validation-v1' OR "series_analysis_release_state"."artifact_schema_version" = 2)
      AND ("series_analysis_release_state"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v3-full-validation-v1' OR "series_analysis_release_state"."artifact_schema_version" = 3)
      AND ("series_analysis_release_state"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v4-full-validation-v1' OR "series_analysis_release_state"."artifact_schema_version" = 4)
      AND ("series_analysis_release_state"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v5-full-validation-v1' OR "series_analysis_release_state"."artifact_schema_version" = 5));--> statement-breakpoint
ALTER TABLE "series_analysis_title_states" ADD CONSTRAINT "series_analysis_title_states_validation_schema_check" CHECK (("series_analysis_title_states"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v2-full-validation-v1' OR "series_analysis_title_states"."artifact_schema_version" = 2)
      AND ("series_analysis_title_states"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v3-full-validation-v1' OR "series_analysis_title_states"."artifact_schema_version" = 3)
      AND ("series_analysis_title_states"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v4-full-validation-v1' OR "series_analysis_title_states"."artifact_schema_version" = 4)
      AND ("series_analysis_title_states"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v5-full-validation-v1' OR "series_analysis_title_states"."artifact_schema_version" = 5));