import {
  uuid,
  unique,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { members } from "./identity.js";

// momo-result の作品・マップ・シーズン・事件とメンバー別名のマスター。
// 要件は momo-result/requirements/base.md を参照。

// source-of-truth: 作品 (例: 桃太郎電鉄2、桃太郎電鉄ワールド、桃太郎電鉄〜昭和 平成 令和も定番〜)。
//   layout_family は OCR プロファイル (apps/ocr-worker/src/momo_ocr_worker/profiles) と整合。
export const gameTitles = pgTable(
  "game_titles",
  {
    legacyId: text("legacy_id").notNull().unique(),
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    // why: OCR profile family と一致させる識別子。例: "momotetsu_2", "world", "reiwa"。
    layoutFamily: text("layout_family").notNull(),
    displayOrder: integer("display_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    unique("game_titles_id_legacy_unique").on(table.id, table.legacyId),
    uniqueIndex("game_titles_name_unique").on(table.name),
    check("game_titles_layout_family_check", sql`${table.layoutFamily} IN ('momotetsu_2','world','reiwa')`)
  ]
);

// source-of-truth: マップ。作品ごとに別マップを持つため (gameTitleId, name) で unique。
export const mapMasters = pgTable(
  "map_masters",
  {
    legacyId: text("legacy_id").notNull().unique(),
    id: uuid("id").primaryKey(),
    gameTitleId: uuid("game_title_id")
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
    legacyId: text("legacy_id").notNull().unique(),
    id: uuid("id").primaryKey(),
    gameTitleId: uuid("game_title_id")
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
    legacyId: text("legacy_id").notNull().unique(),
    id: uuid("id").primaryKey(),
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
    legacyId: text("legacy_id").notNull().unique(),
    id: uuid("id").primaryKey(),
    memberId: uuid("member_id")
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
