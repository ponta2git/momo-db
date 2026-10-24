CREATE TABLE "achievement_claims" (
	"id" uuid PRIMARY KEY NOT NULL,
	"item_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"state" text NOT NULL,
	"match_id" uuid,
	"achieved_at" timestamp with time zone,
	"generation_id" uuid NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"updated_by_account_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "achievement_claims_source_check" CHECK ("achievement_claims"."source_kind" IN ('direct','import')),
	CONSTRAINT "achievement_claims_state_check" CHECK ("achievement_claims"."state" IN ('achieved','unconfirmed','cancelled') AND ("achievement_claims"."source_kind" <> 'direct' OR "achievement_claims"."state" <> 'unconfirmed')),
	CONSTRAINT "achievement_claims_version_check" CHECK ("achievement_claims"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "achievement_item_maps" (
	"item_id" uuid NOT NULL,
	"map_master_id" uuid NOT NULL,
	CONSTRAINT "achievement_item_maps_item_id_map_master_id_pk" PRIMARY KEY("item_id","map_master_id")
);
--> statement-breakpoint
CREATE TABLE "achievement_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"game_title_id" uuid NOT NULL,
	"fixed_key" text,
	"name" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"rule_kind" text NOT NULL,
	"threshold" numeric,
	"stars" integer NOT NULL,
	"scope_kind" text NOT NULL,
	"applies_from" date,
	"retired_at" timestamp with time zone,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "achievement_items_fixed_key_unique" UNIQUE("fixed_key"),
	CONSTRAINT "achievement_items_name_check" CHECK (length(trim("achievement_items"."name")) BETWEEN 1 AND 300 AND length("achievement_items"."notes") <= 4000),
	CONSTRAINT "achievement_items_rule_check" CHECK ("achievement_items"."rule_kind" IN ('manual','total_assets','destination','suri_no_ginji','event_average_rank')),
	CONSTRAINT "achievement_items_threshold_check" CHECK (("achievement_items"."rule_kind" = 'manual' AND "achievement_items"."threshold" IS NULL) OR ("achievement_items"."rule_kind" <> 'manual' AND "achievement_items"."threshold" IS NOT NULL AND "achievement_items"."threshold" > 0 AND "achievement_items"."threshold" < 'Infinity'::numeric AND ("achievement_items"."rule_kind" <> 'event_average_rank' OR "achievement_items"."threshold" BETWEEN 1 AND 4) AND ("achievement_items"."rule_kind" NOT IN ('destination','suri_no_ginji','total_assets') OR "achievement_items"."threshold" = trunc("achievement_items"."threshold")))),
	CONSTRAINT "achievement_items_stars_check" CHECK ("achievement_items"."stars" BETWEEN 1 AND 5),
	CONSTRAINT "achievement_items_scope_check" CHECK ("achievement_items"."scope_kind" IN ('common','maps')),
	CONSTRAINT "achievement_items_version_check" CHECK ("achievement_items"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "achievement_retired_manual_sources" (
	"item_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"generation_id" uuid NOT NULL,
	CONSTRAINT "achievement_retired_manual_sources_pk" PRIMARY KEY("item_id","claim_id","generation_id")
);
--> statement-breakpoint
CREATE TABLE "achievement_retired_snapshots" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"format_version" integer NOT NULL,
	"source_input_revision" bigint NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "achievement_retired_snapshots_format_check" CHECK ("achievement_retired_snapshots"."format_version" = 1 AND "achievement_retired_snapshots"."source_input_revision" >= 0 AND jsonb_typeof("achievement_retired_snapshots"."snapshot") = 'object')
);
--> statement-breakpoint
CREATE TABLE "series_analysis_achievement_artifacts" (
	"artifact_id" text NOT NULL,
	"scope_key" text NOT NULL,
	"scope_kind" text NOT NULL,
	"season_master_id" text,
	"map_master_id" text,
	"payload" "bytea" NOT NULL,
	"encoded_bytes" integer NOT NULL,
	"decoded_bytes" integer NOT NULL,
	"item_count" integer NOT NULL,
	"nesting_depth" integer NOT NULL,
	"checksum" text NOT NULL,
	CONSTRAINT "series_analysis_achievement_artifacts_artifact_id_scope_key_pk" PRIMARY KEY("artifact_id","scope_key"),
	CONSTRAINT "series_analysis_achievement_artifacts_domain_check" CHECK ("series_analysis_achievement_artifacts"."scope_kind" = 'overall'),
	CONSTRAINT "series_analysis_achievement_artifacts_scope_check" CHECK (("series_analysis_achievement_artifacts"."scope_kind" = 'overall' AND "series_analysis_achievement_artifacts"."season_master_id" IS NULL AND "series_analysis_achievement_artifacts"."map_master_id" IS NULL AND "series_analysis_achievement_artifacts"."scope_key" = 'overall') OR ("series_analysis_achievement_artifacts"."scope_kind" = 'season' AND "series_analysis_achievement_artifacts"."season_master_id" IS NOT NULL AND "series_analysis_achievement_artifacts"."map_master_id" IS NULL AND "series_analysis_achievement_artifacts"."scope_key" = 'season:' || "series_analysis_achievement_artifacts"."season_master_id") OR ("series_analysis_achievement_artifacts"."scope_kind" = 'map' AND "series_analysis_achievement_artifacts"."season_master_id" IS NULL AND "series_analysis_achievement_artifacts"."map_master_id" IS NOT NULL AND "series_analysis_achievement_artifacts"."scope_key" = 'map:' || "series_analysis_achievement_artifacts"."map_master_id") OR ("series_analysis_achievement_artifacts"."scope_kind" = 'season_map' AND "series_analysis_achievement_artifacts"."season_master_id" IS NOT NULL AND "series_analysis_achievement_artifacts"."map_master_id" IS NOT NULL AND "series_analysis_achievement_artifacts"."scope_key" = 'season_map:' || "series_analysis_achievement_artifacts"."season_master_id" || ':' || "series_analysis_achievement_artifacts"."map_master_id")),
	CONSTRAINT "series_analysis_achievement_artifacts_chunk_check" CHECK ("series_analysis_achievement_artifacts"."encoded_bytes" >= 2 AND "series_analysis_achievement_artifacts"."encoded_bytes" = octet_length("series_analysis_achievement_artifacts"."payload") AND "series_analysis_achievement_artifacts"."decoded_bytes" = "series_analysis_achievement_artifacts"."encoded_bytes" AND "series_analysis_achievement_artifacts"."item_count" >= 0 AND "series_analysis_achievement_artifacts"."nesting_depth" BETWEEN 1 AND 64 AND "series_analysis_achievement_artifacts"."checksum" ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "series_analysis_artifacts" DROP CONSTRAINT "series_analysis_artifacts_validation_schema_check";--> statement-breakpoint
ALTER TABLE "series_analysis_artifacts" DROP CONSTRAINT "series_analysis_artifacts_chunk_counts_check";--> statement-breakpoint
ALTER TABLE "series_analysis_campaign_targets" DROP CONSTRAINT "series_analysis_campaign_targets_validation_schema_check";--> statement-breakpoint
ALTER TABLE "series_analysis_campaigns" DROP CONSTRAINT "series_analysis_campaigns_validation_schema_check";--> statement-breakpoint
ALTER TABLE "series_analysis_job_attempts" DROP CONSTRAINT "series_analysis_job_attempts_validation_schema_check";--> statement-breakpoint
ALTER TABLE "series_analysis_job_requests" DROP CONSTRAINT "series_analysis_job_requests_validation_schema_check";--> statement-breakpoint
ALTER TABLE "series_analysis_job_requests" DROP CONSTRAINT "series_analysis_job_requests_trigger_check";--> statement-breakpoint
ALTER TABLE "series_analysis_jobs" DROP CONSTRAINT "series_analysis_jobs_validation_schema_check";--> statement-breakpoint
ALTER TABLE "series_analysis_jobs" DROP CONSTRAINT "series_analysis_jobs_trigger_check";--> statement-breakpoint
ALTER TABLE "series_analysis_release_state" DROP CONSTRAINT "series_analysis_release_state_validation_schema_check";--> statement-breakpoint
ALTER TABLE "series_analysis_title_states" DROP CONSTRAINT "series_analysis_title_states_validation_schema_check";--> statement-breakpoint
ALTER TABLE "series_analysis_artifacts" ADD COLUMN "achievement_chunk_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "achievement_claims" ADD CONSTRAINT "achievement_claims_item_id_achievement_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."achievement_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "achievement_claims" ADD CONSTRAINT "achievement_claims_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "achievement_claims" ADD CONSTRAINT "achievement_claims_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "achievement_claims" ADD CONSTRAINT "achievement_claims_updated_by_account_id_momo_login_accounts_id_fk" FOREIGN KEY ("updated_by_account_id") REFERENCES "public"."momo_login_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "achievement_item_maps" ADD CONSTRAINT "achievement_item_maps_item_id_achievement_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."achievement_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "achievement_item_maps" ADD CONSTRAINT "achievement_item_maps_map_master_id_map_masters_id_fk" FOREIGN KEY ("map_master_id") REFERENCES "public"."map_masters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "achievement_items" ADD CONSTRAINT "achievement_items_game_title_id_game_titles_id_fk" FOREIGN KEY ("game_title_id") REFERENCES "public"."game_titles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "achievement_retired_manual_sources" ADD CONSTRAINT "achievement_retired_manual_sources_item_id_achievement_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."achievement_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "achievement_retired_manual_sources" ADD CONSTRAINT "achievement_retired_manual_sources_claim_id_achievement_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."achievement_claims"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "achievement_retired_snapshots" ADD CONSTRAINT "achievement_retired_snapshots_item_id_achievement_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."achievement_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_analysis_achievement_artifacts" ADD CONSTRAINT "series_analysis_achievement_artifacts_artifact_id_series_analysis_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."series_analysis_artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "achievement_claims_root_unique" ON "achievement_claims" USING btree ("item_id","member_id","source_kind");--> statement-breakpoint
CREATE INDEX "achievement_claims_match_idx" ON "achievement_claims" USING btree ("match_id");--> statement-breakpoint
CREATE INDEX "achievement_items_title_idx" ON "achievement_items" USING btree ("game_title_id");--> statement-breakpoint
ALTER TABLE "series_analysis_artifacts" ADD CONSTRAINT "series_analysis_artifacts_validation_schema_check" CHECK (("series_analysis_artifacts"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v2-full-validation-v1' OR "series_analysis_artifacts"."artifact_schema_version" = 2)
      AND ("series_analysis_artifacts"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v3-full-validation-v1' OR "series_analysis_artifacts"."artifact_schema_version" = 3)
      AND ("series_analysis_artifacts"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v4-full-validation-v1' OR "series_analysis_artifacts"."artifact_schema_version" = 4)
      AND ("series_analysis_artifacts"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v5-full-validation-v1' OR "series_analysis_artifacts"."artifact_schema_version" = 5)
      AND ("series_analysis_artifacts"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v6-full-validation-v1' OR "series_analysis_artifacts"."artifact_schema_version" = 6)
      AND ("series_analysis_artifacts"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v7-full-validation-v1' OR "series_analysis_artifacts"."artifact_schema_version" = 7));--> statement-breakpoint
ALTER TABLE "series_analysis_artifacts" ADD CONSTRAINT "series_analysis_artifacts_chunk_counts_check" CHECK ("series_analysis_artifacts"."aggregate_chunk_count" >= 1 AND "series_analysis_artifacts"."review_chunk_count" >= 0 AND "series_analysis_artifacts"."drilldown_chunk_count" >= 0 AND "series_analysis_artifacts"."match_context_chunk_count" >= 0 AND "series_analysis_artifacts"."outlook_summary_chunk_count" >= 0 AND "series_analysis_artifacts"."outlook_reference_chunk_count" >= 0 AND "series_analysis_artifacts"."achievement_chunk_count" >= 0);--> statement-breakpoint
ALTER TABLE "series_analysis_campaign_targets" ADD CONSTRAINT "series_analysis_campaign_targets_validation_schema_check" CHECK (("series_analysis_campaign_targets"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v2-full-validation-v1' OR "series_analysis_campaign_targets"."artifact_schema_version" = 2)
      AND ("series_analysis_campaign_targets"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v3-full-validation-v1' OR "series_analysis_campaign_targets"."artifact_schema_version" = 3)
      AND ("series_analysis_campaign_targets"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v4-full-validation-v1' OR "series_analysis_campaign_targets"."artifact_schema_version" = 4)
      AND ("series_analysis_campaign_targets"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v5-full-validation-v1' OR "series_analysis_campaign_targets"."artifact_schema_version" = 5)
      AND ("series_analysis_campaign_targets"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v6-full-validation-v1' OR "series_analysis_campaign_targets"."artifact_schema_version" = 6)
      AND ("series_analysis_campaign_targets"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v7-full-validation-v1' OR "series_analysis_campaign_targets"."artifact_schema_version" = 7));--> statement-breakpoint
ALTER TABLE "series_analysis_campaigns" ADD CONSTRAINT "series_analysis_campaigns_validation_schema_check" CHECK (("series_analysis_campaigns"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v2-full-validation-v1' OR "series_analysis_campaigns"."artifact_schema_version" = 2)
      AND ("series_analysis_campaigns"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v3-full-validation-v1' OR "series_analysis_campaigns"."artifact_schema_version" = 3)
      AND ("series_analysis_campaigns"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v4-full-validation-v1' OR "series_analysis_campaigns"."artifact_schema_version" = 4)
      AND ("series_analysis_campaigns"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v5-full-validation-v1' OR "series_analysis_campaigns"."artifact_schema_version" = 5)
      AND ("series_analysis_campaigns"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v6-full-validation-v1' OR "series_analysis_campaigns"."artifact_schema_version" = 6)
      AND ("series_analysis_campaigns"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v7-full-validation-v1' OR "series_analysis_campaigns"."artifact_schema_version" = 7));--> statement-breakpoint
ALTER TABLE "series_analysis_job_attempts" ADD CONSTRAINT "series_analysis_job_attempts_validation_schema_check" CHECK (("series_analysis_job_attempts"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v2-full-validation-v1' OR "series_analysis_job_attempts"."artifact_schema_version" = 2)
      AND ("series_analysis_job_attempts"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v3-full-validation-v1' OR "series_analysis_job_attempts"."artifact_schema_version" = 3)
      AND ("series_analysis_job_attempts"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v4-full-validation-v1' OR "series_analysis_job_attempts"."artifact_schema_version" = 4)
      AND ("series_analysis_job_attempts"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v5-full-validation-v1' OR "series_analysis_job_attempts"."artifact_schema_version" = 5)
      AND ("series_analysis_job_attempts"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v6-full-validation-v1' OR "series_analysis_job_attempts"."artifact_schema_version" = 6)
      AND ("series_analysis_job_attempts"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v7-full-validation-v1' OR "series_analysis_job_attempts"."artifact_schema_version" = 7));--> statement-breakpoint
ALTER TABLE "series_analysis_job_requests" ADD CONSTRAINT "series_analysis_job_requests_validation_schema_check" CHECK (("series_analysis_job_requests"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v2-full-validation-v1' OR "series_analysis_job_requests"."artifact_schema_version" = 2)
      AND ("series_analysis_job_requests"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v3-full-validation-v1' OR "series_analysis_job_requests"."artifact_schema_version" = 3)
      AND ("series_analysis_job_requests"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v4-full-validation-v1' OR "series_analysis_job_requests"."artifact_schema_version" = 4)
      AND ("series_analysis_job_requests"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v5-full-validation-v1' OR "series_analysis_job_requests"."artifact_schema_version" = 5)
      AND ("series_analysis_job_requests"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v6-full-validation-v1' OR "series_analysis_job_requests"."artifact_schema_version" = 6)
      AND ("series_analysis_job_requests"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v7-full-validation-v1' OR "series_analysis_job_requests"."artifact_schema_version" = 7));--> statement-breakpoint
ALTER TABLE "series_analysis_job_requests" ADD CONSTRAINT "series_analysis_job_requests_trigger_check" CHECK ("series_analysis_job_requests"."trigger" IN ('manual','artifact_schema_update','algorithm_update','validation_contract_update','initial_backfill','match_mutation','achievement_mutation'));--> statement-breakpoint
ALTER TABLE "series_analysis_jobs" ADD CONSTRAINT "series_analysis_jobs_validation_schema_check" CHECK (("series_analysis_jobs"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v2-full-validation-v1' OR "series_analysis_jobs"."artifact_schema_version" = 2)
      AND ("series_analysis_jobs"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v3-full-validation-v1' OR "series_analysis_jobs"."artifact_schema_version" = 3)
      AND ("series_analysis_jobs"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v4-full-validation-v1' OR "series_analysis_jobs"."artifact_schema_version" = 4)
      AND ("series_analysis_jobs"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v5-full-validation-v1' OR "series_analysis_jobs"."artifact_schema_version" = 5)
      AND ("series_analysis_jobs"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v6-full-validation-v1' OR "series_analysis_jobs"."artifact_schema_version" = 6)
      AND ("series_analysis_jobs"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v7-full-validation-v1' OR "series_analysis_jobs"."artifact_schema_version" = 7));--> statement-breakpoint
ALTER TABLE "series_analysis_jobs" ADD CONSTRAINT "series_analysis_jobs_trigger_check" CHECK ("series_analysis_jobs"."trigger" IN ('manual','artifact_schema_update','algorithm_update','validation_contract_update','initial_backfill','match_mutation','achievement_mutation'));--> statement-breakpoint
ALTER TABLE "series_analysis_release_state" ADD CONSTRAINT "series_analysis_release_state_validation_schema_check" CHECK (("series_analysis_release_state"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v2-full-validation-v1' OR "series_analysis_release_state"."artifact_schema_version" = 2)
      AND ("series_analysis_release_state"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v3-full-validation-v1' OR "series_analysis_release_state"."artifact_schema_version" = 3)
      AND ("series_analysis_release_state"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v4-full-validation-v1' OR "series_analysis_release_state"."artifact_schema_version" = 4)
      AND ("series_analysis_release_state"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v5-full-validation-v1' OR "series_analysis_release_state"."artifact_schema_version" = 5)
      AND ("series_analysis_release_state"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v6-full-validation-v1' OR "series_analysis_release_state"."artifact_schema_version" = 6)
      AND ("series_analysis_release_state"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v7-full-validation-v1' OR "series_analysis_release_state"."artifact_schema_version" = 7));--> statement-breakpoint
ALTER TABLE "series_analysis_title_states" ADD CONSTRAINT "series_analysis_title_states_validation_schema_check" CHECK (("series_analysis_title_states"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v2-full-validation-v1' OR "series_analysis_title_states"."artifact_schema_version" = 2)
      AND ("series_analysis_title_states"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v3-full-validation-v1' OR "series_analysis_title_states"."artifact_schema_version" = 3)
      AND ("series_analysis_title_states"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v4-full-validation-v1' OR "series_analysis_title_states"."artifact_schema_version" = 4)
      AND ("series_analysis_title_states"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v5-full-validation-v1' OR "series_analysis_title_states"."artifact_schema_version" = 5)
      AND ("series_analysis_title_states"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v6-full-validation-v1' OR "series_analysis_title_states"."artifact_schema_version" = 6)
      AND ("series_analysis_title_states"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v7-full-validation-v1' OR "series_analysis_title_states"."artifact_schema_version" = 7));