-- Compatibility expansion only: the shared execution slot remains authoritative.
-- Writer停止の実証は P0 writer inventory / frozen / CI guard で行う。
-- backfill 後は新 consumer 切替完了まで旧 claim writer を再開しない。
-- A saved running row is legitimate after processes stop. Do not clear its lease
-- or manufacture a zero-running-row proof. The locks below only freeze DB inputs.
-- NOWAIT rejects an overlapping transaction before any new column or seed exists.
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
END;
$migration$;
