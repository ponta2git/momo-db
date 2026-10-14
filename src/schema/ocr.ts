import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { momoLoginAccounts } from "./identity.js";

export const ocrDrafts = pgTable(
  "ocr_drafts",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").notNull(),
    requestedScreenType: text("requested_screen_type").notNull(),
    detectedScreenType: text("detected_screen_type"),
    profileId: text("profile_id"),
    payloadJson: jsonb("payload_json")
      .notNull()
      .default(sql`'{}'::jsonb`),
    warningsJson: jsonb("warnings_json")
      .notNull()
      .default(sql`'[]'::jsonb`),
    timingsMsJson: jsonb("timings_ms_json")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    uniqueIndex("ocr_drafts_job_id_unique").on(table.jobId),
    check(
      "ocr_drafts_payload_json_object_check",
      sql`jsonb_typeof(${table.payloadJson}) = 'object'`
    ),
    check(
      "ocr_drafts_warnings_json_array_check",
      sql`jsonb_typeof(${table.warningsJson}) = 'array'`
    ),
    check(
      "ocr_drafts_timings_ms_json_object_check",
      sql`jsonb_typeof(${table.timingsMsJson}) = 'object'`
    )
  ]
);

export const SOURCE_IMAGE_STATUSES = [
  "RESERVED",
  "AVAILABLE",
  "DELETE_PENDING",
  "DELETED",
  "FAILED"
] as const;

export type SourceImageStatus = (typeof SOURCE_IMAGE_STATUSES)[number];

// source-of-truth: object storage 上のOCR入力画像を指すprovider非依存metadata。
//   object_keyはprivate objectのopaque keyだけを保持し、bucket URLやcredentialは保存しない。
//   idempotency_key_hashでupload reservationを一意化し、process crash後も同じkeyへ収束させる。
export const sourceImages = pgTable(
  "source_images",
  {
    id: text("id").primaryKey(),
    ownerAccountId: text("owner_account_id")
      .notNull()
      .references(() => momoLoginAccounts.id, { onDelete: "restrict" }),
    objectKey: text("object_key").notNull(),
    idempotencyKeyHash: text("idempotency_key_hash").notNull(),
    status: text("status").notNull().default("RESERVED"),
    mediaType: text("media_type"),
    byteLength: integer("byte_length"),
    sha256Hex: text("sha256_hex"),
    width: integer("width"),
    height: integer("height"),
    storageEtag: text("storage_etag"),
    failureCode: text("failure_code"),
    availableAt: timestamp("available_at", { withTimezone: true }),
    deletePendingAt: timestamp("delete_pending_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    uniqueIndex("source_images_owner_idempotency_unique").on(
      table.ownerAccountId,
      table.idempotencyKeyHash
    ),
    uniqueIndex("source_images_object_key_unique").on(table.objectKey),
    index("source_images_status_updated_at_idx").on(
      table.status,
      table.updatedAt
    ),
    check(
      "source_images_status_check",
      sql`${table.status} IN ('RESERVED','AVAILABLE','DELETE_PENDING','DELETED','FAILED')`
    ),
    check(
      "source_images_object_key_check",
      sql`length(${table.objectKey}) BETWEEN 1 AND 512 AND ${table.objectKey} !~ '(^/|://|(^|/)\\.\\.(/|$))'`
    ),
    check(
      "source_images_idempotency_hash_check",
      sql`${table.idempotencyKeyHash} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "source_images_media_type_check",
      sql`${table.mediaType} IS NULL OR ${table.mediaType} IN ('image/png','image/jpeg','image/webp')`
    ),
    check(
      "source_images_byte_length_check",
      sql`${table.byteLength} IS NULL OR ${table.byteLength} BETWEEN 1 AND 3145728`
    ),
    check(
      "source_images_dimensions_check",
      sql`(${table.width} IS NULL AND ${table.height} IS NULL) OR (${table.width} IS NOT NULL AND ${table.height} IS NOT NULL AND ${table.width} BETWEEN 1 AND 1920 AND ${table.height} BETWEEN 1 AND 1080)`
    ),
    check(
      "source_images_sha256_check",
      sql`${table.sha256Hex} IS NULL OR ${table.sha256Hex} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "source_images_available_metadata_check",
      sql`${table.status} NOT IN ('AVAILABLE','DELETE_PENDING','DELETED') OR (${table.mediaType} IS NOT NULL AND ${table.byteLength} IS NOT NULL AND ${table.sha256Hex} IS NOT NULL AND ${table.width} IS NOT NULL AND ${table.height} IS NOT NULL AND ${table.availableAt} IS NOT NULL)`
    ),
    check(
      "source_images_deletion_state_check",
      sql`(${table.status} <> 'DELETE_PENDING' OR ${table.deletePendingAt} IS NOT NULL) AND (${table.status} <> 'DELETED' OR (${table.deletePendingAt} IS NOT NULL AND ${table.deletedAt} IS NOT NULL))`
    )
  ]
);

