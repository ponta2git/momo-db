-- The normal migrator retains 0078's locks through this complete transaction.
-- Reacquire them and recheck the inputs for a deliberately prepared 0079 prefix.
-- This backfill preserves every old row value, including active lease evidence.
-- backfill 後は新 consumer 切替完了まで旧 claim writer を再開しない。
-- Slot removal is a later cutover: reseed then, or first deploy claims that keep
-- this counter at least as high as the shared slot token in the same transaction.
LOCK TABLE public.worker_execution_slots, public.series_analysis_jobs,
  public.series_analysis_job_attempts IN ACCESS EXCLUSIVE MODE NOWAIT;
--> statement-breakpoint
DO $migration$
BEGIN
  IF (SELECT count(*) FROM public.worker_execution_slots) <> 1
    OR NOT EXISTS (SELECT 1 FROM public.worker_execution_slots WHERE slot_key = 'shared-heavy-work') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'ANALYSIS_FENCE_GLOBAL_SLOT_REQUIRED';
  END IF;
  IF EXISTS (SELECT 1 FROM public.worker_execution_slots WHERE fencing_token < 0)
    OR EXISTS (SELECT 1 FROM public.series_analysis_jobs WHERE lease_fencing_token < 0)
    OR EXISTS (SELECT 1 FROM public.series_analysis_job_attempts WHERE fencing_token < 1) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'ANALYSIS_FENCE_NEGATIVE_SOURCE';
  END IF;
  IF EXISTS (SELECT 1 FROM public.worker_execution_slots WHERE fencing_token = 9223372036854775807)
    OR EXISTS (SELECT 1 FROM public.series_analysis_jobs WHERE lease_fencing_token = 9223372036854775807)
    OR EXISTS (SELECT 1 FROM public.series_analysis_job_attempts WHERE fencing_token = 9223372036854775807) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'ANALYSIS_FENCE_SOURCE_EXHAUSTED';
  END IF;
  IF EXISTS (SELECT 1 FROM public.series_analysis_jobs WHERE fencing_counter <> 0) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'ANALYSIS_FENCE_COUNTER_ALREADY_ASSIGNED';
  END IF;
END;
$migration$;
--> statement-breakpoint
WITH global_floor AS (
  SELECT max(fencing_token) AS value FROM public.worker_execution_slots
), attempt_floors AS (
  SELECT job_id, max(fencing_token) AS value FROM public.series_analysis_job_attempts GROUP BY job_id
), seeds AS (
  SELECT jobs.id, greatest(0::bigint, global_floor.value,
    coalesce(jobs.lease_fencing_token, 0), coalesce(attempt_floors.value, 0)) AS value
  FROM public.series_analysis_jobs jobs CROSS JOIN global_floor
  LEFT JOIN attempt_floors ON attempt_floors.job_id = jobs.id
)
UPDATE public.series_analysis_jobs jobs SET fencing_counter = seeds.value
FROM seeds WHERE jobs.id = seeds.id AND jobs.fencing_counter IS DISTINCT FROM seeds.value;
