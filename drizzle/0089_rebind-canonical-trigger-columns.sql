-- PostgreSQL's UPDATE OF dependency followed the old columns through their
-- legacy rename. Rebind it to the promoted UUID columns before those redundant
-- legacy pointer columns are removed. The guard remains installed in this
-- transaction; writers stay stopped throughout the full cutover.
LOCK TABLE public.series_analysis_title_states IN ACCESS EXCLUSIVE MODE NOWAIT;
--> statement-breakpoint
DROP TRIGGER series_analysis_title_states_artifact_pointer_guard
  ON public.series_analysis_title_states;
--> statement-breakpoint
CREATE TRIGGER series_analysis_title_states_artifact_pointer_guard
BEFORE UPDATE OF current_artifact_id, previous_artifact_id
ON public.series_analysis_title_states
FOR EACH ROW EXECUTE FUNCTION public.validate_series_analysis_artifact_pointers();
