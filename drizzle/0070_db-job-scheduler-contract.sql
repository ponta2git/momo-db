ALTER TABLE "ocr_queue_outbox" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "series_analysis_queue_outbox" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "ocr_queue_outbox" CASCADE;--> statement-breakpoint
DROP TABLE "series_analysis_queue_outbox" CASCADE;--> statement-breakpoint
ALTER TABLE "ocr_jobs" DROP CONSTRAINT "ocr_jobs_queue_schema_version_check";--> statement-breakpoint
ALTER TABLE "ocr_jobs" DROP CONSTRAINT "ocr_jobs_input_contract_check";--> statement-breakpoint
DROP INDEX "ocr_jobs_claimable_idx";--> statement-breakpoint
CREATE INDEX "ocr_jobs_claimable_idx" ON "ocr_jobs" USING btree ("available_at","created_at","id") WHERE "ocr_jobs"."status" = 'queued';--> statement-breakpoint
ALTER TABLE "ocr_jobs" DROP COLUMN "queue_schema_version";--> statement-breakpoint
ALTER TABLE "ocr_jobs" ADD CONSTRAINT "ocr_jobs_input_snapshot_check" CHECK (("ocr_jobs"."input_snapshot" IS NULL AND "ocr_jobs"."status" IN ('succeeded','failed','cancelled')) OR ("ocr_jobs"."input_snapshot" IS NOT NULL AND jsonb_typeof("ocr_jobs"."input_snapshot") = 'object' AND COALESCE("ocr_jobs"."input_snapshot"->'schemaVersion' = '"2"'::jsonb, false) AND "ocr_jobs"."source_image_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "ocr_jobs" ADD CONSTRAINT "ocr_jobs_retry_counts_check" CHECK ("ocr_jobs"."failure_retry_count" >= 0 AND "ocr_jobs"."lease_recovery_count" >= 0);