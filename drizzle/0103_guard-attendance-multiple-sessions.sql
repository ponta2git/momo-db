-- New attendance rules require completed historical work. No historical business
-- state is guessed or repaired here. The migrator keeps these locks until the
-- full tail commits, so no old writer may create rows between guard and backfill.
LOCK TABLE public.sessions, public.responses, public.held_events,
  public.discord_notifications, public.discord_notification_attendance,
  public.discord_notification_parts IN ACCESS EXCLUSIVE MODE NOWAIT;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.sessions WHERE status IN ('ASKING','POSTPONE_VOTING','DECIDED','CANCELLED')) THEN
    RAISE EXCEPTION 'ATTENDANCE_MIGRATION_ACTIVE_SESSION' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.discord_notifications WHERE family = 'attendance' AND status IN ('PENDING','IN_FLIGHT','FAILED')) THEN
    RAISE EXCEPTION 'ATTENDANCE_MIGRATION_UNDELIVERED_NOTICE' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.sessions s WHERE s.status = 'SKIPPED'
      AND NOT (s.postpone_count = 1 OR s.ask_message_id IS NOT NULL OR s.postpone_message_id IS NOT NULL
      OR s.decided_start_at IS NOT NULL OR s.reminder_at IS NOT NULL OR s.reminder_sent_at IS NOT NULL
      OR EXISTS (SELECT 1 FROM public.responses r WHERE r.session_id = s.id)
      OR EXISTS (SELECT 1 FROM public.held_events h WHERE h.session_id = s.id)
      OR EXISTS (
        SELECT 1 FROM public.discord_notification_attendance a
        JOIN public.discord_notifications n ON n.id = a.notification_id
        WHERE a.session_id = s.legacy_id
          AND n.dedupe_key <> 'cancel-week-notice-' || s.week_key
      ))
      AND NOT COALESCE((s.status = 'SKIPPED' AND s.cancel_reason = 'manual_skip' AND s.postpone_count = 0
      AND s.revision = 1 AND s.created_at = s.updated_at
      AND s.ask_message_id IS NULL AND s.postpone_message_id IS NULL
      AND s.decided_start_at IS NULL AND s.reminder_at IS NULL AND s.reminder_sent_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.responses r WHERE r.session_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM public.held_events h WHERE h.session_id = s.id)
      AND EXISTS (
        SELECT 1 FROM public.discord_notification_attendance a
        JOIN public.discord_notifications n ON n.id = a.notification_id
        WHERE a.session_id = s.legacy_id AND n.family = 'attendance'
          AND n.dedupe_key = 'cancel-week-notice-' || s.week_key
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.discord_notification_attendance a
        JOIN public.discord_notifications n ON n.id = a.notification_id
        WHERE a.session_id = s.legacy_id
          AND n.dedupe_key <> 'cancel-week-notice-' || s.week_key
      )), false)
  ) THEN
    RAISE EXCEPTION 'ATTENDANCE_MIGRATION_AMBIGUOUS_SKIP_MARKER' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT s.candidate_date_iso FROM public.sessions s
    WHERE NOT COALESCE((s.status = 'SKIPPED' AND s.cancel_reason = 'manual_skip' AND s.postpone_count = 0
      AND s.revision = 1 AND s.created_at = s.updated_at
      AND s.ask_message_id IS NULL AND s.postpone_message_id IS NULL
      AND s.decided_start_at IS NULL AND s.reminder_at IS NULL AND s.reminder_sent_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.responses r WHERE r.session_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM public.held_events h WHERE h.session_id = s.id)
      AND EXISTS (
        SELECT 1 FROM public.discord_notification_attendance a
        JOIN public.discord_notifications n ON n.id = a.notification_id
        WHERE a.session_id = s.legacy_id AND n.family = 'attendance'
          AND n.dedupe_key = 'cancel-week-notice-' || s.week_key
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.discord_notification_attendance a
        JOIN public.discord_notifications n ON n.id = a.notification_id
        WHERE a.session_id = s.legacy_id
          AND n.dedupe_key <> 'cancel-week-notice-' || s.week_key
      )), false)
    GROUP BY s.candidate_date_iso HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'ATTENDANCE_MIGRATION_DUPLICATE_CANDIDATE_DATE' USING ERRCODE = '23514';
  END IF;
END $$;
