-- Campaign targets are assigned through job requests. Historical "running"
-- targets represent the same nonterminal assignment as "expanded"; job and
-- attempt rows retain execution progress. Preserve counters and timestamps.
-- This contract tail requires all old consumers to be stopped before applying.
LOCK TABLE public.series_analysis_campaign_targets IN ACCESS EXCLUSIVE MODE NOWAIT;
--> statement-breakpoint
UPDATE public.series_analysis_campaign_targets
SET status = 'expanded'
WHERE status = 'running';
