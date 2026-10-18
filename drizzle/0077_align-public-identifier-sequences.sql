-- RESTART is transactional; a later migration failure must roll back sequence state.
-- Keep legacy writers excluded until both identities are above their backfilled maxima.
LOCK TABLE "public"."held_events", "public"."matches" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  entity_table text;
  largest_id bigint;
BEGIN
  FOREACH entity_table IN ARRAY ARRAY['held_events', 'matches'] LOOP
    EXECUTE format('SELECT coalesce(max(public_id), 0) FROM public.%I', entity_table)
      INTO largest_id;
    IF largest_id = 9223372036854775807 THEN
      RAISE EXCEPTION 'Public identifier range exhausted for %', entity_table;
    END IF;
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN public_id RESTART WITH %s',
      entity_table, largest_id + 1);
  END LOOP;
END
$$;
