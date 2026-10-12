-- Recover only recorded successful applications. Historical display names remain unknown.
UPDATE public.series_radar_candidates c SET origin_kind = 'restore'
WHERE EXISTS (SELECT 1 FROM public.series_radar_operations o WHERE o.candidate_id = c.id AND o.kind = 'restore');
--> statement-breakpoint
INSERT INTO public.series_radar_revisions(operation_id,game_title_id,candidate_id,before_basis_id,after_basis_id,change_kind,requested_by,published_at)
SELECT o.id,o.game_title_id,c.id,p.before_basis_id,o.basis_id,c.origin_kind,o.requested_by,o.finished_at
FROM public.series_radar_operations o
JOIN public.series_radar_candidates c ON c.id=o.candidate_id AND c.game_title_id=o.game_title_id
JOIN public.series_radar_previews p ON p.id=o.preview_id AND p.game_title_id=o.game_title_id
WHERE o.kind='apply' AND o.status='succeeded' AND o.basis_id IS NOT NULL AND o.finished_at IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION public.guard_series_radar_candidate_input() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF ROW(NEW.origin_kind,NEW.manual_input,NEW.source_basis_id,NEW.source_candidate_id,NEW.saved_by,NEW.saved_by_display_name)
    IS DISTINCT FROM ROW(OLD.origin_kind,OLD.manual_input,OLD.source_basis_id,OLD.source_candidate_id,OLD.saved_by,OLD.saved_by_display_name) THEN
    RAISE EXCEPTION 'radar candidate input and provenance are immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER series_radar_candidates_input_immutable BEFORE UPDATE ON public.series_radar_candidates
FOR EACH ROW EXECUTE FUNCTION public.guard_series_radar_candidate_input();
--> statement-breakpoint
CREATE FUNCTION public.guard_series_radar_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'radar publication history is immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER series_radar_revisions_immutable BEFORE UPDATE ON public.series_radar_revisions
FOR EACH ROW EXECUTE FUNCTION public.guard_series_radar_revision();
