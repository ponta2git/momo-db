-- Header rows and their frozen payloads stay byte-for-byte unchanged.
LOCK TABLE public.game_titles, public.series_analysis_artifacts,
  public.series_radar_bases, public.series_analysis_artifact_identities,
  public.series_radar_basis_identities IN ACCESS EXCLUSIVE MODE NOWAIT;
--> statement-breakpoint
DO $anchors$ BEGIN
  IF EXISTS (SELECT 1 FROM public.series_analysis_artifact_identities)
     OR EXISTS (SELECT 1 FROM public.series_radar_basis_identities) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'CANONICAL_ANCHOR_ALREADY_USED';
  END IF;
END $anchors$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION pg_temp.momo_canonical_identity(entity_name text, legacy_id text)
RETURNS uuid LANGUAGE plpgsql IMMUTABLE STRICT
SET search_path = pg_catalog
AS $mapping$
DECLARE
  value bytea;
BEGIN
  IF entity_name <> ALL (ARRAY['members', 'member_aliases', 'momo_login_accounts', 'sessions', 'responses', 'held_events', 'game_titles', 'map_masters', 'season_masters', 'incident_masters', 'matches', 'match_drafts', 'source_images', 'ocr_jobs', 'ocr_drafts', 'ocr_submissions', 'series_analysis_operation_requests', 'series_analysis_campaigns', 'series_analysis_job_requests', 'series_analysis_jobs', 'series_analysis_job_attempts', 'series_analysis_artifacts', 'series_radar_bases', 'series_radar_candidates', 'series_radar_operations', 'series_radar_previews']) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'CANONICAL_ID_UNKNOWN_ENTITY';
  END IF;
  IF pg_input_is_valid(legacy_id, 'uuid') THEN
    RETURN legacy_id::uuid;
  END IF;
  value := substr(sha256(
    decode('deabc659a5ca4dc09711eae0614fa478', 'hex')
    || convert_to(entity_name, 'UTF8') || decode('00', 'hex')
    || convert_to(legacy_id, 'UTF8')
  ), 1, 16);
  value := set_byte(value, 6, (get_byte(value, 6) & 15) | 128);
  value := set_byte(value, 8, (get_byte(value, 8) & 63) | 128);
  RETURN encode(value, 'hex')::uuid;
END;
$mapping$;

--> statement-breakpoint
INSERT INTO public.series_analysis_artifact_identities(id, legacy_id, game_title_id, legacy_game_title_id)
SELECT pg_temp.momo_canonical_identity('series_analysis_artifacts', source.id), source.id, title.id, source.game_title_id
FROM public.series_analysis_artifacts source
JOIN public.game_titles title ON title.legacy_id = source.game_title_id;
--> statement-breakpoint
INSERT INTO public.series_radar_basis_identities(id, legacy_id, game_title_id, legacy_game_title_id)
SELECT pg_temp.momo_canonical_identity('series_radar_bases', source.id), source.id, title.id, source.game_title_id
FROM public.series_radar_bases source
JOIN public.game_titles title ON title.legacy_id = source.game_title_id;
--> statement-breakpoint
DO $anchors$ BEGIN
  IF (SELECT count(*) FROM public.series_analysis_artifacts)
       <> (SELECT count(*) FROM public.series_analysis_artifact_identities)
     OR (SELECT count(*) FROM public.series_radar_bases)
       <> (SELECT count(*) FROM public.series_radar_basis_identities) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'CANONICAL_ANCHOR_SOURCE_MISMATCH';
  END IF;
END $anchors$;
