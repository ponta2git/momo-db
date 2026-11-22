-- Match-context COPY writes many rows under the same artifact. Lock each parent once,
-- including unattested staging parents, to serialize these writes with sealing.
CREATE FUNCTION public.guard_series_analysis_child_inserts() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_parent_id text;
  parent_is_protected boolean;
  found_protected boolean := false;
BEGIN
  FOR target_parent_id IN
    SELECT DISTINCT chunk.artifact_id FROM inserted_chunks AS chunk ORDER BY chunk.artifact_id
  LOOP
    SELECT parent.status = 'published' OR parent.validation_contract_id IS NOT NULL
    INTO parent_is_protected
    FROM public.series_analysis_artifacts AS parent
    WHERE parent.id = target_parent_id
    FOR SHARE;
    IF parent_is_protected THEN
      found_protected := true;
    END IF;
  END LOOP;
  IF found_protected THEN
    RAISE EXCEPTION 'attested series analysis artifact payloads are immutable';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER series_analysis_context_published_guard
BEFORE UPDATE OR DELETE ON public.series_analysis_match_context_artifacts
FOR EACH ROW EXECUTE FUNCTION public.prevent_published_series_analysis_child_mutation();
--> statement-breakpoint
CREATE TRIGGER series_analysis_context_insert_guard
AFTER INSERT ON public.series_analysis_match_context_artifacts
REFERENCING NEW TABLE AS inserted_chunks
FOR EACH STATEMENT EXECUTE FUNCTION public.guard_series_analysis_child_inserts();
