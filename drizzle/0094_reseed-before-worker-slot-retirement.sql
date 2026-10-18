-- Retirement is authorized only after the writer freeze and both consumers'
-- no-slot gates. The original archive retains the complete shared-slot row.
-- These locks stabilize inputs; they do not attest that processes have stopped.
-- Saved running jobs/leases/attempts remain valid and are never cleared here.
-- backfill 後は新 consumer 切替完了まで旧 claim writer を再開しない。
LOCK TABLE public.worker_execution_slots, public.series_analysis_jobs,
  public.series_analysis_job_attempts IN ACCESS EXCLUSIVE MODE NOWAIT;
--> statement-breakpoint
DO $migration$
BEGIN
  IF (SELECT count(*) FROM public.worker_execution_slots) <> 1
    OR NOT EXISTS (SELECT 1 FROM public.worker_execution_slots WHERE slot_key = 'shared-heavy-work') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'WORKER_SLOT_RETIREMENT_GLOBAL_SLOT_REQUIRED';
  END IF;
  IF EXISTS (SELECT 1 FROM public.worker_execution_slots WHERE fencing_token < 0)
    OR EXISTS (SELECT 1 FROM public.series_analysis_jobs WHERE fencing_counter < 0 OR lease_fencing_token < 0)
    OR EXISTS (SELECT 1 FROM public.series_analysis_job_attempts WHERE fencing_token < 1) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'WORKER_SLOT_RETIREMENT_NEGATIVE_SOURCE';
  END IF;
  IF EXISTS (SELECT 1 FROM public.worker_execution_slots WHERE fencing_token = 9223372036854775807)
    OR EXISTS (SELECT 1 FROM public.series_analysis_jobs WHERE fencing_counter = 9223372036854775807
      OR lease_fencing_token = 9223372036854775807)
    OR EXISTS (SELECT 1 FROM public.series_analysis_job_attempts WHERE fencing_token = 9223372036854775807) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'WORKER_SLOT_RETIREMENT_SOURCE_EXHAUSTED';
  END IF;
END;
$migration$;
--> statement-breakpoint
-- Recompute the cutover floor even if an old claim ran after the expansion.
-- Preserve any higher counter already issued by a new consumer.
WITH global_floor AS (
  SELECT max(fencing_token) AS value FROM public.worker_execution_slots
), attempt_floors AS (
  SELECT job_id, max(fencing_token) AS value FROM public.series_analysis_job_attempts GROUP BY job_id
), seeds AS (
  SELECT jobs.id, greatest(0::bigint, jobs.fencing_counter, global_floor.value,
    coalesce(jobs.lease_fencing_token, 0), coalesce(attempt_floors.value, 0)) AS value
  FROM public.series_analysis_jobs jobs CROSS JOIN global_floor
  LEFT JOIN attempt_floors ON attempt_floors.job_id = jobs.id
)
UPDATE public.series_analysis_jobs jobs SET fencing_counter = seeds.value
FROM seeds WHERE jobs.id = seeds.id AND jobs.fencing_counter IS DISTINCT FROM seeds.value;
