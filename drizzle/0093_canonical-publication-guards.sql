-- Only lookup boundaries change. Frozen artifact/basis headers, payloads,
-- seals, checksums and original immutability transitions remain unchanged.
LOCK TABLE public.series_analysis_title_states, public.series_radar_bases
  IN ACCESS EXCLUSIVE MODE NOWAIT;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."validate_series_analysis_artifact_pointers"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  candidate "public"."series_analysis_artifacts"%ROWTYPE;
  candidate_basis_id uuid;

BEGIN
  IF NEW."current_artifact_id" IS NOT NULL THEN
    SELECT artifact.* INTO STRICT candidate
    FROM public.series_analysis_artifacts artifact
    JOIN public.series_analysis_artifact_identities identity
      ON identity.legacy_id = artifact.id
      AND identity.legacy_game_title_id = artifact.game_title_id
    WHERE identity.id = NEW."current_artifact_id"
      AND identity.game_title_id = NEW."game_title_id";

    IF candidate."status" <> 'published'
       OR candidate."input_revision" <> NEW."input_revision"
       OR candidate."algorithm_version" <> NEW."algorithm_version"
       OR candidate."artifact_schema_version" <> NEW."artifact_schema_version"
       OR (
         NEW."validation_contract_id" IS NOT NULL
         AND (
           candidate."artifact_schema_version" <> NEW."artifact_schema_version"
           OR candidate."validation_contract_id" IS DISTINCT FROM NEW."validation_contract_id"
         )
       ) THEN
      RAISE EXCEPTION 'current series analysis artifact is not an attested published desired-version artifact';
    END IF;
  END IF;

  IF NEW."current_artifact_id" IS NOT NULL AND NEW."artifact_schema_version" >= 5 THEN
    SELECT identity.id INTO candidate_basis_id
    FROM public.series_radar_basis_identities identity
    WHERE identity.legacy_id = candidate.radar_basis_id
      AND identity.game_title_id = NEW.game_title_id;
    IF candidate.radar_basis_id IS NOT NULL AND NOT FOUND THEN
      RAISE EXCEPTION 'radar publication basis identity is outside the title scope';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.series_radar_title_states r
      WHERE r.game_title_id = NEW.game_title_id
        AND r.desired_basis_id IS NOT DISTINCT FROM candidate_basis_id
        AND r.generation = candidate.radar_generation
    ) AND (
      EXISTS (SELECT 1 FROM public.series_radar_title_states r WHERE r.game_title_id = NEW.game_title_id)
      OR candidate.radar_basis_id IS NOT NULL OR candidate.radar_generation <> 0
    ) THEN
      RAISE EXCEPTION 'radar publication does not match the desired basis generation';
    END IF;
  END IF;

  IF NEW."previous_artifact_id" IS NOT NULL THEN
    SELECT artifact.* INTO STRICT candidate
    FROM public.series_analysis_artifacts artifact
    JOIN public.series_analysis_artifact_identities identity
      ON identity.legacy_id = artifact.id
      AND identity.legacy_game_title_id = artifact.game_title_id
    WHERE identity.id = NEW."previous_artifact_id"
      AND identity.game_title_id = NEW."game_title_id";

    IF candidate."status" <> 'published'
       OR (
         NEW."validation_contract_id" IS NOT NULL
         AND (
           candidate."artifact_schema_version" <> NEW."artifact_schema_version"
           OR candidate."validation_contract_id" IS DISTINCT FROM NEW."validation_contract_id"
         )
       ) THEN
      RAISE EXCEPTION 'previous series analysis artifact is not an attested publication';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_series_radar_basis() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (to_jsonb(NEW) - 'source_snapshot') IS DISTINCT FROM (to_jsonb(OLD) - 'source_snapshot')
     OR (NEW.source_snapshot IS DISTINCT FROM OLD.source_snapshot AND NEW.source_snapshot IS NOT NULL) THEN
    RAISE EXCEPTION 'radar basis and source are immutable';
  END IF;
  IF NEW.source_snapshot IS NULL AND OLD.source_snapshot IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.series_radar_title_states s
      JOIN public.series_radar_basis_identities identity ON identity.legacy_id = OLD.id
      WHERE identity.id IN (s.current_basis_id,s.previous_basis_id,s.desired_basis_id))
    OR EXISTS (SELECT 1 FROM public.series_analysis_artifacts a WHERE a.radar_basis_id = OLD.id)
    OR EXISTS (SELECT 1 FROM public.series_radar_candidates c
      JOIN public.series_radar_basis_identities identity ON identity.id = c.basis_id
      WHERE identity.legacy_id = OLD.id AND c.status IN ('pending','ready','unavailable','failed'))
    OR EXISTS (SELECT 1 FROM public.series_radar_operations o
      JOIN public.series_radar_basis_identities identity ON identity.id = o.basis_id
      WHERE identity.legacy_id = OLD.id AND o.status IN ('pending','running'))
  ) THEN
    RAISE EXCEPTION 'referenced radar source snapshot is protected';
  END IF;
  RETURN NEW;
END;
$$;