export const ocrJobs = pgTable(
  "ocr_jobs",
  {
    id: text("id").primaryKey(),
    draftId: text("draft_id").notNull(),
    imageId: text("image_id").notNull(),
    // Retained for historical local-input jobs; new jobs use sourceImageId and inputSnapshot.
    imagePath: text("image_path"),
    sourceImageId: text("source_image_id").references(() => sourceImages.id, {
      onDelete: "restrict"
    }),
    requestedScreenType: text("requested_screen_type").notNull(),
    detectedScreenType: text("detected_screen_type"),
    status: text("status").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    // Accepted input is immutable; execution state and retry budgets live separately.
    inputSnapshot: jsonb("input_snapshot"),
    failureRetryCount: integer("failure_retry_count").notNull().default(0),
    leaseRecoveryCount: integer("lease_recovery_count").notNull().default(0),
    workerId: text("worker_id"),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    attemptId: uuid("attempt_id"),
    leaseOwner: text("lease_owner"),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    leaseFencingToken: bigint("lease_fencing_token", { mode: "number" })
      .notNull()
      .default(0),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    failureRetryable: boolean("failure_retryable"),
    failureUserAction: text("failure_user_action"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    uniqueIndex("ocr_jobs_draft_id_unique").on(table.draftId),
    index("ocr_jobs_status_created_at_idx").on(table.status, table.createdAt),
    index("ocr_jobs_image_id_idx").on(table.imageId),
    index("ocr_jobs_source_image_id_idx").on(table.sourceImageId),
    index("ocr_jobs_claimable_idx")
      .on(table.availableAt, table.createdAt, table.id)
      .where(sql`${table.status} = 'queued'`),
    check(
      "ocr_jobs_input_snapshot_check",
      sql`(${table.inputSnapshot} IS NULL AND ${table.status} IN ('succeeded','failed','cancelled')) OR (${table.inputSnapshot} IS NOT NULL AND jsonb_typeof(${table.inputSnapshot}) = 'object' AND COALESCE(${table.inputSnapshot}->'schemaVersion' = '"2"'::jsonb, false) AND ${table.sourceImageId} IS NOT NULL)`
    ),
    check(
      "ocr_jobs_retry_counts_check",
      sql`${table.failureRetryCount} >= 0 AND ${table.leaseRecoveryCount} >= 0`
    ),
    check(
      "ocr_jobs_attempt_count_check",
      sql`${table.attemptCount} >= 0`
    ),
    check(
      "ocr_jobs_lease_fencing_token_check",
      sql`${table.leaseFencingToken} >= 0`
    ),
    check(
      "ocr_jobs_lease_shape_check",
      sql`(${table.attemptId} IS NULL AND ${table.leaseOwner} IS NULL AND ${table.leaseToken} IS NULL AND ${table.leaseExpiresAt} IS NULL) OR (${table.attemptId} IS NOT NULL AND ${table.leaseOwner} IS NOT NULL AND ${table.leaseToken} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL AND ${table.leaseFencingToken} >= 1)`
    )
  ]
);

export const OCR_SUBMISSION_STATUSES = ["open", "settled", "aborted"] as const;

export type OcrSubmissionStatus = (typeof OCR_SUBMISSION_STATUSES)[number];

// A fixed reading operation. Applications own admission, settlement and notification policy.
// match_draft_id is retained identity, not a FK: deleting a draft must preserve replay fencing.
export const ocrSubmissions = pgTable(
  "ocr_submissions",
  {
    id: text("id").primaryKey(),
    ownerAccountId: text("owner_account_id").notNull()
      .references(() => momoLoginAccounts.id, { onDelete: "restrict" }),
    matchDraftId: text("match_draft_id").notNull(),
    ocrHintsJson: jsonb("ocr_hints_json").notNull().default(sql`'{}'::jsonb`),
    status: text("status").notNull().default("open"),
    admissionDeadline: timestamp("admission_deadline", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true })
  },
  (table) => [
    index("ocr_submissions_status_id_idx").on(table.status, table.id),
    index("ocr_submissions_status_deadline_idx").on(table.status, table.admissionDeadline, table.id),
    index("ocr_submissions_owner_status_idx").on(table.ownerAccountId, table.status),
    index("ocr_submissions_draft_status_idx").on(table.matchDraftId, table.status),
    check("ocr_submissions_id_check", sql`length(${table.id}) = 36 AND ${table.id} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`),
    check("ocr_submissions_hints_object_check", sql`jsonb_typeof(${table.ocrHintsJson}) = 'object'`),
    check("ocr_submissions_status_check", sql`${table.status} IN ('open','settled','aborted')`),
    check("ocr_submissions_terminal_shape_check", sql`(${table.status} = 'open' AND ${table.finishedAt} IS NULL) OR (${table.status} IN ('settled','aborted') AND ${table.finishedAt} IS NOT NULL)`),
    check("ocr_submissions_time_check", sql`${table.admissionDeadline} > ${table.createdAt} AND (${table.finishedAt} IS NULL OR ${table.finishedAt} >= ${table.createdAt})`)
  ]
);

