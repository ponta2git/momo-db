-- Repeat the canonical lock sequence so this custom migration is safe even when
-- it is the only pending migration. In the normal path these locks are already
-- held by 0032 for the transaction that also applies 0033.
SELECT pg_advisory_xact_lock(hashtext('momo-series-analysis-release'));--> statement-breakpoint
LOCK TABLE "public"."game_titles" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
LOCK TABLE "public"."series_analysis_title_states" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
DO $$
DECLARE
  missing_state_count bigint;
  desired_tuple_count bigint;
BEGIN
  SELECT COUNT(*) INTO missing_state_count
  FROM "public"."game_titles" title
  LEFT JOIN "public"."series_analysis_title_states" state
    ON state."game_title_id" = title."id"
  WHERE state."game_title_id" IS NULL;

  IF missing_state_count <> 0 THEN
    RAISE EXCEPTION 'cannot initialize series analysis release state: registered titles are missing desired state';
  END IF;

  SELECT COUNT(*) INTO desired_tuple_count
  FROM (
    SELECT "algorithm_version", "artifact_schema_version", "validation_contract_id"
    FROM "public"."series_analysis_title_states"
    GROUP BY "algorithm_version", "artifact_schema_version", "validation_contract_id"
  ) desired_tuples;

  IF desired_tuple_count > 1 THEN
    RAISE EXCEPTION 'cannot initialize series analysis release state: desired tuples are heterogeneous';
  ELSIF desired_tuple_count = 0 THEN
    INSERT INTO "public"."series_analysis_release_state" ("singleton_key")
    VALUES ('current');
  ELSE
    INSERT INTO "public"."series_analysis_release_state" (
      "singleton_key", "algorithm_version", "artifact_schema_version", "validation_contract_id"
    )
    SELECT 'current', "algorithm_version", "artifact_schema_version", "validation_contract_id"
    FROM "public"."series_analysis_title_states"
    GROUP BY "algorithm_version", "artifact_schema_version", "validation_contract_id";
  END IF;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."ensure_series_analysis_title_state"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  active_algorithm_version text;
  active_artifact_schema_version integer;
  active_validation_contract_id text;
BEGIN
  SELECT "algorithm_version", "artifact_schema_version", "validation_contract_id"
  INTO active_algorithm_version, active_artifact_schema_version, active_validation_contract_id
  FROM "public"."series_analysis_release_state"
  WHERE "singleton_key" = 'current'
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'series analysis release state is missing';
  END IF;

  INSERT INTO "public"."series_analysis_title_states" (
    "game_title_id", "algorithm_version", "artifact_schema_version", "validation_contract_id"
  ) VALUES (
    NEW."id", active_algorithm_version, active_artifact_schema_version,
    active_validation_contract_id
  )
  ON CONFLICT ("game_title_id") DO NOTHING;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "public"."clear_series_analysis_lease_validation_contract"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD."status" = 'running'
     AND NEW."status" <> 'running'
     AND NEW."lease_owner" IS NULL
     AND NEW."lease_attempt_id" IS NULL
     AND NEW."lease_fencing_token" IS NULL
     AND NEW."lease_expires_at" IS NULL THEN
    NEW."lease_validation_contract_id" := NULL;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "series_analysis_jobs_lease_validation_cleanup"
BEFORE UPDATE ON "public"."series_analysis_jobs"
FOR EACH ROW EXECUTE FUNCTION "public"."clear_series_analysis_lease_validation_contract"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."validate_series_analysis_artifact_pointers"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  candidate "public"."series_analysis_artifacts"%ROWTYPE;
  expected_validation_contract constant text := 'series-analysis-artifact-v2-full-validation-v1';
  expected_artifact_schema constant integer := 2;
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
           NEW."validation_contract_id" <> expected_validation_contract
           OR NEW."artifact_schema_version" <> expected_artifact_schema
           OR candidate."artifact_schema_version" <> expected_artifact_schema
           OR candidate."validation_contract_id" IS DISTINCT FROM expected_validation_contract
         )
       ) THEN
      RAISE EXCEPTION 'current series analysis artifact is not an attested published desired-version artifact';
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
           NEW."validation_contract_id" <> expected_validation_contract
           OR NEW."artifact_schema_version" <> expected_artifact_schema
           OR candidate."artifact_schema_version" <> expected_artifact_schema
           OR candidate."validation_contract_id" IS DISTINCT FROM expected_validation_contract
         )
       ) THEN
      RAISE EXCEPTION 'previous series analysis artifact is not an attested publication';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "series_analysis_artifacts_unpublish_guard" ON "public"."series_analysis_artifacts";--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."prevent_series_analysis_artifact_unpublish"();--> statement-breakpoint
