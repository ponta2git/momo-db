CREATE TABLE "series_analysis_campaign_targets" (
	"campaign_id" text NOT NULL,
	"game_title_id" text NOT NULL,
	"input_revision" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"job_request_id" text,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "series_analysis_campaign_targets_campaign_id_game_title_id_pk" PRIMARY KEY("campaign_id","game_title_id"),
	CONSTRAINT "series_analysis_campaign_targets_input_revision_check" CHECK ("series_analysis_campaign_targets"."input_revision" >= 0),
	CONSTRAINT "series_analysis_campaign_targets_status_check" CHECK ("series_analysis_campaign_targets"."status" IN ('pending','expanded','running','succeeded','failed','skipped_title_deleted'))
);
--> statement-breakpoint
CREATE TABLE "series_analysis_campaigns" (
	"id" text PRIMARY KEY NOT NULL,
	"operation_request_id" text NOT NULL,
	"trigger" text NOT NULL,
	"algorithm_version" text NOT NULL,
	"artifact_schema_version" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"target_count" integer NOT NULL,
	"expanded_count" integer DEFAULT 0 NOT NULL,
	"terminal_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "series_analysis_campaigns_operation_request_id_unique" UNIQUE("operation_request_id"),
	CONSTRAINT "series_analysis_campaigns_trigger_check" CHECK ("series_analysis_campaigns"."trigger" IN ('manual','algorithm_update','artifact_schema_update','initial_backfill')),
	CONSTRAINT "series_analysis_campaigns_status_check" CHECK ("series_analysis_campaigns"."status" IN ('queued','expanding','running','terminal')),
	CONSTRAINT "series_analysis_campaigns_schema_version_check" CHECK ("series_analysis_campaigns"."artifact_schema_version" >= 1),
	CONSTRAINT "series_analysis_campaigns_counts_check" CHECK ("series_analysis_campaigns"."target_count" >= 0 AND "series_analysis_campaigns"."expanded_count" >= 0 AND "series_analysis_campaigns"."terminal_count" >= 0 AND "series_analysis_campaigns"."failed_count" >= 0 AND "series_analysis_campaigns"."skipped_count" >= 0 AND "series_analysis_campaigns"."expanded_count" <= "series_analysis_campaigns"."target_count" AND "series_analysis_campaigns"."terminal_count" <= "series_analysis_campaigns"."target_count" AND "series_analysis_campaigns"."failed_count" + "series_analysis_campaigns"."skipped_count" <= "series_analysis_campaigns"."terminal_count")
);
--> statement-breakpoint
CREATE TABLE "series_analysis_job_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"attempt_no" integer NOT NULL,
	"owner" text NOT NULL,
	"fencing_token" bigint NOT NULL,
	"input_revision" bigint NOT NULL,
	"algorithm_version" text NOT NULL,
	"artifact_schema_version" integer NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"outcome" text,
	"effective_config_version" text NOT NULL,
	"calculation_timeout_milliseconds" bigint NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"elapsed_milliseconds" bigint,
	"calculation_milliseconds" bigint,
	"staging_milliseconds" bigint,
	"publication_milliseconds" bigint,
	"child_peak_bytes" bigint,
	"worker_peak_bytes" bigint,
	CONSTRAINT "series_analysis_job_attempts_positive_check" CHECK ("series_analysis_job_attempts"."attempt_no" >= 1 AND "series_analysis_job_attempts"."fencing_token" >= 1 AND "series_analysis_job_attempts"."input_revision" >= 0 AND "series_analysis_job_attempts"."artifact_schema_version" >= 1 AND "series_analysis_job_attempts"."calculation_timeout_milliseconds" >= 1),
	CONSTRAINT "series_analysis_job_attempts_status_check" CHECK ("series_analysis_job_attempts"."status" IN ('running','terminal')),
	CONSTRAINT "series_analysis_job_attempts_terminal_shape_check" CHECK (("series_analysis_job_attempts"."status" = 'terminal' AND "series_analysis_job_attempts"."outcome" IS NOT NULL AND "series_analysis_job_attempts"."finished_at" IS NOT NULL) OR ("series_analysis_job_attempts"."status" = 'running' AND "series_analysis_job_attempts"."outcome" IS NULL AND "series_analysis_job_attempts"."finished_at" IS NULL)),
	CONSTRAINT "series_analysis_job_attempts_outcome_check" CHECK ("series_analysis_job_attempts"."outcome" IS NULL OR "series_analysis_job_attempts"."outcome" IN ('succeeded','failed','timed_out','superseded','preempted','owner_lost','graceful_stop'))
);
--> statement-breakpoint
CREATE TABLE "series_analysis_job_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"game_title_id" text NOT NULL,
	"operation_request_id" text,
	"campaign_id" text,
	"input_revision" bigint NOT NULL,
	"algorithm_version" text NOT NULL,
	"artifact_schema_version" integer NOT NULL,
	"trigger" text NOT NULL,
	"force_run" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"assigned_job_id" text,
	"assigned_attempt_id" text,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fulfilled_at" timestamp with time zone,
	CONSTRAINT "series_analysis_job_requests_input_revision_check" CHECK ("series_analysis_job_requests"."input_revision" >= 0),
	CONSTRAINT "series_analysis_job_requests_schema_version_check" CHECK ("series_analysis_job_requests"."artifact_schema_version" >= 1),
	CONSTRAINT "series_analysis_job_requests_status_check" CHECK ("series_analysis_job_requests"."status" IN ('pending','assigned','fulfilled')),
	CONSTRAINT "series_analysis_job_requests_trigger_check" CHECK ("series_analysis_job_requests"."trigger" IN ('manual','artifact_schema_update','algorithm_update','initial_backfill','match_mutation')),
	CONSTRAINT "series_analysis_job_requests_fulfilled_shape_check" CHECK (("series_analysis_job_requests"."status" = 'fulfilled') = ("series_analysis_job_requests"."fulfilled_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "series_analysis_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"game_title_id" text NOT NULL,
	"input_revision" bigint NOT NULL,
	"algorithm_version" text NOT NULL,
	"artifact_schema_version" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"trigger" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"lease_owner" text,
	"lease_attempt_id" text,
	"lease_fencing_token" bigint,
	"lease_expires_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"transient_retry_count" integer DEFAULT 0 NOT NULL,
	"lease_recovery_count" integer DEFAULT 0 NOT NULL,
	"result_disposition" text DEFAULT 'none' NOT NULL,
	"output_checksum" text,
	"safe_failure_code" text,
	"elapsed_milliseconds" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "series_analysis_jobs_input_revision_check" CHECK ("series_analysis_jobs"."input_revision" >= 0),
	CONSTRAINT "series_analysis_jobs_schema_version_check" CHECK ("series_analysis_jobs"."artifact_schema_version" >= 1),
	CONSTRAINT "series_analysis_jobs_status_check" CHECK ("series_analysis_jobs"."status" IN ('queued','running','succeeded','failed','timed_out')),
	CONSTRAINT "series_analysis_jobs_trigger_check" CHECK ("series_analysis_jobs"."trigger" IN ('manual','artifact_schema_update','algorithm_update','initial_backfill','match_mutation')),
	CONSTRAINT "series_analysis_jobs_counts_check" CHECK ("series_analysis_jobs"."attempt_count" >= 0 AND "series_analysis_jobs"."transient_retry_count" BETWEEN 0 AND 3 AND "series_analysis_jobs"."lease_recovery_count" BETWEEN 0 AND 3),
	CONSTRAINT "series_analysis_jobs_result_disposition_check" CHECK ("series_analysis_jobs"."result_disposition" IN ('published','reused','none')),
	CONSTRAINT "series_analysis_jobs_lease_shape_check" CHECK (("series_analysis_jobs"."status" = 'running' AND "series_analysis_jobs"."lease_owner" IS NOT NULL AND "series_analysis_jobs"."lease_attempt_id" IS NOT NULL AND "series_analysis_jobs"."lease_fencing_token" IS NOT NULL AND "series_analysis_jobs"."lease_expires_at" IS NOT NULL) OR ("series_analysis_jobs"."status" <> 'running' AND "series_analysis_jobs"."lease_owner" IS NULL AND "series_analysis_jobs"."lease_attempt_id" IS NULL AND "series_analysis_jobs"."lease_fencing_token" IS NULL AND "series_analysis_jobs"."lease_expires_at" IS NULL)),
	CONSTRAINT "series_analysis_jobs_terminal_shape_check" CHECK (("series_analysis_jobs"."status" IN ('succeeded','failed','timed_out')) = ("series_analysis_jobs"."finished_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "series_analysis_operation_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"game_title_id" text,
	"requested_by_account_id" text,
	"idempotency_key_hash" text NOT NULL,
	"endpoint" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"target_count" integer NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "series_analysis_operation_requests_scope_check" CHECK ("series_analysis_operation_requests"."scope" IN ('title','all_titles')),
	CONSTRAINT "series_analysis_operation_requests_scope_title_check" CHECK (("series_analysis_operation_requests"."scope" = 'title' AND "series_analysis_operation_requests"."game_title_id" IS NOT NULL) OR ("series_analysis_operation_requests"."scope" = 'all_titles' AND "series_analysis_operation_requests"."game_title_id" IS NULL)),
	CONSTRAINT "series_analysis_operation_requests_status_check" CHECK ("series_analysis_operation_requests"."status" IN ('pending','running','terminal')),
	CONSTRAINT "series_analysis_operation_requests_target_count_check" CHECK ("series_analysis_operation_requests"."target_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "series_analysis_queue_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "series_analysis_queue_outbox_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "series_analysis_queue_outbox_schema_version_check" CHECK ("series_analysis_queue_outbox"."schema_version" = 1),
	CONSTRAINT "series_analysis_queue_outbox_status_check" CHECK ("series_analysis_queue_outbox"."status" IN ('pending','delivered','failed')),
	CONSTRAINT "series_analysis_queue_outbox_attempt_count_check" CHECK ("series_analysis_queue_outbox"."attempt_count" BETWEEN 0 AND 3)
);
--> statement-breakpoint
CREATE TABLE "series_analysis_worker_capabilities" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"algorithm_versions" jsonb NOT NULL,
	"artifact_schema_versions" jsonb NOT NULL,
	"draining" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "series_analysis_worker_capabilities_algorithms_array_check" CHECK (jsonb_typeof("series_analysis_worker_capabilities"."algorithm_versions") = 'array'),
	CONSTRAINT "series_analysis_worker_capabilities_schemas_array_check" CHECK (jsonb_typeof("series_analysis_worker_capabilities"."artifact_schema_versions") = 'array')
);
--> statement-breakpoint
CREATE TABLE "worker_execution_slots" (
	"slot_key" text PRIMARY KEY NOT NULL,
	"task_kind" text,
	"owner" text,
	"job_id" text,
	"attempt_id" text,
	"holder_preemptible" boolean,
	"lease_expires_at" timestamp with time zone,
	"fencing_token" bigint DEFAULT 0 NOT NULL,
	"preempt_requested_by" text,
	"preempt_requested_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_execution_slots_key_check" CHECK ("worker_execution_slots"."slot_key" = 'shared-heavy-work'),
	CONSTRAINT "worker_execution_slots_task_kind_check" CHECK ("worker_execution_slots"."task_kind" IS NULL OR "worker_execution_slots"."task_kind" IN ('analysis','ocr')),
	CONSTRAINT "worker_execution_slots_holder_shape_check" CHECK (("worker_execution_slots"."owner" IS NULL AND "worker_execution_slots"."task_kind" IS NULL AND "worker_execution_slots"."job_id" IS NULL AND "worker_execution_slots"."attempt_id" IS NULL AND "worker_execution_slots"."holder_preemptible" IS NULL AND "worker_execution_slots"."lease_expires_at" IS NULL) OR ("worker_execution_slots"."owner" IS NOT NULL AND "worker_execution_slots"."task_kind" IS NOT NULL AND "worker_execution_slots"."job_id" IS NOT NULL AND "worker_execution_slots"."attempt_id" IS NOT NULL AND "worker_execution_slots"."holder_preemptible" IS NOT NULL AND "worker_execution_slots"."lease_expires_at" IS NOT NULL)),
	CONSTRAINT "worker_execution_slots_preempt_shape_check" CHECK (("worker_execution_slots"."preempt_requested_by" IS NULL) = ("worker_execution_slots"."preempt_requested_at" IS NULL)),
	CONSTRAINT "worker_execution_slots_fencing_token_check" CHECK ("worker_execution_slots"."fencing_token" >= 0)
);
--> statement-breakpoint
INSERT INTO "worker_execution_slots" ("slot_key")
VALUES ('shared-heavy-work')
ON CONFLICT ("slot_key") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "series_analysis_campaign_targets" ADD CONSTRAINT "series_analysis_campaign_targets_campaign_id_series_analysis_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."series_analysis_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_analysis_campaigns" ADD CONSTRAINT "series_analysis_campaigns_operation_request_id_series_analysis_operation_requests_id_fk" FOREIGN KEY ("operation_request_id") REFERENCES "public"."series_analysis_operation_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_analysis_job_attempts" ADD CONSTRAINT "series_analysis_job_attempts_job_id_series_analysis_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."series_analysis_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_analysis_job_requests" ADD CONSTRAINT "series_analysis_job_requests_operation_request_id_series_analysis_operation_requests_id_fk" FOREIGN KEY ("operation_request_id") REFERENCES "public"."series_analysis_operation_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_analysis_job_requests" ADD CONSTRAINT "series_analysis_job_requests_campaign_id_series_analysis_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."series_analysis_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_analysis_job_requests" ADD CONSTRAINT "series_analysis_job_requests_assigned_job_id_series_analysis_jobs_id_fk" FOREIGN KEY ("assigned_job_id") REFERENCES "public"."series_analysis_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_analysis_jobs" ADD CONSTRAINT "series_analysis_jobs_game_title_id_game_titles_id_fk" FOREIGN KEY ("game_title_id") REFERENCES "public"."game_titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_analysis_operation_requests" ADD CONSTRAINT "series_analysis_operation_requests_requested_by_account_id_momo_login_accounts_id_fk" FOREIGN KEY ("requested_by_account_id") REFERENCES "public"."momo_login_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_analysis_queue_outbox" ADD CONSTRAINT "series_analysis_queue_outbox_job_id_series_analysis_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."series_analysis_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "series_analysis_campaign_targets_pending_idx" ON "series_analysis_campaign_targets" USING btree ("accepted_at","campaign_id","game_title_id") WHERE "series_analysis_campaign_targets"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "series_analysis_campaigns_status_accepted_idx" ON "series_analysis_campaigns" USING btree ("status","accepted_at");--> statement-breakpoint
CREATE INDEX "series_analysis_campaigns_terminal_cleanup_idx" ON "series_analysis_campaigns" USING btree ("finished_at") WHERE "series_analysis_campaigns"."status" = 'terminal';--> statement-breakpoint
CREATE UNIQUE INDEX "series_analysis_job_attempts_job_no_unique" ON "series_analysis_job_attempts" USING btree ("job_id","attempt_no");--> statement-breakpoint
CREATE INDEX "series_analysis_job_attempts_running_idx" ON "series_analysis_job_attempts" USING btree ("started_at") WHERE "series_analysis_job_attempts"."status" = 'running';--> statement-breakpoint
CREATE INDEX "series_analysis_job_requests_pending_title_idx" ON "series_analysis_job_requests" USING btree ("game_title_id","accepted_at","id") WHERE "series_analysis_job_requests"."status" IN ('pending','assigned');--> statement-breakpoint
CREATE INDEX "series_analysis_job_requests_terminal_cleanup_idx" ON "series_analysis_job_requests" USING btree ("fulfilled_at") WHERE "series_analysis_job_requests"."status" = 'fulfilled';--> statement-breakpoint
CREATE UNIQUE INDEX "series_analysis_jobs_active_title_unique" ON "series_analysis_jobs" USING btree ("game_title_id") WHERE "series_analysis_jobs"."status" IN ('queued','running');--> statement-breakpoint
CREATE INDEX "series_analysis_jobs_claim_idx" ON "series_analysis_jobs" USING btree ("available_at","requested_at","id") WHERE "series_analysis_jobs"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "series_analysis_jobs_terminal_cleanup_idx" ON "series_analysis_jobs" USING btree ("finished_at") WHERE "series_analysis_jobs"."status" IN ('succeeded','failed','timed_out');--> statement-breakpoint
CREATE UNIQUE INDEX "series_analysis_operation_requests_idempotency_unique" ON "series_analysis_operation_requests" USING btree ("requested_by_account_id","endpoint","idempotency_key_hash");--> statement-breakpoint
CREATE INDEX "series_analysis_operation_requests_terminal_cleanup_idx" ON "series_analysis_operation_requests" USING btree ("finished_at") WHERE "series_analysis_operation_requests"."status" = 'terminal';--> statement-breakpoint
CREATE INDEX "series_analysis_queue_outbox_dispatch_idx" ON "series_analysis_queue_outbox" USING btree ("next_attempt_at","created_at","id") WHERE "series_analysis_queue_outbox"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "series_analysis_queue_outbox_job_idx" ON "series_analysis_queue_outbox" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "series_analysis_worker_capabilities_heartbeat_idx" ON "series_analysis_worker_capabilities" USING btree ("heartbeat_at");
