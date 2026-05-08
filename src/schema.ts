import {
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  varchar
} from "drizzle-orm/pg-core";
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

export const appSessions = pgTable(
  "app_sessions",
  {
    id: text("id").primaryKey(),
    memberId: text("member_id").notNull(),
    csrfSecret: text("csrf_secret").notNull(),
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
    index("app_sessions_expires_at_idx").on(table.expiresAt)
  ]
);

// source-of-truth: HTTP Idempotency-Key の処理結果キャッシュ。
//   POST 再送時に同じ member/endpoint/key へ保存済みレスポンスを返し、副作用の二重発生を防ぐ。
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    key: text("key").notNull(),
    memberId: text("member_id")
      .notNull()
      .references(() => members.id),
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
    primaryKey({ columns: [table.key, table.memberId, table.endpoint] }),
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
      .defaultNow()
  },
  (table) => [
    // unique: (sessionId, memberId) で二重回答を排除。押し直しは upsertResponse が
    //   ON CONFLICT DO UPDATE で最新 choice に上書きする。
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

export const ocrJobs = pgTable(
  "ocr_jobs",
  {
    id: text("id").primaryKey(),
    draftId: text("draft_id").notNull(),
    imageId: text("image_id").notNull(),
    imagePath: text("image_path").notNull(),
    requestedScreenType: text("requested_screen_type").notNull(),
    detectedScreenType: text("detected_screen_type"),
    status: text("status").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    workerId: text("worker_id"),
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
    index("ocr_jobs_image_id_idx").on(table.imageId)
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
    status: text("status").notNull().default("PENDING"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
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
//   worker が非同期配送。crash 中でも DB 正本のまま再試行される。 @see ADR-0035
export const OUTBOX_KINDS = ["send_message", "edit_message"] as const;
export type OutboxKind = (typeof OUTBOX_KINDS)[number];

export const OUTBOX_STATUSES = [
  "PENDING",
  "IN_FLIGHT",
  "DELIVERED",
  "FAILED"
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
    // unique: 同じ intent の二重 enqueue を防ぐ per-session の決定論キー。
    //   状態遷移 tx 内で onConflictDoNothing に渡し、重複は skipped=true として上位に通知する。
    dedupeKey: text("dedupe_key").notNull(),
    status: text("status").notNull().default("PENDING"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    // race: worker の claim で IN_FLIGHT + claim_expires_at=now+ttl をセット。
    //   reconciler は expire 済み IN_FLIGHT を PENDING に戻して reclaim する。
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    // source-of-truth: 配送成功時の Discord message id。
    //   payload.target が指す sessions 列 (askMessageId / postponeMessageId) に worker が書き戻す。
    deliveredMessageId: text("delivered_message_id"),
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
      sql`${table.kind} IN ('send_message','edit_message')`
    ),
    check(
      "discord_outbox_status_check",
      sql`${table.status} IN ('PENDING','IN_FLIGHT','DELIVERED','FAILED')`
    ),
    // unique: 非 FAILED な同 dedupe_key を 1 件に制約 (PENDING/IN_FLIGHT/DELIVERED で「同一 intent 最大 1」)。
    //   FAILED は dead letter としてスコープ外。partial unique を raw WHERE で表現する。
    uniqueIndex("uq_discord_outbox_dedupe_active")
      .on(table.dedupeKey)
      .where(sql`status IN ('PENDING','IN_FLIGHT','DELIVERED')`),
    // why: claimNextBatch の `status IN ('PENDING','IN_FLIGHT') AND next_attempt_at <= now` を prefix で支援。
    index("idx_discord_outbox_status_next").on(
      table.status,
      table.nextAttemptAt
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
      .notNull()
      .references(() => members.id, { onDelete: "restrict" }),
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
      .notNull()
      .references(() => members.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
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
    index("matches_held_event_id_idx").on(table.heldEventId),
    index("matches_played_at_idx").on(table.playedAt)
  ]
);

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
