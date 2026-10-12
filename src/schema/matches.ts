import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { members, momoLoginAccounts } from "./identity.js";
import { heldEvents } from "./attendance.js";
import {
  gameTitles,
  mapMasters,
  seasonMasters,
  incidentMasters
} from "./catalog.js";

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
      .default(sql`0`),
    noteBody: text("note_body"),
    noteVersion: bigint("note_version", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    noteUpdatedByAccountId: text("note_updated_by_account_id").references(
      () => momoLoginAccounts.id,
      { onDelete: "restrict" }
    ),
    noteUpdatedAt: timestamp("note_updated_at", { withTimezone: true })
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
    check("matches_note_version_check", sql`${table.noteVersion} >= 0`),
    check(
      "matches_note_shape_check",
      sql`(
        (${table.noteVersion} = 0 AND ${table.noteBody} IS NULL AND ${table.noteUpdatedByAccountId} IS NULL AND ${table.noteUpdatedAt} IS NULL)
        OR
        (${table.noteVersion} > 0 AND ${table.noteUpdatedByAccountId} IS NOT NULL AND ${table.noteUpdatedAt} IS NOT NULL)
      )`
    ),
    index("matches_held_event_id_idx").on(table.heldEventId),
    index("matches_created_by_account_id_idx").on(table.createdByAccountId),
    index("matches_played_at_idx").on(table.playedAt),
    // Bound global adjacent-match reads even when many matches share a timestamp.
    index("matches_navigation_idx").on(
      table.playedAt,
      sql`${table.heldEventId} COLLATE "C"`,
      table.matchNoInEvent,
      sql`${table.id} COLLATE "C"`
    )
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
