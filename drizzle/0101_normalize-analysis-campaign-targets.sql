-- Campaign targets are assigned through job requests. Historical "running"
-- targets represent the same nonterminal assignment as "expanded"; job and
-- attempt rows retain execution progress. Preserve counters and timestamps.
-- This contract tail requires all old consumers to be stopped before applying.
-- Acquire every later ALTER target up front in the consumer lock order, so a
-- conflicting writer rejects this tail before normalization or ledger writes.
LOCK TABLE public.series_analysis_title_states,
  public.series_analysis_job_requests,
  public.series_analysis_campaign_targets IN ACCESS EXCLUSIVE MODE NOWAIT;
--> statement-breakpoint
UPDATE public.series_analysis_campaign_targets
SET status = 'expanded'
WHERE status = 'running';
