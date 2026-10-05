CREATE TABLE "series_analysis_outlook_reference_artifacts" (
	"artifact_id" text NOT NULL,
	"scope_key" text NOT NULL,
	"scope_kind" text NOT NULL,
	"season_master_id" text,
	"map_master_id" text,
	"member_id" text NOT NULL,
	"payload" "bytea" NOT NULL,
	"encoded_bytes" integer NOT NULL,
	"decoded_bytes" integer NOT NULL,
	"item_count" integer NOT NULL,
	"nesting_depth" integer NOT NULL,
	"checksum" text NOT NULL,
	CONSTRAINT "series_analysis_outlook_reference_artifacts_artifact_id_scope_key_member_id_pk" PRIMARY KEY("artifact_id","scope_key","member_id"),
	CONSTRAINT "series_analysis_outlook_reference_artifacts_domain_check" CHECK ("series_analysis_outlook_reference_artifacts"."scope_kind" = 'overall' AND length("series_analysis_outlook_reference_artifacts"."member_id") BETWEEN 1 AND 128 AND "series_analysis_outlook_reference_artifacts"."item_count" BETWEEN 1 AND 2771),
	CONSTRAINT "series_analysis_outlook_reference_artifacts_scope_check" CHECK (("series_analysis_outlook_reference_artifacts"."scope_kind" = 'overall' AND "series_analysis_outlook_reference_artifacts"."season_master_id" IS NULL AND "series_analysis_outlook_reference_artifacts"."map_master_id" IS NULL AND "series_analysis_outlook_reference_artifacts"."scope_key" = 'overall') OR ("series_analysis_outlook_reference_artifacts"."scope_kind" = 'season' AND "series_analysis_outlook_reference_artifacts"."season_master_id" IS NOT NULL AND "series_analysis_outlook_reference_artifacts"."map_master_id" IS NULL AND "series_analysis_outlook_reference_artifacts"."scope_key" = 'season:' || "series_analysis_outlook_reference_artifacts"."season_master_id") OR ("series_analysis_outlook_reference_artifacts"."scope_kind" = 'map' AND "series_analysis_outlook_reference_artifacts"."season_master_id" IS NULL AND "series_analysis_outlook_reference_artifacts"."map_master_id" IS NOT NULL AND "series_analysis_outlook_reference_artifacts"."scope_key" = 'map:' || "series_analysis_outlook_reference_artifacts"."map_master_id") OR ("series_analysis_outlook_reference_artifacts"."scope_kind" = 'season_map' AND "series_analysis_outlook_reference_artifacts"."season_master_id" IS NOT NULL AND "series_analysis_outlook_reference_artifacts"."map_master_id" IS NOT NULL AND "series_analysis_outlook_reference_artifacts"."scope_key" = 'season_map:' || "series_analysis_outlook_reference_artifacts"."season_master_id" || ':' || "series_analysis_outlook_reference_artifacts"."map_master_id")),
	CONSTRAINT "series_analysis_outlook_reference_artifacts_chunk_check" CHECK ("series_analysis_outlook_reference_artifacts"."encoded_bytes" >= 2 AND "series_analysis_outlook_reference_artifacts"."encoded_bytes" = octet_length("series_analysis_outlook_reference_artifacts"."payload") AND "series_analysis_outlook_reference_artifacts"."decoded_bytes" = "series_analysis_outlook_reference_artifacts"."encoded_bytes" AND "series_analysis_outlook_reference_artifacts"."item_count" >= 0 AND "series_analysis_outlook_reference_artifacts"."nesting_depth" BETWEEN 1 AND 64 AND "series_analysis_outlook_reference_artifacts"."checksum" ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "series_analysis_outlook_summary_artifacts" (
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
	CONSTRAINT "series_analysis_outlook_summary_artifacts_artifact_id_scope_key_pk" PRIMARY KEY("artifact_id","scope_key"),
	CONSTRAINT "series_analysis_outlook_summary_artifacts_domain_check" CHECK ("series_analysis_outlook_summary_artifacts"."scope_kind" IN ('overall','season') AND "series_analysis_outlook_summary_artifacts"."item_count" IN (0,4)),
	CONSTRAINT "series_analysis_outlook_summary_artifacts_scope_check" CHECK (("series_analysis_outlook_summary_artifacts"."scope_kind" = 'overall' AND "series_analysis_outlook_summary_artifacts"."season_master_id" IS NULL AND "series_analysis_outlook_summary_artifacts"."map_master_id" IS NULL AND "series_analysis_outlook_summary_artifacts"."scope_key" = 'overall') OR ("series_analysis_outlook_summary_artifacts"."scope_kind" = 'season' AND "series_analysis_outlook_summary_artifacts"."season_master_id" IS NOT NULL AND "series_analysis_outlook_summary_artifacts"."map_master_id" IS NULL AND "series_analysis_outlook_summary_artifacts"."scope_key" = 'season:' || "series_analysis_outlook_summary_artifacts"."season_master_id") OR ("series_analysis_outlook_summary_artifacts"."scope_kind" = 'map' AND "series_analysis_outlook_summary_artifacts"."season_master_id" IS NULL AND "series_analysis_outlook_summary_artifacts"."map_master_id" IS NOT NULL AND "series_analysis_outlook_summary_artifacts"."scope_key" = 'map:' || "series_analysis_outlook_summary_artifacts"."map_master_id") OR ("series_analysis_outlook_summary_artifacts"."scope_kind" = 'season_map' AND "series_analysis_outlook_summary_artifacts"."season_master_id" IS NOT NULL AND "series_analysis_outlook_summary_artifacts"."map_master_id" IS NOT NULL AND "series_analysis_outlook_summary_artifacts"."scope_key" = 'season_map:' || "series_analysis_outlook_summary_artifacts"."season_master_id" || ':' || "series_analysis_outlook_summary_artifacts"."map_master_id")),
	CONSTRAINT "series_analysis_outlook_summary_artifacts_chunk_check" CHECK ("series_analysis_outlook_summary_artifacts"."encoded_bytes" >= 2 AND "series_analysis_outlook_summary_artifacts"."encoded_bytes" = octet_length("series_analysis_outlook_summary_artifacts"."payload") AND "series_analysis_outlook_summary_artifacts"."decoded_bytes" = "series_analysis_outlook_summary_artifacts"."encoded_bytes" AND "series_analysis_outlook_summary_artifacts"."item_count" >= 0 AND "series_analysis_outlook_summary_artifacts"."nesting_depth" BETWEEN 1 AND 64 AND "series_analysis_outlook_summary_artifacts"."checksum" ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "series_analysis_artifacts" DROP CONSTRAINT "series_analysis_artifacts_validation_schema_check";--> statement-breakpoint
ALTER TABLE "series_analysis_artifacts" DROP CONSTRAINT "series_analysis_artifacts_chunk_counts_check";--> statement-breakpoint
ALTER TABLE "series_analysis_campaign_targets" DROP CONSTRAINT "series_analysis_campaign_targets_validation_schema_check";--> statement-breakpoint
ALTER TABLE "series_analysis_campaigns" DROP CONSTRAINT "series_analysis_campaigns_validation_schema_check";--> statement-breakpoint
ALTER TABLE "series_analysis_job_attempts" DROP CONSTRAINT "series_analysis_job_attempts_validation_schema_check";--> statement-breakpoint
ALTER TABLE "series_analysis_job_requests" DROP CONSTRAINT "series_analysis_job_requests_validation_schema_check";--> statement-breakpoint
ALTER TABLE "series_analysis_jobs" DROP CONSTRAINT "series_analysis_jobs_validation_schema_check";--> statement-breakpoint
ALTER TABLE "series_analysis_release_state" DROP CONSTRAINT "series_analysis_release_state_validation_schema_check";--> statement-breakpoint
ALTER TABLE "series_analysis_title_states" DROP CONSTRAINT "series_analysis_title_states_validation_schema_check";--> statement-breakpoint
ALTER TABLE "series_analysis_artifacts" ADD COLUMN "outlook_summary_chunk_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "series_analysis_artifacts" ADD COLUMN "outlook_reference_chunk_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "series_analysis_outlook_reference_artifacts" ADD CONSTRAINT "series_analysis_outlook_reference_artifacts_artifact_id_series_analysis_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."series_analysis_artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_analysis_outlook_summary_artifacts" ADD CONSTRAINT "series_analysis_outlook_summary_artifacts_artifact_id_series_analysis_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."series_analysis_artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_analysis_artifacts" ADD CONSTRAINT "series_analysis_artifacts_validation_schema_check" CHECK (("series_analysis_artifacts"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v2-full-validation-v1' OR "series_analysis_artifacts"."artifact_schema_version" = 2)
      AND ("series_analysis_artifacts"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v3-full-validation-v1' OR "series_analysis_artifacts"."artifact_schema_version" = 3)
      AND ("series_analysis_artifacts"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v4-full-validation-v1' OR "series_analysis_artifacts"."artifact_schema_version" = 4)
      AND ("series_analysis_artifacts"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v5-full-validation-v1' OR "series_analysis_artifacts"."artifact_schema_version" = 5)
      AND ("series_analysis_artifacts"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v6-full-validation-v1' OR "series_analysis_artifacts"."artifact_schema_version" = 6));--> statement-breakpoint
ALTER TABLE "series_analysis_artifacts" ADD CONSTRAINT "series_analysis_artifacts_chunk_counts_check" CHECK ("series_analysis_artifacts"."aggregate_chunk_count" >= 1 AND "series_analysis_artifacts"."review_chunk_count" >= 0 AND "series_analysis_artifacts"."drilldown_chunk_count" >= 0 AND "series_analysis_artifacts"."match_context_chunk_count" >= 0 AND "series_analysis_artifacts"."outlook_summary_chunk_count" >= 0 AND "series_analysis_artifacts"."outlook_reference_chunk_count" >= 0);--> statement-breakpoint
ALTER TABLE "series_analysis_campaign_targets" ADD CONSTRAINT "series_analysis_campaign_targets_validation_schema_check" CHECK (("series_analysis_campaign_targets"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v2-full-validation-v1' OR "series_analysis_campaign_targets"."artifact_schema_version" = 2)
      AND ("series_analysis_campaign_targets"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v3-full-validation-v1' OR "series_analysis_campaign_targets"."artifact_schema_version" = 3)
      AND ("series_analysis_campaign_targets"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v4-full-validation-v1' OR "series_analysis_campaign_targets"."artifact_schema_version" = 4)
      AND ("series_analysis_campaign_targets"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v5-full-validation-v1' OR "series_analysis_campaign_targets"."artifact_schema_version" = 5)
      AND ("series_analysis_campaign_targets"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v6-full-validation-v1' OR "series_analysis_campaign_targets"."artifact_schema_version" = 6));--> statement-breakpoint
ALTER TABLE "series_analysis_campaigns" ADD CONSTRAINT "series_analysis_campaigns_validation_schema_check" CHECK (("series_analysis_campaigns"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v2-full-validation-v1' OR "series_analysis_campaigns"."artifact_schema_version" = 2)
      AND ("series_analysis_campaigns"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v3-full-validation-v1' OR "series_analysis_campaigns"."artifact_schema_version" = 3)
      AND ("series_analysis_campaigns"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v4-full-validation-v1' OR "series_analysis_campaigns"."artifact_schema_version" = 4)
      AND ("series_analysis_campaigns"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v5-full-validation-v1' OR "series_analysis_campaigns"."artifact_schema_version" = 5)
      AND ("series_analysis_campaigns"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v6-full-validation-v1' OR "series_analysis_campaigns"."artifact_schema_version" = 6));--> statement-breakpoint
ALTER TABLE "series_analysis_job_attempts" ADD CONSTRAINT "series_analysis_job_attempts_validation_schema_check" CHECK (("series_analysis_job_attempts"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v2-full-validation-v1' OR "series_analysis_job_attempts"."artifact_schema_version" = 2)
      AND ("series_analysis_job_attempts"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v3-full-validation-v1' OR "series_analysis_job_attempts"."artifact_schema_version" = 3)
      AND ("series_analysis_job_attempts"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v4-full-validation-v1' OR "series_analysis_job_attempts"."artifact_schema_version" = 4)
      AND ("series_analysis_job_attempts"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v5-full-validation-v1' OR "series_analysis_job_attempts"."artifact_schema_version" = 5)
      AND ("series_analysis_job_attempts"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v6-full-validation-v1' OR "series_analysis_job_attempts"."artifact_schema_version" = 6));--> statement-breakpoint
ALTER TABLE "series_analysis_job_requests" ADD CONSTRAINT "series_analysis_job_requests_validation_schema_check" CHECK (("series_analysis_job_requests"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v2-full-validation-v1' OR "series_analysis_job_requests"."artifact_schema_version" = 2)
      AND ("series_analysis_job_requests"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v3-full-validation-v1' OR "series_analysis_job_requests"."artifact_schema_version" = 3)
      AND ("series_analysis_job_requests"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v4-full-validation-v1' OR "series_analysis_job_requests"."artifact_schema_version" = 4)
      AND ("series_analysis_job_requests"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v5-full-validation-v1' OR "series_analysis_job_requests"."artifact_schema_version" = 5)
      AND ("series_analysis_job_requests"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v6-full-validation-v1' OR "series_analysis_job_requests"."artifact_schema_version" = 6));--> statement-breakpoint
ALTER TABLE "series_analysis_jobs" ADD CONSTRAINT "series_analysis_jobs_validation_schema_check" CHECK (("series_analysis_jobs"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v2-full-validation-v1' OR "series_analysis_jobs"."artifact_schema_version" = 2)
      AND ("series_analysis_jobs"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v3-full-validation-v1' OR "series_analysis_jobs"."artifact_schema_version" = 3)
      AND ("series_analysis_jobs"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v4-full-validation-v1' OR "series_analysis_jobs"."artifact_schema_version" = 4)
      AND ("series_analysis_jobs"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v5-full-validation-v1' OR "series_analysis_jobs"."artifact_schema_version" = 5)
      AND ("series_analysis_jobs"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v6-full-validation-v1' OR "series_analysis_jobs"."artifact_schema_version" = 6));--> statement-breakpoint
ALTER TABLE "series_analysis_release_state" ADD CONSTRAINT "series_analysis_release_state_validation_schema_check" CHECK (("series_analysis_release_state"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v2-full-validation-v1' OR "series_analysis_release_state"."artifact_schema_version" = 2)
      AND ("series_analysis_release_state"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v3-full-validation-v1' OR "series_analysis_release_state"."artifact_schema_version" = 3)
      AND ("series_analysis_release_state"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v4-full-validation-v1' OR "series_analysis_release_state"."artifact_schema_version" = 4)
      AND ("series_analysis_release_state"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v5-full-validation-v1' OR "series_analysis_release_state"."artifact_schema_version" = 5)
      AND ("series_analysis_release_state"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v6-full-validation-v1' OR "series_analysis_release_state"."artifact_schema_version" = 6));--> statement-breakpoint
ALTER TABLE "series_analysis_title_states" ADD CONSTRAINT "series_analysis_title_states_validation_schema_check" CHECK (("series_analysis_title_states"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v2-full-validation-v1' OR "series_analysis_title_states"."artifact_schema_version" = 2)
      AND ("series_analysis_title_states"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v3-full-validation-v1' OR "series_analysis_title_states"."artifact_schema_version" = 3)
      AND ("series_analysis_title_states"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v4-full-validation-v1' OR "series_analysis_title_states"."artifact_schema_version" = 4)
      AND ("series_analysis_title_states"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v5-full-validation-v1' OR "series_analysis_title_states"."artifact_schema_version" = 5)
      AND ("series_analysis_title_states"."validation_contract_id" IS DISTINCT FROM 'series-analysis-artifact-v6-full-validation-v1' OR "series_analysis_title_states"."artifact_schema_version" = 6));