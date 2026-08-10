CREATE TABLE "series_analysis_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"game_title_id" text NOT NULL,
	"attempt_id" text,
	"input_revision" bigint NOT NULL,
	"algorithm_version" text NOT NULL,
	"artifact_schema_version" integer NOT NULL,
	"source_input_checksum" text NOT NULL,
	"root_checksum" text NOT NULL,
	"status" text DEFAULT 'staging' NOT NULL,
	"aggregate_chunk_count" integer NOT NULL,
	"review_chunk_count" integer NOT NULL,
	"drilldown_chunk_count" integer NOT NULL,
	"match_context_chunk_count" integer NOT NULL,
	"encoded_bytes" bigint NOT NULL,
	"decoded_bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "series_analysis_artifacts_input_revision_check" CHECK ("series_analysis_artifacts"."input_revision" >= 0),
	CONSTRAINT "series_analysis_artifacts_schema_version_check" CHECK ("series_analysis_artifacts"."artifact_schema_version" >= 1),
	CONSTRAINT "series_analysis_artifacts_status_check" CHECK ("series_analysis_artifacts"."status" IN ('staging','published')),
	CONSTRAINT "series_analysis_artifacts_checksum_check" CHECK ("series_analysis_artifacts"."source_input_checksum" ~ '^sha256:[0-9a-f]{64}$' AND "series_analysis_artifacts"."root_checksum" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "series_analysis_artifacts_chunk_counts_check" CHECK ("series_analysis_artifacts"."aggregate_chunk_count" >= 1 AND "series_analysis_artifacts"."review_chunk_count" >= 0 AND "series_analysis_artifacts"."drilldown_chunk_count" >= 0 AND "series_analysis_artifacts"."match_context_chunk_count" >= 0),
	CONSTRAINT "series_analysis_artifacts_bytes_check" CHECK ("series_analysis_artifacts"."encoded_bytes" >= 0 AND "series_analysis_artifacts"."decoded_bytes" >= "series_analysis_artifacts"."encoded_bytes"),
	CONSTRAINT "series_analysis_artifacts_publication_shape_check" CHECK (("series_analysis_artifacts"."status" = 'published') = ("series_analysis_artifacts"."published_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "series_analysis_drilldown_artifacts" (
	"artifact_id" text NOT NULL,
	"scope_key" text NOT NULL,
	"scope_kind" text NOT NULL,
	"season_master_id" text,
	"map_master_id" text,
	"member_id" text NOT NULL,
	"metric_id" text NOT NULL,
	"payload" "bytea" NOT NULL,
	"encoded_bytes" integer NOT NULL,
	"decoded_bytes" integer NOT NULL,
	"item_count" integer NOT NULL,
	"nesting_depth" integer NOT NULL,
	"checksum" text NOT NULL,
	CONSTRAINT "series_analysis_drilldown_artifacts_artifact_id_scope_key_member_id_metric_id_pk" PRIMARY KEY("artifact_id","scope_key","member_id","metric_id"),
	CONSTRAINT "series_analysis_drilldown_artifacts_scope_check" CHECK (("series_analysis_drilldown_artifacts"."scope_kind" = 'overall' AND "series_analysis_drilldown_artifacts"."season_master_id" IS NULL AND "series_analysis_drilldown_artifacts"."map_master_id" IS NULL AND "series_analysis_drilldown_artifacts"."scope_key" = 'overall') OR ("series_analysis_drilldown_artifacts"."scope_kind" = 'season' AND "series_analysis_drilldown_artifacts"."season_master_id" IS NOT NULL AND "series_analysis_drilldown_artifacts"."map_master_id" IS NULL AND "series_analysis_drilldown_artifacts"."scope_key" = 'season:' || "series_analysis_drilldown_artifacts"."season_master_id") OR ("series_analysis_drilldown_artifacts"."scope_kind" = 'map' AND "series_analysis_drilldown_artifacts"."season_master_id" IS NULL AND "series_analysis_drilldown_artifacts"."map_master_id" IS NOT NULL AND "series_analysis_drilldown_artifacts"."scope_key" = 'map:' || "series_analysis_drilldown_artifacts"."map_master_id") OR ("series_analysis_drilldown_artifacts"."scope_kind" = 'season_map' AND "series_analysis_drilldown_artifacts"."season_master_id" IS NOT NULL AND "series_analysis_drilldown_artifacts"."map_master_id" IS NOT NULL AND "series_analysis_drilldown_artifacts"."scope_key" = 'season_map:' || "series_analysis_drilldown_artifacts"."season_master_id" || ':' || "series_analysis_drilldown_artifacts"."map_master_id")),
	CONSTRAINT "series_analysis_drilldown_artifacts_chunk_check" CHECK ("series_analysis_drilldown_artifacts"."encoded_bytes" >= 2 AND "series_analysis_drilldown_artifacts"."encoded_bytes" = octet_length("series_analysis_drilldown_artifacts"."payload") AND "series_analysis_drilldown_artifacts"."decoded_bytes" >= "series_analysis_drilldown_artifacts"."encoded_bytes" AND "series_analysis_drilldown_artifacts"."item_count" >= 0 AND "series_analysis_drilldown_artifacts"."nesting_depth" BETWEEN 1 AND 64 AND "series_analysis_drilldown_artifacts"."checksum" ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "series_analysis_match_context_artifacts" (
	"artifact_id" text NOT NULL,
	"scope_key" text NOT NULL,
	"scope_kind" text NOT NULL,
	"season_master_id" text,
	"map_master_id" text,
	"match_id" text NOT NULL,
	"source_match_revision" bigint NOT NULL,
	"payload" "bytea" NOT NULL,
	"encoded_bytes" integer NOT NULL,
	"decoded_bytes" integer NOT NULL,
	"item_count" integer NOT NULL,
	"nesting_depth" integer NOT NULL,
	"checksum" text NOT NULL,
	CONSTRAINT "series_analysis_match_context_artifacts_artifact_id_scope_key_match_id_pk" PRIMARY KEY("artifact_id","scope_key","match_id"),
	CONSTRAINT "series_analysis_match_context_artifacts_scope_check" CHECK (("series_analysis_match_context_artifacts"."scope_kind" = 'overall' AND "series_analysis_match_context_artifacts"."season_master_id" IS NULL AND "series_analysis_match_context_artifacts"."map_master_id" IS NULL AND "series_analysis_match_context_artifacts"."scope_key" = 'overall') OR ("series_analysis_match_context_artifacts"."scope_kind" = 'season' AND "series_analysis_match_context_artifacts"."season_master_id" IS NOT NULL AND "series_analysis_match_context_artifacts"."map_master_id" IS NULL AND "series_analysis_match_context_artifacts"."scope_key" = 'season:' || "series_analysis_match_context_artifacts"."season_master_id") OR ("series_analysis_match_context_artifacts"."scope_kind" = 'map' AND "series_analysis_match_context_artifacts"."season_master_id" IS NULL AND "series_analysis_match_context_artifacts"."map_master_id" IS NOT NULL AND "series_analysis_match_context_artifacts"."scope_key" = 'map:' || "series_analysis_match_context_artifacts"."map_master_id") OR ("series_analysis_match_context_artifacts"."scope_kind" = 'season_map' AND "series_analysis_match_context_artifacts"."season_master_id" IS NOT NULL AND "series_analysis_match_context_artifacts"."map_master_id" IS NOT NULL AND "series_analysis_match_context_artifacts"."scope_key" = 'season_map:' || "series_analysis_match_context_artifacts"."season_master_id" || ':' || "series_analysis_match_context_artifacts"."map_master_id")),
	CONSTRAINT "series_analysis_match_context_artifacts_chunk_check" CHECK ("series_analysis_match_context_artifacts"."encoded_bytes" >= 2 AND "series_analysis_match_context_artifacts"."encoded_bytes" = octet_length("series_analysis_match_context_artifacts"."payload") AND "series_analysis_match_context_artifacts"."decoded_bytes" >= "series_analysis_match_context_artifacts"."encoded_bytes" AND "series_analysis_match_context_artifacts"."item_count" >= 0 AND "series_analysis_match_context_artifacts"."nesting_depth" BETWEEN 1 AND 64 AND "series_analysis_match_context_artifacts"."checksum" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "series_analysis_match_context_artifacts_revision_check" CHECK ("series_analysis_match_context_artifacts"."source_match_revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "series_analysis_scope_aggregate_artifacts" (
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
	CONSTRAINT "series_analysis_scope_aggregate_artifacts_artifact_id_scope_key_pk" PRIMARY KEY("artifact_id","scope_key"),
	CONSTRAINT "series_analysis_scope_aggregate_artifacts_scope_check" CHECK (("series_analysis_scope_aggregate_artifacts"."scope_kind" = 'overall' AND "series_analysis_scope_aggregate_artifacts"."season_master_id" IS NULL AND "series_analysis_scope_aggregate_artifacts"."map_master_id" IS NULL AND "series_analysis_scope_aggregate_artifacts"."scope_key" = 'overall') OR ("series_analysis_scope_aggregate_artifacts"."scope_kind" = 'season' AND "series_analysis_scope_aggregate_artifacts"."season_master_id" IS NOT NULL AND "series_analysis_scope_aggregate_artifacts"."map_master_id" IS NULL AND "series_analysis_scope_aggregate_artifacts"."scope_key" = 'season:' || "series_analysis_scope_aggregate_artifacts"."season_master_id") OR ("series_analysis_scope_aggregate_artifacts"."scope_kind" = 'map' AND "series_analysis_scope_aggregate_artifacts"."season_master_id" IS NULL AND "series_analysis_scope_aggregate_artifacts"."map_master_id" IS NOT NULL AND "series_analysis_scope_aggregate_artifacts"."scope_key" = 'map:' || "series_analysis_scope_aggregate_artifacts"."map_master_id") OR ("series_analysis_scope_aggregate_artifacts"."scope_kind" = 'season_map' AND "series_analysis_scope_aggregate_artifacts"."season_master_id" IS NOT NULL AND "series_analysis_scope_aggregate_artifacts"."map_master_id" IS NOT NULL AND "series_analysis_scope_aggregate_artifacts"."scope_key" = 'season_map:' || "series_analysis_scope_aggregate_artifacts"."season_master_id" || ':' || "series_analysis_scope_aggregate_artifacts"."map_master_id")),
	CONSTRAINT "series_analysis_scope_aggregate_artifacts_chunk_check" CHECK ("series_analysis_scope_aggregate_artifacts"."encoded_bytes" >= 2 AND "series_analysis_scope_aggregate_artifacts"."encoded_bytes" = octet_length("series_analysis_scope_aggregate_artifacts"."payload") AND "series_analysis_scope_aggregate_artifacts"."decoded_bytes" >= "series_analysis_scope_aggregate_artifacts"."encoded_bytes" AND "series_analysis_scope_aggregate_artifacts"."item_count" >= 0 AND "series_analysis_scope_aggregate_artifacts"."nesting_depth" BETWEEN 1 AND 64 AND "series_analysis_scope_aggregate_artifacts"."checksum" ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "series_analysis_scope_review_artifacts" (
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
	CONSTRAINT "series_analysis_scope_review_artifacts_artifact_id_scope_key_pk" PRIMARY KEY("artifact_id","scope_key"),
	CONSTRAINT "series_analysis_scope_review_artifacts_scope_check" CHECK (("series_analysis_scope_review_artifacts"."scope_kind" = 'overall' AND "series_analysis_scope_review_artifacts"."season_master_id" IS NULL AND "series_analysis_scope_review_artifacts"."map_master_id" IS NULL AND "series_analysis_scope_review_artifacts"."scope_key" = 'overall') OR ("series_analysis_scope_review_artifacts"."scope_kind" = 'season' AND "series_analysis_scope_review_artifacts"."season_master_id" IS NOT NULL AND "series_analysis_scope_review_artifacts"."map_master_id" IS NULL AND "series_analysis_scope_review_artifacts"."scope_key" = 'season:' || "series_analysis_scope_review_artifacts"."season_master_id") OR ("series_analysis_scope_review_artifacts"."scope_kind" = 'map' AND "series_analysis_scope_review_artifacts"."season_master_id" IS NULL AND "series_analysis_scope_review_artifacts"."map_master_id" IS NOT NULL AND "series_analysis_scope_review_artifacts"."scope_key" = 'map:' || "series_analysis_scope_review_artifacts"."map_master_id") OR ("series_analysis_scope_review_artifacts"."scope_kind" = 'season_map' AND "series_analysis_scope_review_artifacts"."season_master_id" IS NOT NULL AND "series_analysis_scope_review_artifacts"."map_master_id" IS NOT NULL AND "series_analysis_scope_review_artifacts"."scope_key" = 'season_map:' || "series_analysis_scope_review_artifacts"."season_master_id" || ':' || "series_analysis_scope_review_artifacts"."map_master_id")),
	CONSTRAINT "series_analysis_scope_review_artifacts_chunk_check" CHECK ("series_analysis_scope_review_artifacts"."encoded_bytes" >= 2 AND "series_analysis_scope_review_artifacts"."encoded_bytes" = octet_length("series_analysis_scope_review_artifacts"."payload") AND "series_analysis_scope_review_artifacts"."decoded_bytes" >= "series_analysis_scope_review_artifacts"."encoded_bytes" AND "series_analysis_scope_review_artifacts"."item_count" >= 0 AND "series_analysis_scope_review_artifacts"."nesting_depth" BETWEEN 1 AND 64 AND "series_analysis_scope_review_artifacts"."checksum" ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "series_analysis_title_states" ADD COLUMN "current_artifact_id" text;--> statement-breakpoint
ALTER TABLE "series_analysis_title_states" ADD COLUMN "previous_artifact_id" text;--> statement-breakpoint
ALTER TABLE "series_analysis_artifacts" ADD CONSTRAINT "series_analysis_artifacts_game_title_id_game_titles_id_fk" FOREIGN KEY ("game_title_id") REFERENCES "public"."game_titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_analysis_artifacts" ADD CONSTRAINT "series_analysis_artifacts_attempt_id_series_analysis_job_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."series_analysis_job_attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_analysis_drilldown_artifacts" ADD CONSTRAINT "series_analysis_drilldown_artifacts_artifact_id_series_analysis_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."series_analysis_artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_analysis_match_context_artifacts" ADD CONSTRAINT "series_analysis_match_context_artifacts_artifact_id_series_analysis_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."series_analysis_artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_analysis_scope_aggregate_artifacts" ADD CONSTRAINT "series_analysis_scope_aggregate_artifacts_artifact_id_series_analysis_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."series_analysis_artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_analysis_scope_review_artifacts" ADD CONSTRAINT "series_analysis_scope_review_artifacts_artifact_id_series_analysis_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."series_analysis_artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "series_analysis_artifacts_id_title_unique" ON "series_analysis_artifacts" USING btree ("id","game_title_id");--> statement-breakpoint
CREATE INDEX "series_analysis_artifacts_staging_cleanup_idx" ON "series_analysis_artifacts" USING btree ("created_at") WHERE "series_analysis_artifacts"."status" = 'staging';--> statement-breakpoint
CREATE INDEX "series_analysis_artifacts_title_published_idx" ON "series_analysis_artifacts" USING btree ("game_title_id","published_at") WHERE "series_analysis_artifacts"."status" = 'published';--> statement-breakpoint
CREATE INDEX "series_analysis_match_context_artifacts_match_idx" ON "series_analysis_match_context_artifacts" USING btree ("match_id");--> statement-breakpoint
ALTER TABLE "series_analysis_title_states" ADD CONSTRAINT "series_analysis_title_states_current_artifact_fk" FOREIGN KEY ("current_artifact_id","game_title_id") REFERENCES "public"."series_analysis_artifacts"("id","game_title_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_analysis_title_states" ADD CONSTRAINT "series_analysis_title_states_previous_artifact_fk" FOREIGN KEY ("previous_artifact_id","game_title_id") REFERENCES "public"."series_analysis_artifacts"("id","game_title_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_analysis_title_states" ADD CONSTRAINT "series_analysis_title_states_artifact_pointer_distinct_check" CHECK ("series_analysis_title_states"."current_artifact_id" IS NULL OR "series_analysis_title_states"."previous_artifact_id" IS NULL OR "series_analysis_title_states"."current_artifact_id" <> "series_analysis_title_states"."previous_artifact_id");
--> statement-breakpoint
CREATE FUNCTION "public"."validate_series_analysis_artifact_pointers"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  candidate "public"."series_analysis_artifacts"%ROWTYPE;
BEGIN
  IF NEW."current_artifact_id" IS DISTINCT FROM OLD."current_artifact_id"
     AND NEW."current_artifact_id" IS NOT NULL THEN
    SELECT * INTO STRICT candidate
    FROM "public"."series_analysis_artifacts"
    WHERE "id" = NEW."current_artifact_id"
      AND "game_title_id" = NEW."game_title_id";
    IF candidate."status" <> 'published'
       OR candidate."input_revision" <> NEW."input_revision"
       OR candidate."algorithm_version" <> NEW."algorithm_version"
       OR candidate."artifact_schema_version" <> NEW."artifact_schema_version" THEN
      RAISE EXCEPTION 'current series analysis artifact is not a published desired-version artifact';
    END IF;
  END IF;
  IF NEW."previous_artifact_id" IS DISTINCT FROM OLD."previous_artifact_id"
     AND NEW."previous_artifact_id" IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM "public"."series_analysis_artifacts"
       WHERE "id" = NEW."previous_artifact_id"
         AND "game_title_id" = NEW."game_title_id"
         AND "status" = 'published'
     ) THEN
    RAISE EXCEPTION 'previous series analysis artifact is not published';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "series_analysis_title_states_artifact_pointer_guard"
BEFORE UPDATE OF "current_artifact_id", "previous_artifact_id"
ON "public"."series_analysis_title_states"
FOR EACH ROW EXECUTE FUNCTION "public"."validate_series_analysis_artifact_pointers"();
--> statement-breakpoint
CREATE FUNCTION "public"."prevent_series_analysis_artifact_unpublish"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD."status" = 'published' AND NEW."status" <> 'published' THEN
    RAISE EXCEPTION 'published series analysis artifacts are immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "series_analysis_artifacts_unpublish_guard"
BEFORE UPDATE OF "status" ON "public"."series_analysis_artifacts"
FOR EACH ROW EXECUTE FUNCTION "public"."prevent_series_analysis_artifact_unpublish"();
