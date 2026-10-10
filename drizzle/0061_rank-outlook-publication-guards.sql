-- Preserve the existing staging/seal/publication and pointer rules for all supported
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
    WHEN 4 THEN 'series-analysis-artifact-v4-full-validation-v1'
    WHEN 5 THEN 'series-analysis-artifact-v5-full-validation-v1'
    WHEN 6 THEN 'series-analysis-artifact-v6-full-validation-v1'
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
           OR NEW."artifact_schema_version" NOT IN (2, 3, 4, 5, 6)
           OR candidate."artifact_schema_version" <> NEW."artifact_schema_version"
           OR candidate."validation_contract_id" IS DISTINCT FROM expected_validation_contract
         )
       ) THEN
      RAISE EXCEPTION 'current series analysis artifact is not an attested published desired-version artifact';
    END IF;
  END IF;

  IF NEW."current_artifact_id" IS NOT NULL AND NEW."artifact_schema_version" IN (5, 6) THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.series_radar_title_states r
      WHERE r.game_title_id = NEW.game_title_id
        AND r.desired_basis_id IS NOT DISTINCT FROM candidate.radar_basis_id
        AND r.generation = candidate.radar_generation
    ) AND (
      EXISTS (SELECT 1 FROM public.series_radar_title_states r WHERE r.game_title_id = NEW.game_title_id)
      OR candidate.radar_basis_id IS NOT NULL OR candidate.radar_generation <> 0
    ) THEN
      RAISE EXCEPTION 'radar publication does not match the desired basis generation';
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
           OR NEW."artifact_schema_version" NOT IN (2, 3, 4, 5, 6)
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
    WHEN 4 THEN 'series-analysis-artifact-v4-full-validation-v1'
    WHEN 5 THEN 'series-analysis-artifact-v5-full-validation-v1'
    WHEN 6 THEN 'series-analysis-artifact-v6-full-validation-v1'
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
          OR NEW."artifact_schema_version" NOT IN (2, 3, 4, 5, 6)
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
          OR OLD."artifact_schema_version" NOT IN (2, 3, 4, 5, 6)
        ) THEN
    RAISE EXCEPTION 'unsupported attested staging series analysis artifact';
  ELSIF OLD."status" = 'staging'
        AND OLD."validation_contract_id" IS NOT NULL
        AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)
        AND NOT (
          (
            NEW."status" = 'published'
            AND NEW."published_at" IS NOT NULL
            AND (to_jsonb(NEW) - 'status' - 'published_at' - 'radar_applied_at')
                IS NOT DISTINCT FROM (to_jsonb(OLD) - 'status' - 'published_at' - 'radar_applied_at')
            AND (NEW.radar_basis_id IS NULL OR NEW.radar_applied_at IS NOT NULL)
            AND (OLD.radar_applied_at IS NULL OR NEW.radar_applied_at IS NOT DISTINCT FROM OLD.radar_applied_at)
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
          NEW."artifact_schema_version" >= 3
          OR NEW."published_at" IS NULL
          OR (to_jsonb(NEW) - 'status' - 'published_at')
             IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'published_at')
        ) THEN
    RAISE EXCEPTION 'legacy series analysis artifact publication must be a status-only transition';
  END IF;
  IF OLD.status = 'staging' AND OLD.validation_contract_id IS NULL
     AND NEW.validation_contract_id IS NOT NULL AND NEW.artifact_schema_version = 6 THEN
    IF NEW.outlook_summary_chunk_count <> 1 + (
         SELECT count(*) FROM unnest(NEW.scope_keys) AS s(scope_key) WHERE scope_key LIKE 'season:%'
       )
       OR NEW.outlook_reference_chunk_count <> (CASE WHEN 'overall' = ANY(NEW.scope_keys) THEN 4 ELSE 0 END)
       OR (SELECT count(*) FROM public.series_analysis_outlook_summary_artifacts WHERE artifact_id=NEW.id) <> NEW.outlook_summary_chunk_count
       OR (SELECT count(*) FROM public.series_analysis_outlook_reference_artifacts WHERE artifact_id=NEW.id) <> NEW.outlook_reference_chunk_count
       OR NOT EXISTS (SELECT 1 FROM public.series_analysis_outlook_summary_artifacts WHERE artifact_id=NEW.id AND scope_key='overall')
       OR EXISTS (SELECT 1 FROM public.series_analysis_outlook_summary_artifacts WHERE artifact_id=NEW.id AND scope_key<>'overall' AND NOT(scope_key=ANY(NEW.scope_keys))) THEN
      RAISE EXCEPTION 'series analysis outlook resources are incomplete';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER series_analysis_outlook_summary_published_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.series_analysis_outlook_summary_artifacts
FOR EACH ROW EXECUTE FUNCTION public.prevent_published_series_analysis_child_mutation();
--> statement-breakpoint
CREATE TRIGGER series_analysis_outlook_reference_published_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.series_analysis_outlook_reference_artifacts
FOR EACH ROW EXECUTE FUNCTION public.prevent_published_series_analysis_child_mutation();
