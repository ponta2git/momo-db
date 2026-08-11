import {
  bigint,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType() {
    return "bytea";
  }
});

export const members = pgTable("members", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().unique(),
  displayName: varchar("display_name", { length: 32 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow()
});

export const momoLoginAccounts = pgTable(
  "momo_login_accounts",
  {
    id: text("id").primaryKey(),
    discordUserId: text("discord_user_id").notNull().unique(),
    displayName: varchar("display_name", { length: 64 }).notNull(),
    playerMemberId: text("player_member_id").references(() => members.id, {
      onDelete: "restrict"
    }),
    loginEnabled: boolean("login_enabled").notNull().default(true),
    isAdmin: boolean("is_admin").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    index("momo_login_accounts_player_member_id_idx").on(table.playerMemberId),
    index("momo_login_accounts_login_enabled_idx").on(table.loginEnabled),
    index("momo_login_accounts_is_admin_idx").on(table.isAdmin)
  ]
);

export const appSessions = pgTable(
  "app_sessions",
  {
    idHash: text("id_hash").primaryKey(),
    memberId: text("member_id"),
    accountId: text("account_id")
      .notNull()
      .references(() => momoLoginAccounts.id, { onDelete: "cascade" }),
    csrfSecretHash: text("csrf_secret_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull()
  },
  (table) => [
    index("app_sessions_member_id_idx").on(table.memberId),
    index("app_sessions_account_id_idx").on(table.accountId),
    index("app_sessions_expires_at_idx").on(table.expiresAt)
  ]
);

// source-of-truth: HTTP Idempotency-Key の処理結果キャッシュ。
//   POST 再送時に同じ account/endpoint/key へ保存済みレスポンスを返し、副作用の二重発生を防ぐ。
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    key: text("key").notNull(),
    memberId: text("member_id").references(() => members.id),
    accountId: text("account_id")
      .notNull()
      .references(() => momoLoginAccounts.id),
    endpoint: text("endpoint").notNull(),
    requestHash: bytea("request_hash").notNull(),
    responseStatus: integer("response_status").notNull(),
    responseHeaders: jsonb("response_headers")
      .notNull()
      .default(sql`'{}'::jsonb`),
    responseBody: bytea("response_body"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull()
  },
  (table) => [
    primaryKey({ columns: [table.key, table.accountId, table.endpoint] }),
    index("idempotency_keys_account_expires_at_idx").on(
      table.accountId,
      table.expiresAt
    ),
    index("idempotency_keys_expires_at_idx").on(table.expiresAt)
  ]
);

export const SESSION_STATUSES = [
  "ASKING",
  "POSTPONE_VOTING",
  "POSTPONED",
  "DECIDED",
  "CANCELLED",
  "COMPLETED",
  "SKIPPED"
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const RESPONSE_CHOICES = [
  "T2200",
  "T2230",
  "T2300",
  "T2330",
  "ABSENT",
  "POSTPONE_OK",
  "POSTPONE_NG"
] as const;

export type ResponseChoice = (typeof RESPONSE_CHOICES)[number];

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    weekKey: text("week_key").notNull(),
    postponeCount: integer("postpone_count").notNull().default(0),
    // why: `Iso` suffix で文字列日付型を名前から識別可能にする。 @see ADR-0014
    candidateDateIso: date("candidate_date_iso", { mode: "string" }).notNull(),
    status: text("status").notNull(),
    channelId: text("channel_id").notNull(),
    askMessageId: text("ask_message_id"),
    postponeMessageId: text("postpone_message_id"),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    decidedStartAt: timestamp("decided_start_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    reminderAt: timestamp("reminder_at", { withTimezone: true }),
    reminderSentAt: timestamp("reminder_sent_at", { withTimezone: true }),
    // optimistic sequence for aggregate mutations and ordered side-effect intents.
    revision: bigint("revision", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    // unique: 金 Session (postponeCount=0) と土 Session (postponeCount=1) が週キーを共有するため
    //   複合で 0..1 件に制約。race 時は制約違反 → 呼び出し側が findSessionByWeekKeyAndPostponeCount で再取得。
    uniqueIndex("sessions_week_key_postpone_count_unique").on(
      table.weekKey,
      table.postponeCount
    ),
    // invariant: status を SESSION_STATUSES と DB CHECK で二重ガードし drizzle 型との乖離を防ぐ。
    check(
      "sessions_status_check",
      sql`${table.status} IN ('ASKING','POSTPONE_VOTING','POSTPONED','DECIDED','CANCELLED','COMPLETED','SKIPPED')`
    ),
    // invariant: 順延は 1 回まで (金 → 土)。 @see requirements/base.md §4
    check(
      "sessions_postpone_count_check",
      sql`${table.postponeCount} IN (0, 1)`
    ),
    check("sessions_revision_check", sql`${table.revision} >= 0`),
    // why: findDueAskingSessions / findDuePostponeVotingSessions の `WHERE status IN (...) AND deadline_at <= now`
    //   を prefix/range scan で支援するため status を leading column に置いた composite index。
    index("idx_sessions_status_deadline").on(table.status, table.deadlineAt),
    // why: findDueReminderSessions の `status='DECIDED' AND reminder_sent_at IS NULL AND reminder_at <= now`
    //   を prefix scan で支援する composite index。
    index("idx_sessions_status_reminder").on(
      table.status,
      table.reminderSentAt,
      table.reminderAt
    )
  ]
);

export const responses = pgTable(
  "responses",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    memberId: text("member_id")
      .notNull()
      .references(() => members.id),
    choice: text("choice").notNull(),
    answeredAt: timestamp("answered_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Discord snowflake of the interaction that produced the current response.
    // Numeric ordering rejects delayed retries that arrive after a newer interaction.
    sourceInteractionId: numeric("source_interaction_id", {
      precision: 20,
      scale: 0
    })
  },
  (table) => [
    // unique: (sessionId, memberId) で二重回答を排除。Session aggregate command が
    //   sourceInteractionId の単調性を確認して最新 choice に上書きする。
    uniqueIndex("responses_session_member_unique").on(
      table.sessionId,
      table.memberId
    ),
    // invariant: choice を RESPONSE_CHOICES と DB CHECK で二重ガード。
    check(
      "responses_choice_check",
      sql`${table.choice} IN ('T2200','T2230','T2300','T2330','ABSENT','POSTPONE_OK','POSTPONE_NG')`
    )
  ]
);

// source-of-truth: 実開催履歴 (§8.3)。中止回 (§8.4) では作成しない。
//   DECIDED→COMPLETED CAS と同一 tx で挿入し、「COMPLETED なのに HeldEvent 無し」の
//   永続不整合を回避する (COMPLETED は終端のため起動時リカバリが拾わない)。
export const heldEvents = pgTable("held_events", {
  id: text("id").primaryKey(),
  // why: summit の Discord 出席 session に紐づく held_event は session_id を持つ。
  //   momo-result が単独で作成した ad-hoc 開催履歴は session_id NULL になる。
  // unique: NULL 以外は 1 Session につき 1 HeldEvent。
  //   summit の DECIDED→COMPLETED CAS との onConflictDoNothing anchor として必要。
  sessionId: text("session_id")
    .unique()
    .references(() => sessions.id, { onDelete: "cascade" }),
  // why: `Iso` suffix で文字列日付型を明示 (ADR-0014)。summit 作成時は session.candidate_date_iso と一致。
  heldDateIso: date("held_date_iso", { mode: "string" }).notNull(),
  startAt: timestamp("start_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow()
});

// source-of-truth: 開催ごとの参加メンバースナップショット (§8.3)。
//   user config の members は「今の設定」であり「その開催の実参加」ではないため、
//   開催時点の responses から派生させた snapshot を保持する。
export const heldEventParticipants = pgTable(
  "held_event_participants",
  {
    heldEventId: text("held_event_id")
      .notNull()
      .references(() => heldEvents.id, { onDelete: "cascade" }),
    memberId: text("member_id")
      .notNull()
      .references(() => members.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    primaryKey({ columns: [table.heldEventId, table.memberId] })
  ]
);

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
    // v1 local worker input。queue_schema_version=2ではsource_image_idを正本にする。
    imagePath: text("image_path"),
    sourceImageId: text("source_image_id").references(() => sourceImages.id, {
      onDelete: "restrict"
    }),
    queueSchemaVersion: smallint("queue_schema_version").notNull().default(1),
    requestedScreenType: text("requested_screen_type").notNull(),
    detectedScreenType: text("detected_screen_type"),
    status: text("status").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
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
    index("ocr_jobs_claimable_idx").on(table.status, table.availableAt),
    check(
      "ocr_jobs_queue_schema_version_check",
      sql`${table.queueSchemaVersion} IN (1, 2)`
    ),
    check(
      "ocr_jobs_input_contract_check",
      sql`(${table.queueSchemaVersion} = 1 AND ${table.imagePath} IS NOT NULL) OR (${table.queueSchemaVersion} = 2 AND ${table.sourceImageId} IS NOT NULL)`
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

export const OCR_QUEUE_OUTBOX_STATUSES = [
  "PENDING",
  "IN_FLIGHT",
  "DELIVERED",
  "FAILED"
] as const;
export type OcrQueueOutboxStatus =
  (typeof OCR_QUEUE_OUTBOX_STATUSES)[number];

// source-of-truth: OCR Redis Streams enqueue intent の durable outbox。
//   OCR job 作成 tx 内で enqueue intent を永続化し、commit 後 crash 時も再 publish できる。
export const ocrQueueOutbox = pgTable(
  "ocr_queue_outbox",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => ocrJobs.id),
    // unique: 1 job 1 enqueue intent の決定論キー。通常は `ocr-job:${jobId}`。
    dedupeKey: text("dedupe_key").notNull(),
    // source-of-truth: Redis Stream に送る key/value payload を request 時点の値で保持する。
    streamPayload: jsonb("stream_payload").notNull(),
    schemaVersion: smallint("schema_version").notNull().default(1),
    status: text("status").notNull().default("PENDING"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    claimToken: uuid("claim_token"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    redisMessageId: text("redis_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    check(
      "ocr_queue_outbox_stream_payload_object_check",
      sql`jsonb_typeof(${table.streamPayload}) = 'object'`
    ),
    check(
      "ocr_queue_outbox_status_check",
      sql`${table.status} IN ('PENDING','IN_FLIGHT','DELIVERED','FAILED')`
    ),
    check(
      "ocr_queue_outbox_attempt_count_check",
      sql`${table.attemptCount} >= 0`
    ),
    check(
      "ocr_queue_outbox_schema_version_check",
      sql`${table.schemaVersion} IN (1, 2)`
    ),
    uniqueIndex("uq_ocr_queue_outbox_dedupe_active")
      .on(table.dedupeKey)
      .where(sql`status IN ('PENDING','IN_FLIGHT','DELIVERED')`),
    index("idx_ocr_queue_outbox_status_next").on(
      table.status,
      table.nextAttemptAt
    ),
    index("idx_ocr_queue_outbox_job_id").on(table.jobId)
  ]
);

// source-of-truth: Discord 送信の at-least-once 配送キュー。状態遷移 tx で enqueue し、
//   worker が非同期配送。crash 中でも DB 正本のまま再試行される。 @see summit ADR-0051
export const OUTBOX_KINDS = ["send_message"] as const;
export type OutboxKind = (typeof OUTBOX_KINDS)[number];

export const OUTBOX_STATUSES = [
  "PENDING",
  "IN_FLIGHT",
  "DELIVERED",
  "FAILED",
  "CANCELLED"
] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export const discordOutbox = pgTable(
  "discord_outbox",
  {
    id: text("id").primaryKey(),
    // source-of-truth: 副作用種別。OUTBOX_KINDS と DB CHECK で二重ガード。
    kind: text("kind").notNull(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    // why: 送信時に必要な全情報 (channelId / renderer hint / target 列など) を埋め込む。
    //   rehydration は worker 側で担当する。
    payload: jsonb("payload").notNull(),
    // unique: 同じ intent の二重 enqueue を status / Session を問わず防ぐ決定論キー。
    //   状態遷移 tx 内で onConflictDoNothing に渡し、FAILED も同じ row を回復させる。
    dedupeKey: text("dedupe_key").notNull(),
    status: text("status").notNull().default("PENDING"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    // race: worker の claim で IN_FLIGHT + claim_expires_at=now+ttl をセット。
    //   reconciler は expire 済み IN_FLIGHT を PENDING に戻して reclaim する。
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    // fencing token: claim の所有者だけが delivered / failed を確定できる。
    claimToken: uuid("claim_token"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    // source-of-truth: 配送成功時の Discord message id。
    //   payload.target が指す sessions 列 (askMessageId / postponeMessageId) に worker が書き戻す。
    deliveredMessageId: text("delivered_message_id"),
    // Session aggregate 内の副作用順序。revision は状態更新ごと、ordinal は同一更新内の順番。
    aggregateRevision: bigint("aggregate_revision", { mode: "number" })
      .notNull()
      .default(0),
    ordinal: smallint("ordinal").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    // invariant: kind を OUTBOX_KINDS と DB CHECK で二重ガード。
    check(
      "discord_outbox_kind_check",
      sql`${table.kind} = 'send_message'`
    ),
    check(
      "discord_outbox_status_check",
      sql`${table.status} IN ('PENDING','IN_FLIGHT','DELIVERED','FAILED','CANCELLED')`
    ),
    check(
      "discord_outbox_aggregate_revision_check",
      sql`${table.aggregateRevision} >= 0`
    ),
    check("discord_outbox_ordinal_check", sql`${table.ordinal} >= 0`),
    // unique: intent の状態を問わず同じ dedupe_key は 1 行だけ。FAILED は同じ行を復帰させる。
    uniqueIndex("uq_discord_outbox_dedupe")
      .on(table.dedupeKey),
    // why: claimNextBatch の `status IN ('PENDING','IN_FLIGHT') AND next_attempt_at <= now` を prefix で支援。
    index("idx_discord_outbox_status_next").on(
      table.status,
      table.nextAttemptAt
    ),
    uniqueIndex("uq_discord_outbox_session_order").on(
      table.sessionId,
      table.aggregateRevision,
      table.ordinal
    )
  ]
);

// ---------------------------------------------------------------------------
// momo-result: 桃鉄 1 年勝負の結果記録 (matches / players / incidents) と
//   関連マスタ (game_titles / map_masters / season_masters / incident_masters /
//   member_aliases)。要件は momo-result/requirements/base.md を参照。
// ---------------------------------------------------------------------------

// source-of-truth: 作品 (例: 桃太郎電鉄2、桃太郎電鉄ワールド、桃太郎電鉄〜昭和 平成 令和も定番〜)。
//   layout_family は OCR プロファイル (apps/ocr-worker/src/momo_ocr_worker/profiles) と整合。
export const gameTitles = pgTable(
  "game_titles",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    // why: OCR profile family と一致させる識別子。例: "momotetsu_2", "world", "reiwa"。
    layoutFamily: text("layout_family").notNull(),
    displayOrder: integer("display_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [uniqueIndex("game_titles_name_unique").on(table.name)]
);

// source-of-truth: マップ。作品ごとに別マップを持つため (gameTitleId, name) で unique。
export const mapMasters = pgTable(
  "map_masters",
  {
    id: text("id").primaryKey(),
    gameTitleId: text("game_title_id")
      .notNull()
      .references(() => gameTitles.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    displayOrder: integer("display_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    uniqueIndex("map_masters_title_name_unique").on(
      table.gameTitleId,
      table.name
    )
  ]
);

// source-of-truth: シーズン (作品内の年度・キャンペーン区分)。
export const seasonMasters = pgTable(
  "season_masters",
  {
    id: text("id").primaryKey(),
    gameTitleId: text("game_title_id")
      .notNull()
      .references(() => gameTitles.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    displayOrder: integer("display_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    uniqueIndex("season_masters_title_name_unique").on(
      table.gameTitleId,
      table.name
    )
  ]
);

// source-of-truth: 桃鉄事件名マスタ。
//   MVP では 6 項目固定 (目的地 / プラス駅 / マイナス駅 / カード駅 / カード売り場 / スリの銀次)。
//   key は安定したスネークケース識別子。display_name は日本語表示。
export const incidentMasters = pgTable(
  "incident_masters",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    displayName: text("display_name").notNull(),
    displayOrder: integer("display_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [uniqueIndex("incident_masters_key_unique").on(table.key)]
);

// source-of-truth: OCR で読み取ったプレーヤー名と members の対応辞書。
//   1 member に複数 alias を許容する。
export const memberAliases = pgTable(
  "member_aliases",
  {
    id: text("id").primaryKey(),
    memberId: text("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    alias: text("alias").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    uniqueIndex("member_aliases_member_alias_unique").on(
      table.memberId,
      table.alias
    ),
    index("member_aliases_alias_idx").on(table.alias)
  ]
);

export const MATCH_DRAFT_STATUSES = [
  "ocr_running",
  "ocr_failed",
  "draft_ready",
  "needs_review",
  "confirmed",
  "cancelled"
] as const;

export type MatchDraftStatus = (typeof MATCH_DRAFT_STATUSES)[number];

// source-of-truth: 確定前の試合作業単位。
//   matches は確定済み専用のため、未入力許容の作業状態は match_drafts に保持する。
export const matchDrafts = pgTable(
  "match_drafts",
  {
    id: text("id").primaryKey(),
    createdByMemberId: text("created_by_member_id")
      .references(() => members.id, { onDelete: "restrict" }),
    createdByAccountId: text("created_by_account_id")
      .notNull()
      .references(() => momoLoginAccounts.id, { onDelete: "restrict" }),
    status: text("status").notNull(),
    heldEventId: text("held_event_id").references(() => heldEvents.id, {
      onDelete: "restrict"
    }),
    matchNoInEvent: integer("match_no_in_event"),
    gameTitleId: text("game_title_id").references(() => gameTitles.id, {
      onDelete: "restrict"
    }),
    // why: gameTitles.layoutFamily の冗長コピー。下書き時点の OCR profile family を固定する。
    layoutFamily: text("layout_family"),
    seasonMasterId: text("season_master_id").references(() => seasonMasters.id, {
      onDelete: "restrict"
    }),
    ownerMemberId: text("owner_member_id").references(() => members.id, {
      onDelete: "restrict"
    }),
    mapMasterId: text("map_master_id").references(() => mapMasters.id, {
      onDelete: "restrict"
    }),
    playedAt: timestamp("played_at", { withTimezone: true }),
    // why: image store の opaque id。内部 path/bucket は保持しない。
    totalAssetsImageId: text("total_assets_image_id"),
    revenueImageId: text("revenue_image_id"),
    incidentLogImageId: text("incident_log_image_id"),
    // why: 確定前に参照する OCR draft id。ocr_drafts cleanup を許容するため FK は張らない。
    totalAssetsDraftId: text("total_assets_draft_id"),
    revenueDraftId: text("revenue_draft_id"),
    incidentLogDraftId: text("incident_log_draft_id"),
    sourceImagesRetainedUntil: timestamp("source_images_retained_until", {
      withTimezone: true
    }),
    sourceImagesDeletedAt: timestamp("source_images_deleted_at", {
      withTimezone: true
    }),
    confirmedMatchId: text("confirmed_match_id").references(() => matches.id, {
      onDelete: "set null"
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    check(
      "match_drafts_status_check",
      sql`${table.status} IN ('ocr_running','ocr_failed','draft_ready','needs_review','confirmed','cancelled')`
    ),
    check(
      "match_drafts_match_no_in_event_check",
      sql`${table.matchNoInEvent} IS NULL OR ${table.matchNoInEvent} >= 1`
    ),
    index("match_drafts_status_updated_at_idx").on(table.status, table.updatedAt),
    index("match_drafts_created_by_status_idx").on(
      table.createdByMemberId,
      table.status
    ),
    index("match_drafts_created_by_account_status_idx").on(
      table.createdByAccountId,
      table.status
    ),
    index("match_drafts_held_event_id_idx").on(table.heldEventId),
    uniqueIndex("match_drafts_confirmed_match_id_unique").on(
      table.confirmedMatchId
    )
  ]
);

// source-of-truth: 確定済み試合 (1 試合 = 1 行)。
//   開催履歴 (held_events) 内で match_no_in_event の 1-origin 連番。
export const matches = pgTable(
  "matches",
  {
    id: text("id").primaryKey(),
    heldEventId: text("held_event_id")
      .notNull()
      .references(() => heldEvents.id, { onDelete: "restrict" }),
    matchNoInEvent: integer("match_no_in_event").notNull(),
    gameTitleId: text("game_title_id")
      .notNull()
      .references(() => gameTitles.id, { onDelete: "restrict" }),
    // why: gameTitles.layoutFamily の冗長コピー。OCR profile family を結果に固定するため。
    //   作品名変更時にも過去結果の解析プロファイルが追跡できる。
    layoutFamily: text("layout_family").notNull(),
    seasonMasterId: text("season_master_id")
      .notNull()
      .references(() => seasonMasters.id, { onDelete: "restrict" }),
    ownerMemberId: text("owner_member_id")
      .notNull()
      .references(() => members.id, { onDelete: "restrict" }),
    mapMasterId: text("map_master_id")
      .notNull()
      .references(() => mapMasters.id, { onDelete: "restrict" }),
    playedAt: timestamp("played_at", { withTimezone: true }).notNull(),
    // why: 確定時点で参照した OCR draft の id を文字列として保持する。
    //   ocr_drafts は将来クリーンアップで削除される可能性があるため FK は張らない (履歴メモ)。
    totalAssetsDraftId: text("total_assets_draft_id"),
    revenueDraftId: text("revenue_draft_id"),
    incidentLogDraftId: text("incident_log_draft_id"),
    createdByMemberId: text("created_by_member_id")
      .references(() => members.id, { onDelete: "restrict" }),
    createdByAccountId: text("created_by_account_id")
      .notNull()
      .references(() => momoLoginAccounts.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // source-of-truth: this confirmed match's analysis-input version. It advances with every
    // mutation that can change a match-context artifact.
    analysisRevision: bigint("analysis_revision", { mode: "bigint" })
      .notNull()
      .default(sql`0`)
  },
  (table) => [
    uniqueIndex("matches_event_match_no_unique").on(
      table.heldEventId,
      table.matchNoInEvent
    ),
    check(
      "matches_match_no_in_event_check",
      sql`${table.matchNoInEvent} >= 1`
    ),
    check(
      "matches_analysis_revision_check",
      sql`${table.analysisRevision} >= 0`
    ),
    index("matches_held_event_id_idx").on(table.heldEventId),
    index("matches_created_by_account_id_idx").on(table.createdByAccountId),
    index("matches_played_at_idx").on(table.playedAt)
  ]
);

// source-of-truth: desired and published analysis state for every registered game title.
// A row is inserted with game_titles and existing titles are backfilled by the introducing migration.
export const seriesAnalysisTitleStates = pgTable(
  "series_analysis_title_states",
  {
    gameTitleId: text("game_title_id")
      .primaryKey()
      .references(() => gameTitles.id, { onDelete: "cascade" }),
    inputRevision: bigint("input_revision", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    algorithmVersion: text("algorithm_version")
      .notNull()
      .default("series-analysis-v1"),
    artifactSchemaVersion: integer("artifact_schema_version")
      .notNull()
      .default(1),
    pendingWork: boolean("pending_work").notNull().default(false),
    pendingForcedRunCount: integer("pending_forced_run_count")
      .notNull()
      .default(0),
    lastFailureCode: text("last_failure_code"),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
    currentArtifactId: text("current_artifact_id"),
    previousArtifactId: text("previous_artifact_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    check(
      "series_analysis_title_states_input_revision_check",
      sql`${table.inputRevision} >= 0`
    ),
    check(
      "series_analysis_title_states_schema_version_check",
      sql`${table.artifactSchemaVersion} >= 1`
    ),
    check(
      "series_analysis_title_states_pending_forced_run_count_check",
      sql`${table.pendingForcedRunCount} >= 0`
    ),
    check(
      "series_analysis_title_states_failure_pair_check",
      sql`(${table.lastFailureCode} IS NULL) = (${table.lastFailureAt} IS NULL)`
    ),
    check(
      "series_analysis_title_states_artifact_pointer_distinct_check",
      sql`${table.currentArtifactId} IS NULL OR ${table.previousArtifactId} IS NULL OR ${table.currentArtifactId} <> ${table.previousArtifactId}`
    ),
    foreignKey({
      columns: [table.currentArtifactId, table.gameTitleId],
      foreignColumns: [
        seriesAnalysisArtifacts.id,
        seriesAnalysisArtifacts.gameTitleId
      ],
      name: "series_analysis_title_states_current_artifact_fk"
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.previousArtifactId, table.gameTitleId],
      foreignColumns: [
        seriesAnalysisArtifacts.id,
        seriesAnalysisArtifacts.gameTitleId
      ],
      name: "series_analysis_title_states_previous_artifact_fk"
    }).onDelete("restrict"),
    index("series_analysis_title_states_pending_work_idx")
      .on(table.updatedAt)
      .where(sql`${table.pendingWork} = true`)
  ]
);

export const seriesAnalysisOperationRequests = pgTable(
  "series_analysis_operation_requests",
  {
    id: text("id").primaryKey(),
    scope: text("scope").notNull(),
    gameTitleId: text("game_title_id"),
    requestedByAccountId: text("requested_by_account_id").references(
      () => momoLoginAccounts.id,
      { onDelete: "set null" }
    ),
    idempotencyKeyHash: text("idempotency_key_hash").notNull(),
    endpoint: text("endpoint").notNull(),
    status: text("status").notNull().default("pending"),
    targetCount: integer("target_count").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true })
  },
  (table) => [
    check(
      "series_analysis_operation_requests_scope_check",
      sql`${table.scope} IN ('title','all_titles')`
    ),
    check(
      "series_analysis_operation_requests_scope_title_check",
      sql`(${table.scope} = 'title' AND ${table.gameTitleId} IS NOT NULL) OR (${table.scope} = 'all_titles' AND ${table.gameTitleId} IS NULL)`
    ),
    check(
      "series_analysis_operation_requests_status_check",
      sql`${table.status} IN ('pending','running','terminal')`
    ),
    check(
      "series_analysis_operation_requests_target_count_check",
      sql`${table.targetCount} >= 0`
    ),
    uniqueIndex("series_analysis_operation_requests_idempotency_unique").on(
      table.requestedByAccountId,
      table.endpoint,
      table.idempotencyKeyHash
    ),
    index("series_analysis_operation_requests_terminal_cleanup_idx")
      .on(table.finishedAt)
      .where(sql`${table.status} = 'terminal'`)
  ]
);

export const seriesAnalysisCampaigns = pgTable(
  "series_analysis_campaigns",
  {
    id: text("id").primaryKey(),
    operationRequestId: text("operation_request_id")
      .notNull()
      .unique()
      .references(() => seriesAnalysisOperationRequests.id, {
        onDelete: "cascade"
      }),
    trigger: text("trigger").notNull(),
    algorithmVersion: text("algorithm_version").notNull(),
    artifactSchemaVersion: integer("artifact_schema_version").notNull(),
    status: text("status").notNull().default("queued"),
    targetCount: integer("target_count").notNull(),
    expandedCount: integer("expanded_count").notNull().default(0),
    terminalCount: integer("terminal_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    acceptedAt: timestamp("accepted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true })
  },
  (table) => [
    check(
      "series_analysis_campaigns_trigger_check",
      sql`${table.trigger} IN ('manual','algorithm_update','artifact_schema_update','initial_backfill')`
    ),
    check(
      "series_analysis_campaigns_status_check",
      sql`${table.status} IN ('queued','expanding','running','terminal')`
    ),
    check(
      "series_analysis_campaigns_schema_version_check",
      sql`${table.artifactSchemaVersion} >= 1`
    ),
    check(
      "series_analysis_campaigns_counts_check",
      sql`${table.targetCount} >= 0 AND ${table.expandedCount} >= 0 AND ${table.terminalCount} >= 0 AND ${table.failedCount} >= 0 AND ${table.skippedCount} >= 0 AND ${table.expandedCount} <= ${table.targetCount} AND ${table.terminalCount} <= ${table.targetCount} AND ${table.failedCount} + ${table.skippedCount} <= ${table.terminalCount}`
    ),
    index("series_analysis_campaigns_status_accepted_idx").on(
      table.status,
      table.acceptedAt
    ),
    index("series_analysis_campaigns_terminal_cleanup_idx")
      .on(table.finishedAt)
      .where(sql`${table.status} = 'terminal'`)
  ]
);

export const seriesAnalysisCampaignTargets = pgTable(
  "series_analysis_campaign_targets",
  {
    campaignId: text("campaign_id")
      .notNull()
      .references(() => seriesAnalysisCampaigns.id, { onDelete: "cascade" }),
    gameTitleId: text("game_title_id").notNull(),
    inputRevision: bigint("input_revision", { mode: "bigint" }).notNull(),
    algorithmVersion: text("algorithm_version")
      .notNull()
      .default("series-analysis-v1"),
    artifactSchemaVersion: integer("artifact_schema_version")
      .notNull()
      .default(1),
    status: text("status").notNull().default("pending"),
    jobRequestId: text("job_request_id"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    primaryKey({ columns: [table.campaignId, table.gameTitleId] }),
    check(
      "series_analysis_campaign_targets_input_revision_check",
      sql`${table.inputRevision} >= 0`
    ),
    check(
      "series_analysis_campaign_targets_schema_version_check",
      sql`${table.artifactSchemaVersion} >= 1`
    ),
    check(
      "series_analysis_campaign_targets_status_check",
      sql`${table.status} IN ('pending','expanded','running','succeeded','failed','skipped_title_deleted')`
    ),
    index("series_analysis_campaign_targets_pending_idx")
      .on(table.acceptedAt, table.campaignId, table.gameTitleId)
      .where(sql`${table.status} = 'pending'`),
    uniqueIndex("series_analysis_campaign_targets_job_request_unique")
      .on(table.jobRequestId)
      .where(sql`${table.jobRequestId} IS NOT NULL`)
  ]
);

export const seriesAnalysisJobs = pgTable(
  "series_analysis_jobs",
  {
    id: text("id").primaryKey(),
    gameTitleId: text("game_title_id")
      .notNull()
      .references(() => gameTitles.id, { onDelete: "cascade" }),
    inputRevision: bigint("input_revision", { mode: "bigint" }).notNull(),
    algorithmVersion: text("algorithm_version").notNull(),
    artifactSchemaVersion: integer("artifact_schema_version").notNull(),
    status: text("status").notNull().default("queued"),
    trigger: text("trigger").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    leaseOwner: text("lease_owner"),
    leaseAttemptId: text("lease_attempt_id"),
    leaseFencingToken: bigint("lease_fencing_token", { mode: "bigint" }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
    transientRetryCount: integer("transient_retry_count").notNull().default(0),
    leaseRecoveryCount: integer("lease_recovery_count").notNull().default(0),
    resultDisposition: text("result_disposition").notNull().default("none"),
    outputChecksum: text("output_checksum"),
    safeFailureCode: text("safe_failure_code"),
    elapsedMilliseconds: bigint("elapsed_milliseconds", { mode: "bigint" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    check(
      "series_analysis_jobs_input_revision_check",
      sql`${table.inputRevision} >= 0`
    ),
    check(
      "series_analysis_jobs_schema_version_check",
      sql`${table.artifactSchemaVersion} >= 1`
    ),
    check(
      "series_analysis_jobs_status_check",
      sql`${table.status} IN ('queued','running','succeeded','failed','timed_out')`
    ),
    check(
      "series_analysis_jobs_trigger_check",
      sql`${table.trigger} IN ('manual','artifact_schema_update','algorithm_update','initial_backfill','match_mutation')`
    ),
    check(
      "series_analysis_jobs_counts_check",
      sql`${table.attemptCount} >= 0 AND ${table.transientRetryCount} BETWEEN 0 AND 3 AND ${table.leaseRecoveryCount} BETWEEN 0 AND 3`
    ),
    check(
      "series_analysis_jobs_result_disposition_check",
      sql`${table.resultDisposition} IN ('published','reused','none')`
    ),
    check(
      "series_analysis_jobs_lease_shape_check",
      sql`(${table.status} = 'running' AND ${table.leaseOwner} IS NOT NULL AND ${table.leaseAttemptId} IS NOT NULL AND ${table.leaseFencingToken} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL) OR (${table.status} <> 'running' AND ${table.leaseOwner} IS NULL AND ${table.leaseAttemptId} IS NULL AND ${table.leaseFencingToken} IS NULL AND ${table.leaseExpiresAt} IS NULL)`
    ),
    check(
      "series_analysis_jobs_terminal_shape_check",
      sql`(${table.status} IN ('succeeded','failed','timed_out')) = (${table.finishedAt} IS NOT NULL)`
    ),
    uniqueIndex("series_analysis_jobs_active_title_unique")
      .on(table.gameTitleId)
      .where(sql`${table.status} IN ('queued','running')`),
    index("series_analysis_jobs_claim_idx")
      .on(table.availableAt, table.requestedAt, table.id)
      .where(sql`${table.status} = 'queued'`),
    index("series_analysis_jobs_terminal_cleanup_idx")
      .on(table.finishedAt)
      .where(sql`${table.status} IN ('succeeded','failed','timed_out')`)
  ]
);

export const seriesAnalysisJobRequests = pgTable(
  "series_analysis_job_requests",
  {
    id: text("id").primaryKey(),
    gameTitleId: text("game_title_id").notNull(),
    operationRequestId: text("operation_request_id").references(
      () => seriesAnalysisOperationRequests.id,
      { onDelete: "cascade" }
    ),
    campaignId: text("campaign_id").references(() => seriesAnalysisCampaigns.id, {
      onDelete: "cascade"
    }),
    inputRevision: bigint("input_revision", { mode: "bigint" }).notNull(),
    algorithmVersion: text("algorithm_version").notNull(),
    artifactSchemaVersion: integer("artifact_schema_version").notNull(),
    trigger: text("trigger").notNull(),
    forceRun: boolean("force_run").notNull().default(false),
    status: text("status").notNull().default("pending"),
    assignedJobId: text("assigned_job_id").references(() => seriesAnalysisJobs.id, {
      onDelete: "set null"
    }),
    assignedAttemptId: text("assigned_attempt_id"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    fulfilledAt: timestamp("fulfilled_at", { withTimezone: true })
  },
  (table) => [
    check(
      "series_analysis_job_requests_input_revision_check",
      sql`${table.inputRevision} >= 0`
    ),
    check(
      "series_analysis_job_requests_schema_version_check",
      sql`${table.artifactSchemaVersion} >= 1`
    ),
    check(
      "series_analysis_job_requests_status_check",
      sql`${table.status} IN ('pending','assigned','fulfilled')`
    ),
    check(
      "series_analysis_job_requests_trigger_check",
      sql`${table.trigger} IN ('manual','artifact_schema_update','algorithm_update','initial_backfill','match_mutation')`
    ),
    check(
      "series_analysis_job_requests_fulfilled_shape_check",
      sql`(${table.status} = 'fulfilled') = (${table.fulfilledAt} IS NOT NULL)`
    ),
    index("series_analysis_job_requests_pending_title_idx")
      .on(table.gameTitleId, table.acceptedAt, table.id)
      .where(sql`${table.status} IN ('pending','assigned')`),
    index("series_analysis_job_requests_attempt_idx")
      .on(table.assignedAttemptId)
      .where(sql`${table.assignedAttemptId} IS NOT NULL`),
    index("series_analysis_job_requests_terminal_cleanup_idx")
      .on(table.fulfilledAt)
      .where(sql`${table.status} = 'fulfilled'`)
  ]
);

export const seriesAnalysisJobAttempts = pgTable(
  "series_analysis_job_attempts",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => seriesAnalysisJobs.id, { onDelete: "cascade" }),
    attemptNo: integer("attempt_no").notNull(),
    owner: text("owner").notNull(),
    fencingToken: bigint("fencing_token", { mode: "bigint" }).notNull(),
    inputRevision: bigint("input_revision", { mode: "bigint" }).notNull(),
    algorithmVersion: text("algorithm_version").notNull(),
    artifactSchemaVersion: integer("artifact_schema_version").notNull(),
    status: text("status").notNull().default("running"),
    outcome: text("outcome"),
    effectiveConfigVersion: text("effective_config_version").notNull(),
    calculationTimeoutMilliseconds: bigint("calculation_timeout_milliseconds", {
      mode: "bigint"
    }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    elapsedMilliseconds: bigint("elapsed_milliseconds", { mode: "bigint" }),
    calculationMilliseconds: bigint("calculation_milliseconds", {
      mode: "bigint"
    }),
    stagingMilliseconds: bigint("staging_milliseconds", { mode: "bigint" }),
    publicationMilliseconds: bigint("publication_milliseconds", {
      mode: "bigint"
    }),
    childPeakBytes: bigint("child_peak_bytes", { mode: "bigint" }),
    workerPeakBytes: bigint("worker_peak_bytes", { mode: "bigint" })
  },
  (table) => [
    uniqueIndex("series_analysis_job_attempts_job_no_unique").on(
      table.jobId,
      table.attemptNo
    ),
    check(
      "series_analysis_job_attempts_positive_check",
      sql`${table.attemptNo} >= 1 AND ${table.fencingToken} >= 1 AND ${table.inputRevision} >= 0 AND ${table.artifactSchemaVersion} >= 1 AND ${table.calculationTimeoutMilliseconds} >= 1`
    ),
    check(
      "series_analysis_job_attempts_status_check",
      sql`${table.status} IN ('running','terminal')`
    ),
    check(
      "series_analysis_job_attempts_terminal_shape_check",
      sql`(${table.status} = 'terminal' AND ${table.outcome} IS NOT NULL AND ${table.finishedAt} IS NOT NULL) OR (${table.status} = 'running' AND ${table.outcome} IS NULL AND ${table.finishedAt} IS NULL)`
    ),
    check(
      "series_analysis_job_attempts_outcome_check",
      sql`${table.outcome} IS NULL OR ${table.outcome} IN ('succeeded','failed','timed_out','superseded','preempted','owner_lost','graceful_stop')`
    ),
    index("series_analysis_job_attempts_running_idx")
      .on(table.startedAt)
      .where(sql`${table.status} = 'running'`)
  ]
);

export const seriesAnalysisWorkerCapabilities = pgTable(
  "series_analysis_worker_capabilities",
  {
    workerId: text("worker_id").primaryKey(),
    algorithmVersions: jsonb("algorithm_versions").notNull(),
    artifactSchemaVersions: jsonb("artifact_schema_versions").notNull(),
    draining: boolean("draining").notNull().default(false),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    check(
      "series_analysis_worker_capabilities_algorithms_array_check",
      sql`jsonb_typeof(${table.algorithmVersions}) = 'array'`
    ),
    check(
      "series_analysis_worker_capabilities_schemas_array_check",
      sql`jsonb_typeof(${table.artifactSchemaVersions}) = 'array'`
    ),
    index("series_analysis_worker_capabilities_heartbeat_idx").on(
      table.heartbeatAt
    )
  ]
);

export const seriesAnalysisReaderCapabilities = pgTable(
  "series_analysis_reader_capabilities",
  {
    readerId: text("reader_id").primaryKey(),
    artifactSchemaVersions: jsonb("artifact_schema_versions").notNull(),
    draining: boolean("draining").notNull().default(false),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    check(
      "series_analysis_reader_capabilities_schemas_array_check",
      sql`jsonb_typeof(${table.artifactSchemaVersions}) = 'array'`
    ),
    index("series_analysis_reader_capabilities_heartbeat_idx").on(
      table.heartbeatAt
    )
  ]
);

export const workerExecutionSlots = pgTable(
  "worker_execution_slots",
  {
    slotKey: text("slot_key").primaryKey(),
    taskKind: text("task_kind"),
    owner: text("owner"),
    jobId: text("job_id"),
    attemptId: text("attempt_id"),
    holderPreemptible: boolean("holder_preemptible"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    fencingToken: bigint("fencing_token", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    preemptRequestedBy: text("preempt_requested_by"),
    preemptRequestedAt: timestamp("preempt_requested_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    check(
      "worker_execution_slots_key_check",
      sql`${table.slotKey} = 'shared-heavy-work'`
    ),
    check(
      "worker_execution_slots_task_kind_check",
      sql`${table.taskKind} IS NULL OR ${table.taskKind} IN ('analysis','ocr')`
    ),
    check(
      "worker_execution_slots_holder_shape_check",
      sql`(${table.owner} IS NULL AND ${table.taskKind} IS NULL AND ${table.jobId} IS NULL AND ${table.attemptId} IS NULL AND ${table.holderPreemptible} IS NULL AND ${table.leaseExpiresAt} IS NULL) OR (${table.owner} IS NOT NULL AND ${table.taskKind} IS NOT NULL AND ${table.jobId} IS NOT NULL AND ${table.attemptId} IS NOT NULL AND ${table.holderPreemptible} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)`
    ),
    check(
      "worker_execution_slots_preempt_shape_check",
      sql`(${table.preemptRequestedBy} IS NULL) = (${table.preemptRequestedAt} IS NULL)`
    ),
    check(
      "worker_execution_slots_fencing_token_check",
      sql`${table.fencingToken} >= 0`
    )
  ]
);

export const seriesAnalysisQueueOutbox = pgTable(
  "series_analysis_queue_outbox",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => seriesAnalysisJobs.id, { onDelete: "cascade" }),
    dedupeKey: text("dedupe_key").notNull().unique(),
    schemaVersion: integer("schema_version").notNull().default(1),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    redisMessageId: text("redis_message_id"),
    lastError: text("last_error"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    check(
      "series_analysis_queue_outbox_schema_version_check",
      sql`${table.schemaVersion} = 1`
    ),
    check(
      "series_analysis_queue_outbox_status_check",
      sql`${table.status} IN ('pending','in_flight','delivered','failed')`
    ),
    check(
      "series_analysis_queue_outbox_attempt_count_check",
      sql`${table.attemptCount} BETWEEN 0 AND 3`
    ),
    check(
      "series_analysis_queue_outbox_claim_shape_check",
      sql`(${table.status} = 'in_flight') = (${table.claimExpiresAt} IS NOT NULL)`
    ),
    check(
      "series_analysis_queue_outbox_delivery_shape_check",
      sql`(${table.status} = 'delivered') = (${table.deliveredAt} IS NOT NULL AND ${table.redisMessageId} IS NOT NULL)`
    ),
    index("series_analysis_queue_outbox_dispatch_idx")
      .on(table.nextAttemptAt, table.createdAt, table.id)
      .where(sql`${table.status} = 'pending'`),
    index("series_analysis_queue_outbox_job_idx").on(table.jobId)
  ]
);

export const seriesAnalysisArtifacts = pgTable(
  "series_analysis_artifacts",
  {
    id: text("id").primaryKey(),
    gameTitleId: text("game_title_id")
      .notNull()
      .references(() => gameTitles.id, { onDelete: "cascade" }),
    attemptId: text("attempt_id").references(() => seriesAnalysisJobAttempts.id, {
      onDelete: "set null"
    }),
    inputRevision: bigint("input_revision", { mode: "bigint" }).notNull(),
    algorithmVersion: text("algorithm_version").notNull(),
    artifactSchemaVersion: integer("artifact_schema_version").notNull(),
    sourceInputChecksum: text("source_input_checksum").notNull(),
    rootChecksum: text("root_checksum").notNull(),
    status: text("status").notNull().default("staging"),
    aggregateChunkCount: integer("aggregate_chunk_count").notNull(),
    reviewChunkCount: integer("review_chunk_count").notNull(),
    drilldownChunkCount: integer("drilldown_chunk_count").notNull(),
    matchContextChunkCount: integer("match_context_chunk_count").notNull(),
    encodedBytes: bigint("encoded_bytes", { mode: "bigint" }).notNull(),
    decodedBytes: bigint("decoded_bytes", { mode: "bigint" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true })
  },
  (table) => [
    uniqueIndex("series_analysis_artifacts_id_title_unique").on(
      table.id,
      table.gameTitleId
    ),
    check(
      "series_analysis_artifacts_input_revision_check",
      sql`${table.inputRevision} >= 0`
    ),
    check(
      "series_analysis_artifacts_schema_version_check",
      sql`${table.artifactSchemaVersion} >= 1`
    ),
    check(
      "series_analysis_artifacts_status_check",
      sql`${table.status} IN ('staging','published')`
    ),
    check(
      "series_analysis_artifacts_checksum_check",
      sql`${table.sourceInputChecksum} ~ '^sha256:[0-9a-f]{64}$' AND ${table.rootChecksum} ~ '^sha256:[0-9a-f]{64}$'`
    ),
    check(
      "series_analysis_artifacts_chunk_counts_check",
      sql`${table.aggregateChunkCount} >= 1 AND ${table.reviewChunkCount} >= 0 AND ${table.drilldownChunkCount} >= 0 AND ${table.matchContextChunkCount} >= 0`
    ),
    check(
      "series_analysis_artifacts_bytes_check",
      sql`${table.encodedBytes} >= 0 AND ${table.decodedBytes} = ${table.encodedBytes}`
    ),
    check(
      "series_analysis_artifacts_publication_shape_check",
      sql`(${table.status} = 'published') = (${table.publishedAt} IS NOT NULL)`
    ),
    index("series_analysis_artifacts_staging_cleanup_idx")
      .on(table.createdAt)
      .where(sql`${table.status} = 'staging'`),
    index("series_analysis_artifacts_title_published_idx")
      .on(table.gameTitleId, table.publishedAt)
      .where(sql`${table.status} = 'published'`)
  ]
);

export const seriesAnalysisScopeAggregateArtifacts = pgTable(
  "series_analysis_scope_aggregate_artifacts",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => seriesAnalysisArtifacts.id, { onDelete: "cascade" }),
    scopeKey: text("scope_key").notNull(),
    scopeKind: text("scope_kind").notNull(),
    seasonMasterId: text("season_master_id"),
    mapMasterId: text("map_master_id"),
    payload: bytea("payload").notNull(),
    encodedBytes: integer("encoded_bytes").notNull(),
    decodedBytes: integer("decoded_bytes").notNull(),
    itemCount: integer("item_count").notNull(),
    nestingDepth: integer("nesting_depth").notNull(),
    checksum: text("checksum").notNull()
  },
  (table) => [
    primaryKey({ columns: [table.artifactId, table.scopeKey] }),
    checkSeriesAnalysisScope(
      "series_analysis_scope_aggregate_artifacts_scope_check",
      table
    ),
    checkSeriesAnalysisChunk(
      "series_analysis_scope_aggregate_artifacts_chunk_check",
      table
    )
  ]
);

export const seriesAnalysisScopeReviewArtifacts = pgTable(
  "series_analysis_scope_review_artifacts",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => seriesAnalysisArtifacts.id, { onDelete: "cascade" }),
    scopeKey: text("scope_key").notNull(),
    scopeKind: text("scope_kind").notNull(),
    seasonMasterId: text("season_master_id"),
    mapMasterId: text("map_master_id"),
    payload: bytea("payload").notNull(),
    encodedBytes: integer("encoded_bytes").notNull(),
    decodedBytes: integer("decoded_bytes").notNull(),
    itemCount: integer("item_count").notNull(),
    nestingDepth: integer("nesting_depth").notNull(),
    checksum: text("checksum").notNull()
  },
  (table) => [
    primaryKey({ columns: [table.artifactId, table.scopeKey] }),
    checkSeriesAnalysisScope(
      "series_analysis_scope_review_artifacts_scope_check",
      table
    ),
    checkSeriesAnalysisChunk(
      "series_analysis_scope_review_artifacts_chunk_check",
      table
    )
  ]
);

export const seriesAnalysisDrilldownArtifacts = pgTable(
  "series_analysis_drilldown_artifacts",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => seriesAnalysisArtifacts.id, { onDelete: "cascade" }),
    scopeKey: text("scope_key").notNull(),
    scopeKind: text("scope_kind").notNull(),
    seasonMasterId: text("season_master_id"),
    mapMasterId: text("map_master_id"),
    memberId: text("member_id").notNull(),
    metricId: text("metric_id").notNull(),
    payload: bytea("payload").notNull(),
    encodedBytes: integer("encoded_bytes").notNull(),
    decodedBytes: integer("decoded_bytes").notNull(),
    itemCount: integer("item_count").notNull(),
    nestingDepth: integer("nesting_depth").notNull(),
    checksum: text("checksum").notNull()
  },
  (table) => [
    primaryKey({
      columns: [table.artifactId, table.scopeKey, table.memberId, table.metricId]
    }),
    checkSeriesAnalysisScope(
      "series_analysis_drilldown_artifacts_scope_check",
      table
    ),
    checkSeriesAnalysisChunk(
      "series_analysis_drilldown_artifacts_chunk_check",
      table
    )
  ]
);

export const seriesAnalysisMatchContextArtifacts = pgTable(
  "series_analysis_match_context_artifacts",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => seriesAnalysisArtifacts.id, { onDelete: "cascade" }),
    scopeKey: text("scope_key").notNull(),
    scopeKind: text("scope_kind").notNull(),
    seasonMasterId: text("season_master_id"),
    mapMasterId: text("map_master_id"),
    matchId: text("match_id").notNull(),
    sourceMatchRevision: bigint("source_match_revision", {
      mode: "bigint"
    }).notNull(),
    payload: bytea("payload").notNull(),
    encodedBytes: integer("encoded_bytes").notNull(),
    decodedBytes: integer("decoded_bytes").notNull(),
    itemCount: integer("item_count").notNull(),
    nestingDepth: integer("nesting_depth").notNull(),
    checksum: text("checksum").notNull()
  },
  (table) => [
    primaryKey({ columns: [table.artifactId, table.scopeKey, table.matchId] }),
    checkSeriesAnalysisScope(
      "series_analysis_match_context_artifacts_scope_check",
      table
    ),
    checkSeriesAnalysisChunk(
      "series_analysis_match_context_artifacts_chunk_check",
      table
    ),
    check(
      "series_analysis_match_context_artifacts_revision_check",
      sql`${table.sourceMatchRevision} >= 0`
    ),
    index("series_analysis_match_context_artifacts_match_idx").on(table.matchId)
  ]
);

type SeriesAnalysisScopeColumns = {
  scopeKey: AnyPgColumn;
  scopeKind: AnyPgColumn;
  seasonMasterId: AnyPgColumn;
  mapMasterId: AnyPgColumn;
};

type SeriesAnalysisChunkColumns = {
  payload: AnyPgColumn;
  encodedBytes: AnyPgColumn;
  decodedBytes: AnyPgColumn;
  itemCount: AnyPgColumn;
  nestingDepth: AnyPgColumn;
  checksum: AnyPgColumn;
};

function checkSeriesAnalysisScope(
  name: string,
  table: SeriesAnalysisScopeColumns
) {
  return check(
    name,
    sql`(${table.scopeKind} = 'overall' AND ${table.seasonMasterId} IS NULL AND ${table.mapMasterId} IS NULL AND ${table.scopeKey} = 'overall') OR (${table.scopeKind} = 'season' AND ${table.seasonMasterId} IS NOT NULL AND ${table.mapMasterId} IS NULL AND ${table.scopeKey} = 'season:' || ${table.seasonMasterId}) OR (${table.scopeKind} = 'map' AND ${table.seasonMasterId} IS NULL AND ${table.mapMasterId} IS NOT NULL AND ${table.scopeKey} = 'map:' || ${table.mapMasterId}) OR (${table.scopeKind} = 'season_map' AND ${table.seasonMasterId} IS NOT NULL AND ${table.mapMasterId} IS NOT NULL AND ${table.scopeKey} = 'season_map:' || ${table.seasonMasterId} || ':' || ${table.mapMasterId})`
  );
}

function checkSeriesAnalysisChunk(
  name: string,
  table: SeriesAnalysisChunkColumns
) {
  return check(
    name,
    sql`${table.encodedBytes} >= 2 AND ${table.encodedBytes} = octet_length(${table.payload}) AND ${table.decodedBytes} = ${table.encodedBytes} AND ${table.itemCount} >= 0 AND ${table.nestingDepth} BETWEEN 1 AND 64 AND ${table.checksum} ~ '^sha256:[0-9a-f]{64}$'`
  );
}

// source-of-truth: 試合 1 行 × 4 プレイヤーの結果。
//   業務ルール (base.md §5.2): play_order と rank はそれぞれ {1,2,3,4} のユニーク。
//   金額は万円単位の整数。借金で負になり得るため値域チェックは行わない。
export const matchPlayers = pgTable(
  "match_players",
  {
    matchId: text("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    memberId: text("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "restrict" }),
    playOrder: integer("play_order").notNull(),
    rank: integer("rank").notNull(),
    totalAssetsManYen: integer("total_assets_man_yen").notNull(),
    revenueManYen: integer("revenue_man_yen").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    primaryKey({ columns: [table.matchId, table.memberId] }),
    uniqueIndex("match_players_match_play_order_unique").on(
      table.matchId,
      table.playOrder
    ),
    uniqueIndex("match_players_match_rank_unique").on(
      table.matchId,
      table.rank
    ),
    check(
      "match_players_play_order_check",
      sql`${table.playOrder} BETWEEN 1 AND 4`
    ),
    check("match_players_rank_check", sql`${table.rank} BETWEEN 1 AND 4`)
  ]
);

// source-of-truth: 試合 × プレイヤー × 事件項目の発生回数。
//   MVP では incident_masters の 6 項目固定だが、将来項目追加に備えて専用テーブルにする。
export const matchIncidents = pgTable(
  "match_incidents",
  {
    matchId: text("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    memberId: text("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "restrict" }),
    incidentMasterId: text("incident_master_id")
      .notNull()
      .references(() => incidentMasters.id, { onDelete: "restrict" }),
    count: integer("count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    primaryKey({
      columns: [table.matchId, table.memberId, table.incidentMasterId]
    }),
    check("match_incidents_count_check", sql`${table.count} >= 0`),
    index("match_incidents_match_id_idx").on(table.matchId)
  ]
);
