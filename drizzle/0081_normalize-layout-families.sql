-- Normalize only the three mutable scalar layout selectors. Stored OCR input,
-- hints, profile IDs, notifications and immutable analysis/radar payloads stay exact.
-- Writer admission remains stopped through the following canonical CHECK migration.
LOCK TABLE public.game_titles, public.match_drafts, public.matches IN ACCESS EXCLUSIVE MODE NOWAIT;
--> statement-breakpoint
DO $migration$
DECLARE
  relation_name text;
  invalid_values boolean;
  -- The shared reader contract trims only space, HT, LF, VT, FF and CR.
  -- ASCII casefold is independent of locale. Unicode whitespace is rejected.
  canonical_expression constant text := $expression$
    CASE translate(btrim(layout_family,
      U&'\0020\0009\000A\000B\000C\000D'),
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')
      WHEN 'momotetsu_2' THEN 'momotetsu_2'
      WHEN 'momotetsu2' THEN 'momotetsu_2'
      WHEN '2' THEN 'momotetsu_2'
      WHEN 'world' THEN 'world'
      WHEN 'momotetsu_world' THEN 'world'
      WHEN 'default' THEN 'world'
      WHEN 'reiwa' THEN 'reiwa'
      WHEN 'momotetsu_reiwa' THEN 'reiwa'
      ELSE NULL
    END
  $expression$;
BEGIN
  -- Check every source before updating any table. NULL is a draft's unselected
  -- state; an empty string, literal "auto" or unknown alias is never guessed.
  FOREACH relation_name IN ARRAY ARRAY['game_titles', 'match_drafts', 'matches'] LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE layout_family IS NOT NULL AND (%s) IS NULL)',
      relation_name, canonical_expression) INTO invalid_values;
    IF invalid_values THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'LAYOUT_FAMILY_UNMAPPED_SOURCE', TABLE = relation_name;
    END IF;
  END LOOP;
  FOREACH relation_name IN ARRAY ARRAY['game_titles', 'match_drafts', 'matches'] LOOP
    EXECUTE format('UPDATE public.%I SET layout_family = (%s) WHERE layout_family IS DISTINCT FROM (%s)',
      relation_name, canonical_expression, canonical_expression);
  END LOOP;
END;
$migration$;
