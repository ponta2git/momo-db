import { sql } from "drizzle-orm";
import {
  bigint, check, date, index, integer, jsonb, numeric, pgTable,
  primaryKey, text, timestamp, uniqueIndex, uuid
} from "drizzle-orm/pg-core";
import { gameTitles, mapMasters } from "./catalog.js";
import { members, momoLoginAccounts } from "./identity.js";
import { matches } from "./matches.js";

// Definitions and independent current evidence; computed achievements belong to analysis artifacts.
export const achievementItems = pgTable("achievement_items", {
  id: uuid("id").primaryKey(),
  gameTitleId: uuid("game_title_id").notNull().references(() => gameTitles.id, { onDelete: "restrict" }),
  fixedKey: text("fixed_key").unique(),
  name: text("name").notNull(),
  notes: text("notes").notNull().default(""),
  ruleKind: text("rule_kind").notNull(),
  threshold: numeric("threshold"),
  stars: integer("stars").notNull(),
  scopeKind: text("scope_kind").notNull(),
  appliesFrom: date("applies_from"),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  version: bigint("version", { mode: "bigint" }).notNull().default(sql`1`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  check("achievement_items_name_check", sql`length(trim(${t.name})) BETWEEN 1 AND 300 AND length(${t.notes}) <= 4000`),
  check("achievement_items_rule_check", sql`${t.ruleKind} IN ('manual','total_assets','destination','suri_no_ginji','event_average_rank')`),
  check("achievement_items_threshold_check", sql`(${t.ruleKind} = 'manual' AND ${t.threshold} IS NULL) OR (${t.ruleKind} <> 'manual' AND ${t.threshold} IS NOT NULL AND ${t.threshold} > 0 AND ${t.threshold} < 'Infinity'::numeric AND (${t.ruleKind} <> 'event_average_rank' OR ${t.threshold} BETWEEN 1 AND 4) AND (${t.ruleKind} NOT IN ('destination','suri_no_ginji','total_assets') OR ${t.threshold} = trunc(${t.threshold})))`),
  check("achievement_items_stars_check", sql`${t.stars} BETWEEN 1 AND 5`),
  check("achievement_items_scope_check", sql`${t.scopeKind} IN ('common','maps')`),
  check("achievement_items_version_check", sql`${t.version} >= 1`),
  index("achievement_items_title_idx").on(t.gameTitleId)
]);

export const achievementItemMaps = pgTable("achievement_item_maps", {
  itemId: uuid("item_id").notNull().references(() => achievementItems.id, { onDelete: "restrict" }),
  mapMasterId: uuid("map_master_id").notNull().references(() => mapMasters.id, { onDelete: "restrict" })
}, (t) => [primaryKey({ columns: [t.itemId, t.mapMasterId] })]);

export const achievementClaims = pgTable("achievement_claims", {
  id: uuid("id").primaryKey(),
  itemId: uuid("item_id").notNull().references(() => achievementItems.id, { onDelete: "restrict" }),
  memberId: uuid("member_id").notNull().references(() => members.id, { onDelete: "restrict" }),
  sourceKind: text("source_kind").notNull(),
  state: text("state").notNull(),
  matchId: uuid("match_id").references(() => matches.id, { onDelete: "set null" }),
  achievedAt: timestamp("achieved_at", { withTimezone: true }),
  generationId: uuid("generation_id").notNull(),
  version: bigint("version", { mode: "bigint" }).notNull().default(sql`1`),
  updatedByAccountId: uuid("updated_by_account_id").notNull().references(() => momoLoginAccounts.id, { onDelete: "restrict" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  uniqueIndex("achievement_claims_root_unique").on(t.itemId, t.memberId, t.sourceKind),
  check("achievement_claims_source_check", sql`${t.sourceKind} IN ('direct','import')`),
  check("achievement_claims_state_check", sql`${t.state} IN ('achieved','unconfirmed','cancelled') AND (${t.sourceKind} <> 'direct' OR ${t.state} <> 'unconfirmed')`),
  check("achievement_claims_version_check", sql`${t.version} >= 1`),
  index("achievement_claims_match_idx").on(t.matchId)
]);

// A business snapshot, independent of the ephemeral analysis resource's wire version or lifetime.
export const achievementRetiredSnapshots = pgTable("achievement_retired_snapshots", {
  itemId: uuid("item_id").primaryKey().references(() => achievementItems.id, { onDelete: "restrict" }),
  formatVersion: integer("format_version").notNull(),
  sourceInputRevision: bigint("source_input_revision", { mode: "bigint" }).notNull(),
  snapshot: jsonb("snapshot").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  check("achievement_retired_snapshots_format_check", sql`${t.formatVersion} = 1 AND ${t.sourceInputRevision} >= 0 AND jsonb_typeof(${t.snapshot}) = 'object'`)
]);

// Only generations already supporting a lower manual item at retirement may continue supporting it.
export const achievementRetiredManualSources = pgTable("achievement_retired_manual_sources", {
  itemId: uuid("item_id").notNull().references(() => achievementItems.id, { onDelete: "restrict" }),
  claimId: uuid("claim_id").notNull().references(() => achievementClaims.id, { onDelete: "restrict" }),
  generationId: uuid("generation_id").notNull()
}, (t) => [primaryKey({ columns: [t.itemId, t.claimId, t.generationId], name: "achievement_retired_manual_sources_pk" })]);
