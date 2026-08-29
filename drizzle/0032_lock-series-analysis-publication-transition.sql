-- why: drizzle-orm applies every pending PostgreSQL migration in one transaction.
-- Acquire the application release lock before the following schema migration can
-- hold table locks, otherwise a concurrent release can deadlock while taking the
-- same locks in the opposite order.
SELECT pg_advisory_xact_lock(hashtext('momo-series-analysis-release'));--> statement-breakpoint
-- why: registration writes game_titles and then creates the matching title state.
-- Block that transition before the following migration locks title_states.
LOCK TABLE "public"."game_titles" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
-- why: freeze the desired tuples across the precondition checks and singleton seed.
-- The lock order for this transition is advisory release lock -> game_titles -> title_states.
LOCK TABLE "public"."series_analysis_title_states" IN SHARE ROW EXCLUSIVE MODE;
