-- Stop all old API/worker writers before applying this cutover. OCR inputs are
-- intentionally not backfilled; analysis requests and running leases survive.
CREATE TEMP TABLE retired_stream_ocr_jobs ON COMMIT DROP AS
SELECT id, draft_id FROM public.ocr_jobs
WHERE status IN ('queued', 'running') AND input_snapshot IS NULL;
--> statement-breakpoint
UPDATE public.ocr_submissions submission
SET status = 'aborted', finished_at = GREATEST(clock_timestamp(), submission.created_at)
WHERE submission.status = 'open'
  AND EXISTS (
    SELECT 1 FROM public.ocr_submission_members member
    WHERE member.submission_id = submission.id
      AND (member.status = 'pending' OR member.job_id IN (SELECT id FROM retired_stream_ocr_jobs))
  );
--> statement-breakpoint
UPDATE public.ocr_jobs job
SET status = 'failed', failure_code = 'QUEUE_FAILURE',
    failure_message = 'OCR was interrupted by the job scheduler migration.',
    failure_retryable = false,
    failure_user_action = 'OCRをやり直してください。',
    worker_id = NULL, attempt_id = NULL, lease_owner = NULL,
    lease_token = NULL, lease_expires_at = NULL,
    finished_at = clock_timestamp(), updated_at = clock_timestamp()
WHERE job.id IN (SELECT id FROM retired_stream_ocr_jobs);
--> statement-breakpoint
-- Recompute only drafts touched by retired jobs, using the normal slot projection.
WITH touched AS (
  SELECT md.id FROM public.match_drafts md
  WHERE md.status = 'ocr_running' AND EXISTS (
    SELECT 1 FROM retired_stream_ocr_jobs job
    WHERE job.draft_id IN (md.total_assets_draft_id, md.revenue_draft_id, md.incident_log_draft_id)
  )
), slot_jobs AS (
  SELECT md.id, job.status AS job_status,
         COALESCE(jsonb_array_length(ocr_draft.warnings_json), 0) AS warning_count
  FROM public.match_drafts md JOIN touched ON touched.id = md.id
  JOIN LATERAL unnest(ARRAY[md.total_assets_draft_id, md.revenue_draft_id, md.incident_log_draft_id])
    AS slot(ocr_draft_id) ON slot.ocr_draft_id IS NOT NULL
  LEFT JOIN public.ocr_jobs job ON job.draft_id = slot.ocr_draft_id
  LEFT JOIN public.ocr_drafts ocr_draft ON ocr_draft.id = slot.ocr_draft_id
), projected AS (
  SELECT id, CASE
    WHEN COUNT(*) FILTER (WHERE job_status IN ('queued', 'running') OR job_status IS NULL) > 0 THEN 'ocr_running'
    WHEN COUNT(*) FILTER (WHERE job_status IN ('failed', 'cancelled')) > 0 THEN 'ocr_failed'
    WHEN COUNT(*) FILTER (WHERE warning_count > 0) > 0 THEN 'needs_review'
    ELSE 'draft_ready' END AS status
  FROM slot_jobs GROUP BY id
)
UPDATE public.match_drafts draft SET status = projected.status, updated_at = clock_timestamp()
FROM projected WHERE draft.id = projected.id AND draft.status <> projected.status;
--> statement-breakpoint
-- Retain the fencing counter and every analysis holder for normal lease recovery.
UPDATE public.worker_execution_slots
SET task_kind = NULL, owner = NULL, job_id = NULL, attempt_id = NULL,
    holder_preemptible = NULL, lease_expires_at = NULL,
    preempt_requested_by = NULL, preempt_requested_at = NULL,
    updated_at = clock_timestamp()
WHERE task_kind = 'ocr' AND job_id IN (SELECT id FROM retired_stream_ocr_jobs);
