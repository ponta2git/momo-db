-- Preserve the existing staging/seal/publication and pointer rules for both
-- attested formats. Payload semantics remain owned by the application validator.
CREATE OR REPLACE FUNCTION "public"."validate_series_analysis_artifact_pointers"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  candidate "public"."series_analysis_artifacts"%ROWTYPE;
  expected_validation_contract text := CASE NEW."artifact_schema_version"
    WHEN 2 THEN 'series-analysis-artifact-v2-full-validation-v1'
    WHEN 3 THEN 'series-analysis-artifact-v3-full-validation-v1'
    ELSE NULL
  END;
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
           expected_validation_contract IS NULL
           OR NEW."validation_contract_id" IS DISTINCT FROM expected_validation_contract
           OR NEW."artifact_schema_version" NOT IN (2, 3)
           OR candidate."artifact_schema_version" <> NEW."artifact_schema_version"
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
           expected_validation_contract IS NULL
           OR NEW."validation_contract_id" IS DISTINCT FROM expected_validation_contract
           OR NEW."artifact_schema_version" NOT IN (2, 3)
           OR candidate."artifact_schema_version" <> NEW."artifact_schema_version"
           OR candidate."validation_contract_id" IS DISTINCT FROM expected_validation_contract
         )
       ) THEN
      RAISE EXCEPTION 'previous series analysis artifact is not an attested publication';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."guard_series_analysis_artifact_publication"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  expected_validation_contract text := CASE NEW."artifact_schema_version"
    WHEN 2 THEN 'series-analysis-artifact-v2-full-validation-v1'
    WHEN 3 THEN 'series-analysis-artifact-v3-full-validation-v1'
    ELSE NULL
  END;
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
          expected_validation_contract IS NULL
          OR NEW."validation_contract_id" IS DISTINCT FROM expected_validation_contract
          OR NEW."artifact_schema_version" NOT IN (2, 3)
          OR NEW."status" <> 'staging'
          OR NEW."published_at" IS NOT NULL
          OR (to_jsonb(NEW) - 'validation_contract_id')
             IS DISTINCT FROM (to_jsonb(OLD) - 'validation_contract_id')
        ) THEN
    RAISE EXCEPTION 'series analysis artifact attestation must be an exact seal-only transition';
  ELSIF OLD."status" = 'staging'
        AND OLD."validation_contract_id" IS NOT NULL
        AND (
          expected_validation_contract IS NULL
          OR OLD."validation_contract_id" IS DISTINCT FROM expected_validation_contract
          OR OLD."artifact_schema_version" NOT IN (2, 3)
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
          NEW."artifact_schema_version" = 3
          OR NEW."published_at" IS NULL
          OR (to_jsonb(NEW) - 'status' - 'published_at')
             IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'published_at')
        ) THEN
    RAISE EXCEPTION 'legacy series analysis artifact publication must be a status-only transition';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
