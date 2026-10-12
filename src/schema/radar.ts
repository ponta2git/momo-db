import { bigint, check, foreignKey, index, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { gameTitles } from "./catalog.js";

// Fixed, title-wide radar criteria are independent of the ordinary artifact retention cycle.
export const seriesRadarBases = pgTable("series_radar_bases", {
  id: text("id").primaryKey(),
  gameTitleId: text("game_title_id").notNull().references(() => gameTitles.id, { onDelete: "cascade" }),
  checksum: text("checksum").notNull(),
  payload: jsonb("payload").notNull(),
  sourceSnapshot: jsonb("source_snapshot"),
  sourceChecksum: text("source_checksum").notNull(),
  sourceInputRevision: bigint("source_input_revision", { mode: "bigint" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, table => [
  unique("series_radar_bases_id_title_unique").on(table.id, table.gameTitleId),
  check("series_radar_bases_revision_check", sql`${table.sourceInputRevision} >= 0`),
  check("series_radar_bases_checksum_check", sql`${table.checksum} ~ '^sha256:[0-9a-f]{64}$' AND ${table.sourceChecksum} ~ '^sha256:[0-9a-f]{64}$'`)
]);

export const seriesRadarCandidates = pgTable("series_radar_candidates", {
  id: text("id").primaryKey(),
  gameTitleId: text("game_title_id").notNull().references(() => gameTitles.id, { onDelete: "cascade" }),
  basisId: text("basis_id"),
  status: text("status").notNull().default("pending"),
  result: jsonb("result"),
  sourceInputRevision: bigint("source_input_revision", { mode: "bigint" }),
  safeFailureCode: text("safe_failure_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, table => [
  unique("series_radar_candidates_id_title_unique").on(table.id, table.gameTitleId),
  uniqueIndex("series_radar_candidates_active_unique").on(table.gameTitleId).where(sql`${table.status} IN ('pending','ready','unavailable','failed')`),
  foreignKey({ name: "series_radar_candidate_basis_fk", columns: [table.basisId, table.gameTitleId], foreignColumns: [seriesRadarBases.id, seriesRadarBases.gameTitleId] }),
  check("series_radar_candidates_status_check", sql`${table.status} IN ('pending','ready','unavailable','invalid','withdrawn','applied','failed')`),
  index("series_radar_candidates_title_created_idx").on(table.gameTitleId, table.createdAt)
]);

export const seriesRadarPreviews = pgTable("series_radar_previews", {
  id: text("id").primaryKey(),
  gameTitleId: text("game_title_id").notNull().references(() => gameTitles.id, { onDelete: "cascade" }),
  candidateId: text("candidate_id").notNull(),
  beforeBasisId: text("before_basis_id"),
  inputRevision: bigint("input_revision", { mode: "bigint" }).notNull(),
  status: text("status").notNull().default("pending"),
  inputChecksum: text("input_checksum"),
  evaluationSnapshot: jsonb("evaluation_snapshot"),
  scopeKeys: text("scope_keys").array().notNull().default(sql`'{}'::text[]`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, table => [
  unique("series_radar_previews_id_title_unique").on(table.id, table.gameTitleId),
  foreignKey({ name: "series_radar_preview_candidate_fk", columns: [table.candidateId, table.gameTitleId], foreignColumns: [seriesRadarCandidates.id, seriesRadarCandidates.gameTitleId], }).onDelete("cascade"),
  foreignKey({ name: "series_radar_preview_basis_fk", columns: [table.beforeBasisId, table.gameTitleId], foreignColumns: [seriesRadarBases.id, seriesRadarBases.gameTitleId] }),
  check("series_radar_previews_status_check", sql`${table.status} IN ('pending','ready','stale','failed')`),
  check("series_radar_previews_revision_check", sql`${table.inputRevision} >= 0`),
  index("series_radar_previews_candidate_created_idx").on(table.candidateId, table.createdAt)
]);

export const seriesRadarPreviewScopes = pgTable("series_radar_preview_scopes", {
  previewId: text("preview_id").notNull().references(() => seriesRadarPreviews.id, { onDelete: "cascade" }),
  scopeKey: text("scope_key").notNull(),
  payload: jsonb("payload").notNull()
}, table => [primaryKey({ columns: [table.previewId, table.scopeKey] })]);

export const seriesRadarOperations = pgTable("series_radar_operations", {
  id: text("id").primaryKey(),
  gameTitleId: text("game_title_id").notNull().references(() => gameTitles.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  status: text("status").notNull().default("pending"),
  candidateId: text("candidate_id"),
  previewId: text("preview_id"),
  basisId: text("basis_id"),
  originOperationId: text("origin_operation_id"),
  requestedBy: text("requested_by").notNull(),
  idempotencyKeyHash: text("idempotency_key_hash").notNull(),
  requestFingerprint: text("request_fingerprint").notNull(),
  jobId: text("job_id"),
  safeFailureCode: text("safe_failure_code"),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, table => [
  uniqueIndex("series_radar_operations_idempotency_unique").on(table.gameTitleId, table.requestedBy, table.idempotencyKeyHash),
  unique("series_radar_operations_id_title_unique").on(table.id, table.gameTitleId),
  foreignKey({ name: "series_radar_operation_candidate_fk", columns: [table.candidateId, table.gameTitleId], foreignColumns: [seriesRadarCandidates.id, seriesRadarCandidates.gameTitleId] }),
  foreignKey({ name: "series_radar_operation_preview_fk", columns: [table.previewId, table.gameTitleId], foreignColumns: [seriesRadarPreviews.id, seriesRadarPreviews.gameTitleId] }),
  foreignKey({ name: "series_radar_operation_basis_fk", columns: [table.basisId, table.gameTitleId], foreignColumns: [seriesRadarBases.id, seriesRadarBases.gameTitleId] }),
  check("series_radar_operations_kind_check", sql`${table.kind} IN ('candidate','preview','apply','withdraw','restore','acknowledge','retry')`),
  check("series_radar_operations_status_check", sql`${table.status} IN ('pending','running','succeeded','failed','withdrawn')`),
  index("series_radar_operations_pending_idx").on(table.requestedAt, table.id).where(sql`${table.status} = 'pending' AND ${table.jobId} IS NULL`),
  index("series_radar_operations_title_created_idx").on(table.gameTitleId, table.requestedAt)
]);

export const seriesRadarTitleStates = pgTable("series_radar_title_states", {
  gameTitleId: text("game_title_id").primaryKey().references(() => gameTitles.id, { onDelete: "cascade" }),
  desiredBasisId: text("desired_basis_id"),
  currentBasisId: text("current_basis_id"),
  previousBasisId: text("previous_basis_id"),
  currentAppliedAt: timestamp("current_applied_at", { withTimezone: true }),
  previousAppliedAt: timestamp("previous_applied_at", { withTimezone: true }),
  generation: bigint("generation", { mode: "bigint" }).notNull().default(sql`0`),
  activeOperationId: text("active_operation_id"),
  monitor: jsonb("monitor"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, table => [
  foreignKey({ name: "series_radar_state_desired_basis_fk", columns: [table.desiredBasisId, table.gameTitleId], foreignColumns: [seriesRadarBases.id, seriesRadarBases.gameTitleId] }),
  foreignKey({ name: "series_radar_state_current_basis_fk", columns: [table.currentBasisId, table.gameTitleId], foreignColumns: [seriesRadarBases.id, seriesRadarBases.gameTitleId] }),
  foreignKey({ name: "series_radar_state_previous_basis_fk", columns: [table.previousBasisId, table.gameTitleId], foreignColumns: [seriesRadarBases.id, seriesRadarBases.gameTitleId] }),
  foreignKey({ name: "series_radar_state_operation_fk", columns: [table.activeOperationId, table.gameTitleId], foreignColumns: [seriesRadarOperations.id, seriesRadarOperations.gameTitleId] }),
  check("series_radar_states_generation_check", sql`${table.generation} >= 0`),
  check("series_radar_states_current_pair_check", sql`(${table.currentBasisId} IS NULL) = (${table.currentAppliedAt} IS NULL)`),
  check("series_radar_states_previous_pair_check", sql`(${table.previousBasisId} IS NULL) = (${table.previousAppliedAt} IS NULL)`),
  check("series_radar_states_distinct_check", sql`${table.currentBasisId} IS NULL OR ${table.previousBasisId} IS NULL OR ${table.currentBasisId} <> ${table.previousBasisId}`)
]);

export const seriesRadarAcknowledgements = pgTable("series_radar_acknowledgements", {
  gameTitleId: text("game_title_id").notNull().references(() => gameTitles.id, { onDelete: "cascade" }),
  evidenceKey: text("evidence_key").notNull(),
  requestedBy: text("requested_by").notNull(),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }).notNull().defaultNow()
}, table => [primaryKey({ columns: [table.gameTitleId, table.evidenceKey] })]);