export const OCR_SUBMISSION_MEMBER_STATUSES = ["pending", "registered", "failed"] as const;

export type OcrSubmissionMemberStatus = (typeof OCR_SUBMISSION_MEMBER_STATUSES)[number];

// OCR outcomes remain in ocr_jobs. No outcome counters, payload outbox or delivery state here.
export const ocrSubmissionMembers = pgTable(
  "ocr_submission_members",
  {
    submissionId: text("submission_id").notNull()
      .references(() => ocrSubmissions.id, { onDelete: "cascade" }),
    screenType: text("screen_type").notNull(),
    uploadIdempotencyKeyHash: text("upload_idempotency_key_hash").notNull(),
    imageSha256Hex: text("image_sha256_hex").notNull(),
    imageByteLength: integer("image_byte_length").notNull(),
    status: text("status").notNull().default("pending"),
    jobId: text("job_id").references(() => ocrJobs.id, { onDelete: "restrict" }),
    failureCode: text("failure_code")
  },
  (table) => [
    primaryKey({ columns: [table.submissionId, table.screenType] }),
    uniqueIndex("ocr_submission_members_job_unique").on(table.jobId),
    uniqueIndex("ocr_submission_members_upload_unique").on(table.submissionId, table.uploadIdempotencyKeyHash),
    index("ocr_submission_members_upload_hash_idx").on(table.uploadIdempotencyKeyHash),
    check("ocr_submission_members_screen_check", sql`${table.screenType} IN ('total_assets','revenue','incident_log')`),
    check("ocr_submission_members_hashes_check", sql`length(${table.uploadIdempotencyKeyHash}) = 64 AND ${table.uploadIdempotencyKeyHash} ~ '^[0-9a-f]{64}$' AND length(${table.imageSha256Hex}) = 64 AND ${table.imageSha256Hex} ~ '^[0-9a-f]{64}$'`),
    check("ocr_submission_members_bytes_check", sql`${table.imageByteLength} BETWEEN 1 AND 3145728`),
    check("ocr_submission_members_shape_check", sql`(${table.status} = 'pending' AND ${table.jobId} IS NULL AND ${table.failureCode} IS NULL) OR (${table.status} = 'registered' AND ${table.jobId} IS NOT NULL AND ${table.failureCode} IS NULL) OR (${table.status} = 'failed' AND ${table.jobId} IS NULL AND ${table.failureCode} IS NOT NULL AND ${table.failureCode} IN ('admission_failed','admission_timeout'))`)
  ]
);