CREATE FUNCTION "public"."guard_series_analysis_artifact_publication"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  expected_validation_contract constant text := 'series-analysis-artifact-v2-full-validation-v1';
  expected_artifact_schema constant integer := 2;
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
          NEW."validation_contract_id" IS DISTINCT FROM expected_validation_contract
          OR NEW."artifact_schema_version" <> expected_artifact_schema
          OR NEW."status" <> 'staging'
          OR NEW."published_at" IS NOT NULL
          OR (to_jsonb(NEW) - 'validation_contract_id')
             IS DISTINCT FROM (to_jsonb(OLD) - 'validation_contract_id')
        ) THEN
    RAISE EXCEPTION 'series analysis artifact attestation must be an exact seal-only transition';
  ELSIF OLD."status" = 'staging'
        AND OLD."validation_contract_id" IS NOT NULL
        AND (
          OLD."validation_contract_id" IS DISTINCT FROM expected_validation_contract
          OR OLD."artifact_schema_version" <> expected_artifact_schema
        ) THEN
    RAISE EXCEPTION 'unsupported attested staging series analysis artifact';
  ELSIF OLD."status" = 'staging'
        AND OLD."validation_contract_id" IS NOT NULL
        AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)
        AND NOT (
          (
            NEW."status" = 'published'
            AND NEW."published_at" IS NOT NULL
            AND (to_jsonb(NEW) - 'status' - 'published_at')
                IS NOT DISTINCT FROM (to_jsonb(OLD) - 'status' - 'published_at')
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
          NEW."published_at" IS NULL
          OR (to_jsonb(NEW) - 'status' - 'published_at')
             IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'published_at')
        ) THEN
    RAISE EXCEPTION 'legacy series analysis artifact publication must be a status-only transition';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "series_analysis_artifacts_publication_guard"
BEFORE INSERT OR UPDATE ON "public"."series_analysis_artifacts"
FOR EACH ROW EXECUTE FUNCTION "public"."guard_series_analysis_artifact_publication"();--> statement-breakpoint
CREATE FUNCTION "public"."prevent_published_series_analysis_child_mutation"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  parent_is_protected boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "status" = 'published' OR "validation_contract_id" IS NOT NULL
    INTO parent_is_protected
    FROM "public"."series_analysis_artifacts"
    WHERE "id" = NEW."artifact_id"
    FOR SHARE;
    IF parent_is_protected THEN
      RAISE EXCEPTION 'attested series analysis artifact payloads are immutable';
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT "status" = 'published' OR "validation_contract_id" IS NOT NULL
    INTO parent_is_protected
    FROM "public"."series_analysis_artifacts"
    WHERE "id" = OLD."artifact_id"
    FOR SHARE;
    IF parent_is_protected THEN
      RAISE EXCEPTION 'attested series analysis artifact payloads are immutable';
    END IF;
  ELSE
    FOR parent_is_protected IN
      SELECT "status" = 'published' OR "validation_contract_id" IS NOT NULL
      FROM "public"."series_analysis_artifacts"
      WHERE "id" IN (OLD."artifact_id", NEW."artifact_id")
      ORDER BY "id"
      FOR SHARE
    LOOP
      IF parent_is_protected THEN
        RAISE EXCEPTION 'attested series analysis artifact payloads are immutable';
      END IF;
    END LOOP;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "series_analysis_aggregate_published_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "public"."series_analysis_scope_aggregate_artifacts"
FOR EACH ROW EXECUTE FUNCTION "public"."prevent_published_series_analysis_child_mutation"();--> statement-breakpoint
CREATE TRIGGER "series_analysis_review_published_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "public"."series_analysis_scope_review_artifacts"
FOR EACH ROW EXECUTE FUNCTION "public"."prevent_published_series_analysis_child_mutation"();--> statement-breakpoint
CREATE TRIGGER "series_analysis_drilldown_published_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "public"."series_analysis_drilldown_artifacts"
FOR EACH ROW EXECUTE FUNCTION "public"."prevent_published_series_analysis_child_mutation"();--> statement-breakpoint
CREATE TRIGGER "series_analysis_context_published_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "public"."series_analysis_match_context_artifacts"
FOR EACH ROW EXECUTE FUNCTION "public"."prevent_published_series_analysis_child_mutation"();
