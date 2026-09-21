CREATE TABLE "ocr_submission_members" (
	"submission_id" text NOT NULL,
	"screen_type" text NOT NULL,
	"upload_idempotency_key_hash" text NOT NULL,
	"image_sha256_hex" text NOT NULL,
	"image_byte_length" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"job_id" text,
	"failure_code" text,
	CONSTRAINT "ocr_submission_members_submission_id_screen_type_pk" PRIMARY KEY("submission_id","screen_type"),
	CONSTRAINT "ocr_submission_members_screen_check" CHECK ("ocr_submission_members"."screen_type" IN ('total_assets','revenue','incident_log')),
	CONSTRAINT "ocr_submission_members_hashes_check" CHECK (length("ocr_submission_members"."upload_idempotency_key_hash") = 64 AND "ocr_submission_members"."upload_idempotency_key_hash" ~ '^[0-9a-f]{64}$' AND length("ocr_submission_members"."image_sha256_hex") = 64 AND "ocr_submission_members"."image_sha256_hex" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ocr_submission_members_bytes_check" CHECK ("ocr_submission_members"."image_byte_length" BETWEEN 1 AND 3145728),
	CONSTRAINT "ocr_submission_members_shape_check" CHECK (("ocr_submission_members"."status" = 'pending' AND "ocr_submission_members"."job_id" IS NULL AND "ocr_submission_members"."failure_code" IS NULL) OR ("ocr_submission_members"."status" = 'registered' AND "ocr_submission_members"."job_id" IS NOT NULL AND "ocr_submission_members"."failure_code" IS NULL) OR ("ocr_submission_members"."status" = 'failed' AND "ocr_submission_members"."job_id" IS NULL AND "ocr_submission_members"."failure_code" IS NOT NULL AND "ocr_submission_members"."failure_code" IN ('admission_failed','admission_timeout')))
);
--> statement-breakpoint
CREATE TABLE "ocr_submissions" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_account_id" text NOT NULL,
	"match_draft_id" text NOT NULL,
	"ocr_hints_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"admission_deadline" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "ocr_submissions_id_check" CHECK (length("ocr_submissions"."id") = 36 AND "ocr_submissions"."id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
	CONSTRAINT "ocr_submissions_hints_object_check" CHECK (jsonb_typeof("ocr_submissions"."ocr_hints_json") = 'object'),
	CONSTRAINT "ocr_submissions_status_check" CHECK ("ocr_submissions"."status" IN ('open','settled','aborted')),
	CONSTRAINT "ocr_submissions_terminal_shape_check" CHECK (("ocr_submissions"."status" = 'open' AND "ocr_submissions"."finished_at" IS NULL) OR ("ocr_submissions"."status" IN ('settled','aborted') AND "ocr_submissions"."finished_at" IS NOT NULL)),
	CONSTRAINT "ocr_submissions_time_check" CHECK ("ocr_submissions"."admission_deadline" > "ocr_submissions"."created_at" AND ("ocr_submissions"."finished_at" IS NULL OR "ocr_submissions"."finished_at" >= "ocr_submissions"."created_at"))
);
--> statement-breakpoint
ALTER TABLE "ocr_submission_members" ADD CONSTRAINT "ocr_submission_members_submission_id_ocr_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."ocr_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocr_submission_members" ADD CONSTRAINT "ocr_submission_members_job_id_ocr_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."ocr_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocr_submissions" ADD CONSTRAINT "ocr_submissions_owner_account_id_momo_login_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."momo_login_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ocr_submission_members_job_unique" ON "ocr_submission_members" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ocr_submission_members_upload_unique" ON "ocr_submission_members" USING btree ("submission_id","upload_idempotency_key_hash");--> statement-breakpoint
CREATE INDEX "ocr_submission_members_upload_hash_idx" ON "ocr_submission_members" USING btree ("upload_idempotency_key_hash");--> statement-breakpoint
CREATE INDEX "ocr_submissions_status_id_idx" ON "ocr_submissions" USING btree ("status","id");--> statement-breakpoint
CREATE INDEX "ocr_submissions_status_deadline_idx" ON "ocr_submissions" USING btree ("status","admission_deadline","id");--> statement-breakpoint
CREATE INDEX "ocr_submissions_owner_status_idx" ON "ocr_submissions" USING btree ("owner_account_id","status");--> statement-breakpoint
CREATE INDEX "ocr_submissions_draft_status_idx" ON "ocr_submissions" USING btree ("match_draft_id","status");