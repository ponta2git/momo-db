CREATE TABLE "ocr_queue_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"stream_payload" jsonb NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"claim_expires_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"redis_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ocr_queue_outbox_stream_payload_object_check" CHECK (jsonb_typeof("ocr_queue_outbox"."stream_payload") = 'object'),
	CONSTRAINT "ocr_queue_outbox_status_check" CHECK ("ocr_queue_outbox"."status" IN ('PENDING','IN_FLIGHT','DELIVERED','FAILED')),
	CONSTRAINT "ocr_queue_outbox_attempt_count_check" CHECK ("ocr_queue_outbox"."attempt_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ocr_queue_outbox" ADD CONSTRAINT "ocr_queue_outbox_job_id_ocr_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."ocr_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_ocr_queue_outbox_dedupe_active" ON "ocr_queue_outbox" USING btree ("dedupe_key") WHERE status IN ('PENDING','IN_FLIGHT','DELIVERED');--> statement-breakpoint
CREATE INDEX "idx_ocr_queue_outbox_status_next" ON "ocr_queue_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "idx_ocr_queue_outbox_job_id" ON "ocr_queue_outbox" USING btree ("job_id");