-- Apply the existing sealed/published resource ownership guard to the title resource.
CREATE TRIGGER series_analysis_achievement_published_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.series_analysis_achievement_artifacts
FOR EACH ROW EXECUTE FUNCTION public.prevent_published_series_analysis_child_mutation();
--> statement-breakpoint
CREATE FUNCTION public.prevent_achievement_retirement_history_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Achievement retirement history is immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER achievement_retired_snapshots_immutable
BEFORE UPDATE OR DELETE ON public.achievement_retired_snapshots
FOR EACH ROW EXECUTE FUNCTION public.prevent_achievement_retirement_history_mutation();
--> statement-breakpoint
CREATE TRIGGER achievement_retired_manual_sources_immutable
BEFORE UPDATE OR DELETE ON public.achievement_retired_manual_sources
FOR EACH ROW EXECUTE FUNCTION public.prevent_achievement_retirement_history_mutation();
