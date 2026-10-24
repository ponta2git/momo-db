import {
  uuid,
  foreignKey,
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
import { gameTitles } from "../catalog.js";
import { seriesRadarBases } from "../radar.js";
import { bytea } from "../types.js";
import { seriesAnalysisJobAttempts } from "./jobs.js";
import {
  checkSeriesAnalysisScope,
  checkSeriesAnalysisChunk,
  checkSeriesAnalysisValidationContract,
  checkSeriesAnalysisValidationSchema
} from "./checks.js";

export const seriesAnalysisArtifacts = pgTable(
  "series_analysis_artifacts",
  {
    id: text("id").primaryKey(),
    radarBasisId: text("radar_basis_id").references(() => seriesRadarBases.id),
    radarGeneration: bigint("radar_generation", { mode: "bigint" }).notNull().default(sql`0`),
    radarAppliedAt: timestamp("radar_applied_at", { withTimezone: true }),
    scopeKeys: text("scope_keys").array().notNull().default(sql`'{}'::text[]`),
    gameTitleId: text("game_title_id")
      .notNull()
      .references(() => gameTitles.legacyId, { onDelete: "cascade" }),
    attemptId: text("attempt_id").references(() => seriesAnalysisJobAttempts.legacyId, {
      onDelete: "set null"
    }),
    inputRevision: bigint("input_revision", { mode: "bigint" }).notNull(),
    algorithmVersion: text("algorithm_version").notNull(),
    artifactSchemaVersion: integer("artifact_schema_version").notNull(),
    validationContractId: text("validation_contract_id"),
    sourceInputChecksum: text("source_input_checksum").notNull(),
    rootChecksum: text("root_checksum").notNull(),
    status: text("status").notNull().default("staging"),
    aggregateChunkCount: integer("aggregate_chunk_count").notNull(),
    reviewChunkCount: integer("review_chunk_count").notNull(),
    drilldownChunkCount: integer("drilldown_chunk_count").notNull(),
    matchContextChunkCount: integer("match_context_chunk_count").notNull(),
    achievementChunkCount: integer("achievement_chunk_count").notNull().default(0),
    outlookSummaryChunkCount: integer("outlook_summary_chunk_count").notNull().default(0),
    outlookReferenceChunkCount: integer("outlook_reference_chunk_count").notNull().default(0),
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
    checkSeriesAnalysisValidationContract(
      "series_analysis_artifacts_validation_contract_check",
      table.validationContractId
    ),
    checkSeriesAnalysisValidationSchema(
      "series_analysis_artifacts_validation_schema_check",
      table.artifactSchemaVersion,
      table.validationContractId
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
      sql`${table.aggregateChunkCount} >= 1 AND ${table.reviewChunkCount} >= 0 AND ${table.drilldownChunkCount} >= 0 AND ${table.matchContextChunkCount} >= 0 AND ${table.outlookSummaryChunkCount} >= 0 AND ${table.outlookReferenceChunkCount} >= 0 AND ${table.achievementChunkCount} >= 0`
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

export const seriesAnalysisAchievementArtifacts = pgTable(
  "series_analysis_achievement_artifacts",
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
    check("series_analysis_achievement_artifacts_domain_check", sql`${table.scopeKind} = 'overall'`),
    checkSeriesAnalysisScope(
      "series_analysis_achievement_artifacts_scope_check",
      table
    ),
    checkSeriesAnalysisChunk(
      "series_analysis_achievement_artifacts_chunk_check",
      table
    )
  ]
);

export const seriesAnalysisOutlookSummaryArtifacts = pgTable(
  "series_analysis_outlook_summary_artifacts",
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
    check("series_analysis_outlook_summary_artifacts_domain_check", sql`${table.scopeKind} IN ('overall','season') AND ${table.itemCount} IN (0,4)`),
    checkSeriesAnalysisScope(
      "series_analysis_outlook_summary_artifacts_scope_check",
      table
    ),
    checkSeriesAnalysisChunk(
      "series_analysis_outlook_summary_artifacts_chunk_check",
      table
    )
  ]
);

export const seriesAnalysisOutlookReferenceArtifacts = pgTable(
  "series_analysis_outlook_reference_artifacts",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => seriesAnalysisArtifacts.id, { onDelete: "cascade" }),
    scopeKey: text("scope_key").notNull(),
    scopeKind: text("scope_kind").notNull(),
    seasonMasterId: text("season_master_id"),
    mapMasterId: text("map_master_id"),
    memberId: text("member_id").notNull(),
    payload: bytea("payload").notNull(),
    encodedBytes: integer("encoded_bytes").notNull(),
    decodedBytes: integer("decoded_bytes").notNull(),
    itemCount: integer("item_count").notNull(),
    nestingDepth: integer("nesting_depth").notNull(),
    checksum: text("checksum").notNull()
  },
  (table) => [
    primaryKey({ columns: [table.artifactId, table.scopeKey, table.memberId] }),
    check("series_analysis_outlook_reference_artifacts_domain_check", sql`${table.scopeKind} = 'overall' AND length(${table.memberId}) BETWEEN 1 AND 128 AND ${table.itemCount} BETWEEN 1 AND 2771`),
    checkSeriesAnalysisScope(
      "series_analysis_outlook_reference_artifacts_scope_check",
      table
    ),
    checkSeriesAnalysisChunk(
      "series_analysis_outlook_reference_artifacts_chunk_check",
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

// Stable UUID identity for an immutable legacy header; the source row is never rewritten.
export const seriesAnalysisArtifactIdentities = pgTable(
  "series_analysis_artifact_identities",
  {
    id: uuid("id").primaryKey(),
    legacyId: text("legacy_id").notNull().unique(),
    gameTitleId: uuid("game_title_id").notNull(),
    legacyGameTitleId: text("legacy_game_title_id").notNull()
  },
  (table) => [
    uniqueIndex("series_analysis_artifact_identities_id_title_unique").on(table.id, table.gameTitleId),
    uniqueIndex("series_analysis_artifact_identities_legacy_title_unique").on(table.legacyId, table.gameTitleId),
    foreignKey({
      name: "series_analysis_artifact_identities_source_fk",
      columns: [table.legacyId, table.legacyGameTitleId],
      foreignColumns: [seriesAnalysisArtifacts.id, seriesAnalysisArtifacts.gameTitleId]
    }).onDelete("cascade"),
    foreignKey({
      name: "series_analysis_artifact_identities_title_fk",
      columns: [table.gameTitleId, table.legacyGameTitleId],
      foreignColumns: [gameTitles.id, gameTitles.legacyId]
    }).onDelete("cascade")
  ]
);
