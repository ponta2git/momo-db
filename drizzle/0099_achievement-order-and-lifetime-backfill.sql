-- Initialize a stable, editable order without changing any achievement identity or claim.
WITH ordered AS (
  SELECT i.id, row_number() OVER (
    PARTITION BY i.game_title_id
    ORDER BY (i.retired_at IS NOT NULL), (i.scope_kind = 'common'),
      COALESCE((SELECT string_agg(m.name, '・' ORDER BY m.name, m.id)
        FROM public.achievement_item_maps im JOIN public.map_masters m ON m.id = im.map_master_id
        WHERE im.item_id = i.id), ''),
      CASE i.rule_kind WHEN 'total_assets' THEN 0 WHEN 'destination' THEN 1
        WHEN 'suri_no_ginji' THEN 2 WHEN 'event_average_rank' THEN 3 ELSE 4 END,
      i.threshold NULLS LAST, i.name, i.id
  ) - 1 AS position
  FROM public.achievement_items i
)
UPDATE public.achievement_items i SET sort_order = ordered.position::integer
FROM ordered WHERE i.id = ordered.id;
--> statement-breakpoint
-- A lifetime expansion must leave a durable recomputation request for each affected title.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.achievement_items i
    LEFT JOIN public.series_analysis_title_states s ON s.game_title_id = i.game_title_id
    WHERE i.retired_at IS NULL AND i.applies_from IS NOT NULL AND s.game_title_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Achievement lifetime expansion requires the title analysis state';
  END IF;
END;
$$;
--> statement-breakpoint
WITH changed AS (
  UPDATE public.achievement_items SET applies_from = NULL, version = version + 1, updated_at = now()
  WHERE retired_at IS NULL AND applies_from IS NOT NULL
  RETURNING game_title_id
), revised AS (
  UPDATE public.series_analysis_title_states s
  SET input_revision = input_revision + 1, pending_work = true, updated_at = now()
  WHERE game_title_id IN (SELECT game_title_id FROM changed)
  RETURNING s.*
), requests AS (
  SELECT gen_random_uuid() AS request_id, s.*, t.legacy_id AS title_legacy_id
  FROM revised s JOIN public.game_titles t ON t.id = s.game_title_id
)
INSERT INTO public.series_analysis_job_requests (
  id, legacy_id, game_title_id, legacy_game_title_id, input_revision, algorithm_version,
  artifact_schema_version, validation_contract_id, trigger, force_run, status
)
SELECT request_id, 'achievement-lifetime-' || request_id::text, game_title_id, title_legacy_id,
  input_revision, algorithm_version, artifact_schema_version, validation_contract_id,
  'achievement_mutation', false, 'pending'
FROM requests;
