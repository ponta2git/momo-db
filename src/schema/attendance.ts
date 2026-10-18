import {
  uuid,
  unique,
  bigint,
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { members } from "./identity.js";

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
    legacyId: text("legacy_id").notNull().unique(),
    id: uuid("id").primaryKey(),
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
    // why: findDueReminderSessions / findDueStartupRecoverySessions の
    //   `status='DECIDED' AND reminder_at <= now` を prefix/range scan で支援する composite index。
    //   reminder_sent_at は旧 claim-first 経路の曖昧な marker であり、due predicate には使わない。
    index("idx_sessions_status_reminder").on(
      table.status,
      table.reminderAt
    )
  ]
);

export const responses = pgTable(
  "responses",
  {
    legacyId: text("legacy_id").notNull().unique(),
    id: uuid("id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
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
  legacyId: text("legacy_id").notNull().unique(),
  id: uuid("id").primaryKey(),
  // Public routes serialize this independent number as a decimal string.
  publicId: bigint("public_id", { mode: "bigint" })
    .notNull()
    .generatedAlwaysAsIdentity()
    .unique(),
  // why: summit の Discord 出席 session に紐づく held_event は session_id を持つ。
  //   momo-result が単独で作成した ad-hoc 開催履歴は session_id NULL になる。
  // unique: NULL 以外は 1 Session につき 1 HeldEvent。
  //   summit の DECIDED→COMPLETED CAS との onConflictDoNothing anchor として必要。
  sessionId: uuid("session_id")
    .unique()
    // why: 終了したアンケートの整理で、開催・参加者・試合の履歴を失わない。
    .references(() => sessions.id, { onDelete: "set null" }),
  // why: `Iso` suffix で文字列日付型を明示 (ADR-0014)。summit 作成時は session.candidate_date_iso と一致。
  heldDateIso: date("held_date_iso", { mode: "string" }).notNull(),
  startAt: timestamp("start_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow()
}, (table) => [
  unique("held_events_id_legacy_unique").on(table.id, table.legacyId),
  // The history list and both adjacent-detail directions share bytewise ID ties.
  index("held_events_navigation_idx").on(table.startAt, sql`${table.legacyId} COLLATE "C"`)
]);

// source-of-truth: 開催ごとの参加メンバースナップショット (§8.3)。
//   user config の members は「今の設定」であり「その開催の実参加」ではないため、
//   開催時点の responses から派生させた snapshot を保持する。
export const heldEventParticipants = pgTable(
  "held_event_participants",
  {
    heldEventId: uuid("held_event_id")
      .notNull()
      .references(() => heldEvents.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
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
