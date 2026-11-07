-- Every historical Session remains source=legacy. In particular, Friday alone
-- does not establish automatic creation. Preserve all old values, IDs and links.
-- Only the proven old skip sentinel ceases to occupy a candidate date.
UPDATE public.sessions s SET occupies_date = false
WHERE s.status = 'SKIPPED' AND s.cancel_reason = 'manual_skip' AND s.postpone_count = 0
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
      );
--> statement-breakpoint
-- Old SKIPPED means that week's automation was disabled. Keep this durable
-- decision independently of Session identity; purged actor evidence stays NULL.
INSERT INTO public.weekly_ask_schedules (week_key, disabled_at, disabled_by, created_at, updated_at)
SELECT skipped.week_key, skipped.disabled_at,
  (SELECT n.payload->'extra'->>'invokerUserId'
   FROM public.discord_notifications n
   WHERE n.family = 'attendance'
     AND n.dedupe_key = 'cancel-week-notice-' || skipped.week_key
     AND jsonb_typeof(n.payload->'extra'->'invokerUserId') = 'string'),
  skipped.disabled_at, skipped.disabled_at
FROM (
  SELECT week_key, min(updated_at) AS disabled_at
  FROM public.sessions WHERE status = 'SKIPPED'
  GROUP BY week_key
) skipped;
