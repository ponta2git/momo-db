ALTER TABLE "ocr_jobs" ADD COLUMN "input_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "ocr_jobs" ADD COLUMN "failure_retry_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ocr_jobs" ADD COLUMN "lease_recovery_count" integer DEFAULT 0 NOT NULL;