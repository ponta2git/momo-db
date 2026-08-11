CREATE TABLE "source_images" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_account_id" text NOT NULL,
	"object_key" text NOT NULL,
	"idempotency_key_hash" text NOT NULL,
	"status" text DEFAULT 'RESERVED' NOT NULL,
	"media_type" text,
	"byte_length" integer,
	"sha256_hex" text,
	"width" integer,
	"height" integer,
	"storage_etag" text,
	"failure_code" text,
	"available_at" timestamp with time zone,
	"delete_pending_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_images_status_check" CHECK ("source_images"."status" IN ('RESERVED','AVAILABLE','DELETE_PENDING','DELETED','FAILED')),
	CONSTRAINT "source_images_object_key_check" CHECK (length("source_images"."object_key") BETWEEN 1 AND 512 AND "source_images"."object_key" !~ '(^/|://|(^|/)\.\.(/|$))'),
	CONSTRAINT "source_images_idempotency_hash_check" CHECK ("source_images"."idempotency_key_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "source_images_media_type_check" CHECK ("source_images"."media_type" IS NULL OR "source_images"."media_type" IN ('image/png','image/jpeg','image/webp')),
	CONSTRAINT "source_images_byte_length_check" CHECK ("source_images"."byte_length" IS NULL OR "source_images"."byte_length" BETWEEN 1 AND 3145728),
	CONSTRAINT "source_images_dimensions_check" CHECK (("source_images"."width" IS NULL AND "source_images"."height" IS NULL) OR ("source_images"."width" IS NOT NULL AND "source_images"."height" IS NOT NULL AND "source_images"."width" BETWEEN 1 AND 1920 AND "source_images"."height" BETWEEN 1 AND 1080)),
	CONSTRAINT "source_images_sha256_check" CHECK ("source_images"."sha256_hex" IS NULL OR "source_images"."sha256_hex" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "source_images_available_metadata_check" CHECK ("source_images"."status" NOT IN ('AVAILABLE','DELETE_PENDING','DELETED') OR ("source_images"."media_type" IS NOT NULL AND "source_images"."byte_length" IS NOT NULL AND "source_images"."sha256_hex" IS NOT NULL AND "source_images"."width" IS NOT NULL AND "source_images"."height" IS NOT NULL AND "source_images"."available_at" IS NOT NULL)),
	CONSTRAINT "source_images_deletion_state_check" CHECK (("source_images"."status" <> 'DELETE_PENDING' OR "source_images"."delete_pending_at" IS NOT NULL) AND ("source_images"."status" <> 'DELETED' OR ("source_images"."delete_pending_at" IS NOT NULL AND "source_images"."deleted_at" IS NOT NULL)))
);
--> statement-breakpoint
ALTER TABLE "ocr_jobs" ALTER COLUMN "image_path" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ocr_jobs" ADD COLUMN "source_image_id" text;--> statement-breakpoint
ALTER TABLE "ocr_jobs" ADD COLUMN "queue_schema_version" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "ocr_jobs" ADD COLUMN "available_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "ocr_jobs" ADD COLUMN "attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "ocr_jobs" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "ocr_jobs" ADD COLUMN "lease_token" uuid;--> statement-breakpoint
ALTER TABLE "ocr_jobs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ocr_jobs" ADD COLUMN "lease_fencing_token" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ocr_queue_outbox" ADD COLUMN "schema_version" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "ocr_queue_outbox" ADD COLUMN "claim_token" uuid;--> statement-breakpoint
ALTER TABLE "source_images" ADD CONSTRAINT "source_images_owner_account_id_momo_login_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."momo_login_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "source_images_owner_idempotency_unique" ON "source_images" USING btree ("owner_account_id","idempotency_key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "source_images_object_key_unique" ON "source_images" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "source_images_status_updated_at_idx" ON "source_images" USING btree ("status","updated_at");--> statement-breakpoint
ALTER TABLE "ocr_jobs" ADD CONSTRAINT "ocr_jobs_source_image_id_source_images_id_fk" FOREIGN KEY ("source_image_id") REFERENCES "public"."source_images"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ocr_jobs_source_image_id_idx" ON "ocr_jobs" USING btree ("source_image_id");--> statement-breakpoint
CREATE INDEX "ocr_jobs_claimable_idx" ON "ocr_jobs" USING btree ("status","available_at");--> statement-breakpoint
ALTER TABLE "ocr_jobs" ADD CONSTRAINT "ocr_jobs_queue_schema_version_check" CHECK ("ocr_jobs"."queue_schema_version" IN (1, 2));--> statement-breakpoint
ALTER TABLE "ocr_jobs" ADD CONSTRAINT "ocr_jobs_input_contract_check" CHECK (("ocr_jobs"."queue_schema_version" = 1 AND "ocr_jobs"."image_path" IS NOT NULL) OR ("ocr_jobs"."queue_schema_version" = 2 AND "ocr_jobs"."source_image_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "ocr_jobs" ADD CONSTRAINT "ocr_jobs_attempt_count_check" CHECK ("ocr_jobs"."attempt_count" >= 0);--> statement-breakpoint
ALTER TABLE "ocr_jobs" ADD CONSTRAINT "ocr_jobs_lease_fencing_token_check" CHECK ("ocr_jobs"."lease_fencing_token" >= 0);--> statement-breakpoint
ALTER TABLE "ocr_jobs" ADD CONSTRAINT "ocr_jobs_lease_shape_check" CHECK (("ocr_jobs"."attempt_id" IS NULL AND "ocr_jobs"."lease_owner" IS NULL AND "ocr_jobs"."lease_token" IS NULL AND "ocr_jobs"."lease_expires_at" IS NULL) OR ("ocr_jobs"."attempt_id" IS NOT NULL AND "ocr_jobs"."lease_owner" IS NOT NULL AND "ocr_jobs"."lease_token" IS NOT NULL AND "ocr_jobs"."lease_expires_at" IS NOT NULL AND "ocr_jobs"."lease_fencing_token" >= 1));--> statement-breakpoint
ALTER TABLE "ocr_queue_outbox" ADD CONSTRAINT "ocr_queue_outbox_schema_version_check" CHECK ("ocr_queue_outbox"."schema_version" IN (1, 2));
