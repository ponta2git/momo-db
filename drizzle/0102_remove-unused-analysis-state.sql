ALTER TABLE "series_analysis_campaign_targets" DROP CONSTRAINT "series_analysis_campaign_targets_status_check";--> statement-breakpoint
ALTER TABLE "series_analysis_title_states" DROP CONSTRAINT "series_analysis_title_states_pending_forced_run_count_check";--> statement-breakpoint
ALTER TABLE "series_analysis_job_requests" DROP COLUMN "force_run";--> statement-breakpoint
ALTER TABLE "series_analysis_title_states" DROP COLUMN "pending_forced_run_count";--> statement-breakpoint
ALTER TABLE "series_analysis_campaign_targets" ADD CONSTRAINT "series_analysis_campaign_targets_status_check" CHECK ("series_analysis_campaign_targets"."status" IN ('pending','expanded','succeeded','failed','skipped_title_deleted'));