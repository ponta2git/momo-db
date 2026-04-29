CREATE TABLE "app_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"member_id" text NOT NULL,
	"csrf_secret" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ocr_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"requested_screen_type" text NOT NULL,
	"detected_screen_type" text,
	"profile_id" text,
	"payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"warnings_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"timings_ms_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ocr_drafts_payload_json_object_check" CHECK (jsonb_typeof("ocr_drafts"."payload_json") = 'object'),
	CONSTRAINT "ocr_drafts_warnings_json_array_check" CHECK (jsonb_typeof("ocr_drafts"."warnings_json") = 'array'),
	CONSTRAINT "ocr_drafts_timings_ms_json_object_check" CHECK (jsonb_typeof("ocr_drafts"."timings_ms_json") = 'object')
);
--> statement-breakpoint
CREATE TABLE "ocr_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"draft_id" text NOT NULL,
	"image_id" text NOT NULL,
	"image_path" text NOT NULL,
	"requested_screen_type" text NOT NULL,
	"detected_screen_type" text,
	"status" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"worker_id" text,
	"failure_code" text,
	"failure_message" text,
	"failure_retryable" boolean,
	"failure_user_action" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "app_sessions_member_id_idx" ON "app_sessions" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "app_sessions_expires_at_idx" ON "app_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ocr_drafts_job_id_unique" ON "ocr_drafts" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ocr_jobs_draft_id_unique" ON "ocr_jobs" USING btree ("draft_id");--> statement-breakpoint
CREATE INDEX "ocr_jobs_status_created_at_idx" ON "ocr_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "ocr_jobs_image_id_idx" ON "ocr_jobs" USING btree ("image_id");