CREATE TABLE "series_analysis_title_states" (
	"game_title_id" text PRIMARY KEY NOT NULL,
	"input_revision" bigint DEFAULT 0 NOT NULL,
	"algorithm_version" text DEFAULT 'series-analysis-v1' NOT NULL,
	"artifact_schema_version" integer DEFAULT 1 NOT NULL,
	"pending_work" boolean DEFAULT false NOT NULL,
	"pending_forced_run_count" integer DEFAULT 0 NOT NULL,
	"last_failure_code" text,
	"last_failure_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "series_analysis_title_states_input_revision_check" CHECK ("series_analysis_title_states"."input_revision" >= 0),
	CONSTRAINT "series_analysis_title_states_schema_version_check" CHECK ("series_analysis_title_states"."artifact_schema_version" >= 1),
	CONSTRAINT "series_analysis_title_states_pending_forced_run_count_check" CHECK ("series_analysis_title_states"."pending_forced_run_count" >= 0),
	CONSTRAINT "series_analysis_title_states_failure_pair_check" CHECK (("series_analysis_title_states"."last_failure_code" IS NULL) = ("series_analysis_title_states"."last_failure_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "analysis_revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "series_analysis_title_states" ADD CONSTRAINT "series_analysis_title_states_game_title_id_game_titles_id_fk" FOREIGN KEY ("game_title_id") REFERENCES "public"."game_titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "series_analysis_title_states" ("game_title_id")
SELECT "id" FROM "game_titles"
ON CONFLICT ("game_title_id") DO NOTHING;--> statement-breakpoint
CREATE FUNCTION "public"."ensure_series_analysis_title_state"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO "public"."series_analysis_title_states" ("game_title_id")
  VALUES (NEW."id")
  ON CONFLICT ("game_title_id") DO NOTHING;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "game_titles_series_analysis_state_insert"
AFTER INSERT ON "public"."game_titles"
FOR EACH ROW EXECUTE FUNCTION "public"."ensure_series_analysis_title_state"();--> statement-breakpoint
CREATE INDEX "series_analysis_title_states_pending_work_idx" ON "series_analysis_title_states" USING btree ("updated_at") WHERE "series_analysis_title_states"."pending_work" = true;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_analysis_revision_check" CHECK ("matches"."analysis_revision" >= 0);
