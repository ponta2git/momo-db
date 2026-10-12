import { bigint, boolean, check, foreignKey, index, integer, jsonb, pgTable, primaryKey, smallint, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { sessions } from "./attendance.js";

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

// source-of-truth: アンケートと結果通知で共有する受付・配送の正本。
//   業務別の順序・取消条件・更新単位は consumer application が定義する。
export const DISCORD_NOTIFICATION_FAMILIES = ["attendance", "result"] as const;

export const RESULT_NOTIFICATION_KINDS = ["ocr_completed", "analysis_completed"] as const;

export type ResultNotificationKind = (typeof RESULT_NOTIFICATION_KINDS)[number];

export const discordNotifications = pgTable(
  "discord_notifications",
  {
    id: text("id").primaryKey(),
    family: text("family").notNull(),
    kind: text("kind").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    // why: 整理時に本文だけを消し、hash・identity・終端を残して再受付を抑止する。
    payload: jsonb("payload"),
    payloadHash: text("payload_hash").notNull(),
    status: text("status").notNull().default("PENDING"),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(10),
    retryCycle: integer("retry_cycle").notNull().default(0),
    lastError: text("last_error"),
    cancelReason: text("cancel_reason"),
    claimToken: uuid("claim_token"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    // invariant: 初回描画で部分数と renderer を固定し、再試行時に区切りを変えない。
    partCount: integer("part_count").notNull().default(0),
    rendererVersion: integer("renderer_version"),
    // Fixed alongside the part plan; a retry must keep its destination and links.
    deliveryContext: jsonb("delivery_context"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
    purgedAt: timestamp("purged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("discord_notifications_dedupe_unique").on(table.dedupeKey),
    check("discord_notifications_kind_check", sql`(${table.family} = 'attendance' AND ${table.kind} = 'send_message') OR (${table.family} = 'result' AND ${table.kind} IN ('ocr_completed','analysis_completed'))`),
    check("discord_notifications_status_check", sql`${table.status} IN ('PENDING','IN_FLIGHT','DELIVERED','FAILED','CANCELLED')`),
    check("discord_notifications_attempts_check", sql`${table.attemptCount} >= 0 AND ${table.maxAttempts} BETWEEN 1 AND 100 AND ${table.retryCycle} >= 0`),
    check("discord_notifications_version_check", sql`${table.schemaVersion} > 0`),
    check("discord_notifications_hash_check", sql`${table.payloadHash} ~ '^[0-9a-f]{64}$'`),
    check("discord_notifications_claim_check", sql`(${table.claimToken} IS NULL) = (${table.claimExpiresAt} IS NULL) AND (${table.status} <> 'IN_FLIGHT' OR ${table.claimToken} IS NOT NULL)`),
    check("discord_notifications_parts_check", sql`(${table.partCount} = 0 AND ${table.rendererVersion} IS NULL) OR (${table.partCount} > 0 AND ${table.rendererVersion} > 0)`),
    check("discord_notifications_purge_check", sql`(${table.payload} IS NOT NULL AND ${table.purgedAt} IS NULL) OR (${table.payload} IS NULL AND ${table.purgedAt} IS NOT NULL AND ${table.status} IN ('DELIVERED','FAILED','CANCELLED') AND ${table.claimToken} IS NULL)`),
    index("discord_notifications_dispatch_idx").on(table.family, table.status, table.nextAttemptAt),
    index("discord_notifications_claim_expiry_idx").on(table.claimExpiresAt).where(sql`${table.claimToken} IS NOT NULL`),
    index("discord_notifications_retention_idx").on(table.terminalAt).where(sql`${table.purgedAt} IS NULL AND ${table.status} IN ('DELIVERED','FAILED','CANCELLED')`)
  ]
);

export const discordNotificationAttendance = pgTable(
  "discord_notification_attendance",
  {
    notificationId: text("notification_id").primaryKey(),
    // why: 完了済み Session を整理した後も dedupe の親行は残す。
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "set null" }),
    aggregateRevision: bigint("aggregate_revision", { mode: "number" }).notNull(),
    ordinal: smallint("ordinal").notNull()
  },
  (table) => [
    foreignKey({ name: "discord_attendance_notification_fk", columns: [table.notificationId], foreignColumns: [discordNotifications.id] }).onDelete("cascade"),
    uniqueIndex("discord_notification_attendance_order_unique").on(table.sessionId, table.aggregateRevision, table.ordinal),
    check("discord_notification_attendance_order_check", sql`${table.aggregateRevision} >= 0 AND ${table.ordinal} >= 0`)
  ]
);

export const discordNotificationSettings = pgTable(
  "discord_notification_settings",
  {
    kind: text("kind").primaryKey(),
    enabled: boolean("enabled").notNull().default(true),
    generation: bigint("generation", { mode: "bigint" }).notNull().default(sql`0`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    check("discord_notification_settings_kind_check", sql`${table.kind} IN ('ocr_completed','analysis_completed')`),
    check("discord_notification_settings_generation_check", sql`${table.generation} >= 0`)
  ]
);

export const discordNotificationResults = pgTable(
  "discord_notification_results",
  {
    notificationId: text("notification_id").primaryKey(),
    kind: text("kind").notNull(),
    // invariant: ジョブ・成果物の履歴整理に連鎖させず、この一意性を期限なしで残す。
    sourceJobId: text("source_job_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    settingsGeneration: bigint("settings_generation", { mode: "bigint" }).notNull()
  },
  (table) => [
    foreignKey({ name: "discord_results_notification_fk", columns: [table.notificationId], foreignColumns: [discordNotifications.id] }).onDelete("cascade"),
    foreignKey({ name: "discord_results_settings_fk", columns: [table.kind], foreignColumns: [discordNotificationSettings.kind] }).onDelete("restrict"),
    uniqueIndex("discord_notification_results_job_unique").on(table.kind, table.sourceJobId),
    check("discord_notification_results_generation_check", sql`${table.settingsGeneration} >= 0`)
  ]
);

export const discordNotificationTargets = pgTable(
  "discord_notification_targets",
  {
    notificationId: text("notification_id").notNull(),
    targetKind: text("target_kind").notNull(),
    // why: 業務対象の削除後も取消の識別を残す。対象 table への cascade FK は張らない。
    targetId: text("target_id").notNull()
  },
  (table) => [
    primaryKey({ name: "discord_notification_targets_pk", columns: [table.notificationId, table.targetKind, table.targetId] }),
    foreignKey({ name: "discord_targets_notification_fk", columns: [table.notificationId], foreignColumns: [discordNotifications.id] }).onDelete("cascade"),
    check("discord_notification_targets_kind_check", sql`${table.targetKind} IN ('match_draft','match')`),
    index("discord_notification_targets_lookup_idx").on(table.targetKind, table.targetId)
  ]
);

export const discordNotificationParts = pgTable(
  "discord_notification_parts",
  {
    notificationId: text("notification_id").notNull(),
    partNo: integer("part_no").notNull(),
    status: text("status").notNull().default("PENDING"),
    attemptCount: integer("attempt_count").notNull().default(0),
    claimToken: uuid("claim_token"),
    sendStartedAt: timestamp("send_started_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    deliveredMessageId: text("delivered_message_id")
  },
  (table) => [
    primaryKey({ name: "discord_notification_parts_pk", columns: [table.notificationId, table.partNo] }),
    foreignKey({ name: "discord_parts_notification_fk", columns: [table.notificationId], foreignColumns: [discordNotifications.id] }).onDelete("cascade"),
    check("discord_notification_parts_number_check", sql`${table.partNo} >= 0 AND ${table.attemptCount} >= 0`),
    check("discord_notification_parts_status_check", sql`${table.status} IN ('PENDING','IN_FLIGHT','DELIVERED','CANCELLED')`),
    check("discord_notification_parts_claim_check", sql`${table.status} <> 'IN_FLIGHT' OR (${table.claimToken} IS NOT NULL AND ${table.sendStartedAt} IS NOT NULL)`)
  ]
);
