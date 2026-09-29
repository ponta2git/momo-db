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
           OR NEW."artifact_schema_version" NOT IN (2, 3, 4, 5)
           OR candidate."artifact_schema_version" <> NEW."artifact_schema_version"
           OR candidate."validation_contract_id" IS DISTINCT FROM expected_validation_contract
         )
       ) THEN
      RAISE EXCEPTION 'current series analysis artifact is not an attested published desired-version artifact';
    END IF;
  END IF;

  IF NEW."current_artifact_id" IS NOT NULL AND NEW."artifact_schema_version" = 5 THEN
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
           OR NEW."artifact_schema_version" NOT IN (2, 3, 4, 5)
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
          OR NEW."artifact_schema_version" NOT IN (2, 3, 4, 5)
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
          OR OLD."artifact_schema_version" NOT IN (2, 3, 4, 5)
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
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- All ordinary job producers inherit the desired criteria under the existing title lock.
-- Preparation jobs retain their separate operation identity and cannot satisfy ordinary requests.
CREATE FUNCTION public.bind_series_analysis_radar_job() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.status = 'queued' AND NEW.work_kind = 'analysis' THEN
    SELECT desired_basis_id, generation INTO NEW.radar_basis_id, NEW.radar_generation
      FROM public.series_radar_title_states WHERE game_title_id = NEW.game_title_id;
    NEW.radar_generation := COALESCE(NEW.radar_generation, 0);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER series_analysis_jobs_radar_binding
BEFORE INSERT OR UPDATE ON public.series_analysis_jobs
FOR EACH ROW EXECUTE FUNCTION public.bind_series_analysis_radar_job();
--> statement-breakpoint
CREATE FUNCTION public.guard_series_radar_basis() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (to_jsonb(NEW) - 'source_snapshot') IS DISTINCT FROM (to_jsonb(OLD) - 'source_snapshot')
     OR (NEW.source_snapshot IS DISTINCT FROM OLD.source_snapshot AND NEW.source_snapshot IS NOT NULL) THEN
    RAISE EXCEPTION 'radar basis and source are immutable';
  END IF;
  IF NEW.source_snapshot IS NULL AND OLD.source_snapshot IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.series_radar_title_states s WHERE OLD.id IN (s.current_basis_id,s.previous_basis_id,s.desired_basis_id))
    OR EXISTS (SELECT 1 FROM public.series_analysis_artifacts a WHERE a.radar_basis_id = OLD.id)
    OR EXISTS (SELECT 1 FROM public.series_radar_candidates c WHERE c.basis_id = OLD.id AND c.status IN ('pending','ready','unavailable','failed'))
    OR EXISTS (SELECT 1 FROM public.series_radar_operations o WHERE o.basis_id = OLD.id AND o.status IN ('pending','running'))
  ) THEN
    RAISE EXCEPTION 'referenced radar source snapshot is protected';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER series_radar_bases_immutable
BEFORE UPDATE ON public.series_radar_bases FOR EACH ROW
EXECUTE FUNCTION public.guard_series_radar_basis();
