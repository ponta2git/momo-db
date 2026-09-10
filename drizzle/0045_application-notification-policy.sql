-- Coordinated cutover: all writers/consumers must use the application policy.
--> statement-breakpoint
-- Keep tables, payload hashes, settings generations and delivery evidence intact.
--> statement-breakpoint
DROP TRIGGER discord_settings_lock ON public.discord_notification_settings;
--> statement-breakpoint
DROP TRIGGER discord_settings_guard ON public.discord_notification_settings;
--> statement-breakpoint
DROP TRIGGER discord_settings_cancel ON public.discord_notification_settings;
--> statement-breakpoint
DROP TRIGGER discord_draft_change_cancel ON public.match_drafts;
--> statement-breakpoint
DROP TRIGGER discord_match_delete_cancel ON public.matches;
--> statement-breakpoint
DROP TRIGGER discord_notification_immutable ON public.discord_notifications;
--> statement-breakpoint
DROP TRIGGER discord_result_identity_guard ON public.discord_notification_results;
--> statement-breakpoint
DROP TRIGGER discord_target_identity_guard ON public.discord_notification_targets;
--> statement-breakpoint
DROP TRIGGER discord_part_identity_guard ON public.discord_notification_parts;
--> statement-breakpoint
DROP TRIGGER discord_notification_context ON public.discord_notifications;
--> statement-breakpoint
DROP TRIGGER discord_attendance_context ON public.discord_notification_attendance;
--> statement-breakpoint
DROP TRIGGER discord_result_context ON public.discord_notification_results;
--> statement-breakpoint
DROP FUNCTION public.purge_discord_notifications(timestamptz, text, timestamptz, timestamptz);
--> statement-breakpoint
DROP FUNCTION public.requeue_discord_attendance_chains(timestamptz);
--> statement-breakpoint
DROP FUNCTION public.retry_discord_result_notification(text, timestamptz);
--> statement-breakpoint
DROP FUNCTION public.renew_discord_notification_claim(text, uuid, timestamptz, integer);
--> statement-breakpoint
DROP FUNCTION public.fail_discord_notification(text, uuid, text, timestamptz, timestamptz);
--> statement-breakpoint
DROP FUNCTION public.complete_discord_notification_part(text, integer, uuid, text, timestamptz);
--> statement-breakpoint
DROP FUNCTION public.begin_discord_notification_part(text, integer, uuid, timestamptz);
--> statement-breakpoint
DROP FUNCTION public.plan_discord_notification_parts(text, uuid, integer, integer, timestamptz);
--> statement-breakpoint
DROP FUNCTION public.claim_discord_notifications(text, integer, timestamptz, integer);
--> statement-breakpoint
DROP FUNCTION public.release_discord_notification_claims(text, timestamptz);
--> statement-breakpoint
DROP FUNCTION public.cancel_discord_attendance_successors(timestamptz);
--> statement-breakpoint
DROP FUNCTION public.enqueue_discord_attendance_notification(text, text, jsonb, text, bigint, smallint, timestamptz);
--> statement-breakpoint
DROP FUNCTION public.discord_notification_context_guard();
--> statement-breakpoint
DROP FUNCTION public.discord_notification_detail_guard();
--> statement-breakpoint
DROP FUNCTION public.discord_notification_immutable_guard();
--> statement-breakpoint
DROP FUNCTION public.receive_discord_result_notification(jsonb, timestamptz);
--> statement-breakpoint
DROP FUNCTION public.validate_discord_result_payload(jsonb);
--> statement-breakpoint
DROP FUNCTION public.validate_discord_rank_comparisons(jsonb);
--> statement-breakpoint
DROP FUNCTION public.require_discord_notification_input(boolean);
--> statement-breakpoint
DROP FUNCTION public.discord_notification_target_changed();
--> statement-breakpoint
DROP FUNCTION public.set_discord_notification_setting(text, boolean);
--> statement-breakpoint
DROP FUNCTION public.get_discord_notification_setting(text);
--> statement-breakpoint
DROP FUNCTION public.discord_notification_settings_cancel();
--> statement-breakpoint
DROP FUNCTION public.discord_notification_settings_guard();
--> statement-breakpoint
DROP FUNCTION public.discord_result_cancel_reason(text);
--> statement-breakpoint
DROP FUNCTION public.cancel_discord_notification(text, text, timestamptz);
--> statement-breakpoint
DROP FUNCTION public.discord_result_write_lock();
--> statement-breakpoint
DROP FUNCTION public.lock_discord_result_notifications();
--> statement-breakpoint
DROP FUNCTION public.discord_notification_hash(jsonb);
--> statement-breakpoint
DROP FUNCTION public.discord_notification_canonical_json(jsonb);
