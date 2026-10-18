import {
  uuid,
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
import { momoLoginAccounts } from "../identity.js";
import {
  checkSeriesAnalysisValidationContract,
  checkSeriesAnalysisValidationSchema
} from "./checks.js";

export const seriesAnalysisOperationRequests = pgTable(
  "series_analysis_operation_requests",
  {
    legacyId: text("legacy_id").notNull().unique(),
    legacyGameTitleId: text("legacy_game_title_id"),
    id: uuid("id").primaryKey(),
    scope: text("scope").notNull(),
    gameTitleId: uuid("game_title_id"),
    requestedByAccountId: uuid("requested_by_account_id").references(
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
    check("series_analysis_operation_requests_game_title_legacy_null_check", sql`(${table.gameTitleId} IS NULL) = (${table.legacyGameTitleId} IS NULL)`),
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
    legacyId: text("legacy_id").notNull().unique(),
    id: uuid("id").primaryKey(),
    operationRequestId: uuid("operation_request_id")
      .notNull()
      .unique()
      .references(() => seriesAnalysisOperationRequests.id, {
        onDelete: "cascade"
      }),
    trigger: text("trigger").notNull(),
    algorithmVersion: text("algorithm_version").notNull(),
    artifactSchemaVersion: integer("artifact_schema_version").notNull(),
    validationContractId: text("validation_contract_id"),
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
      sql`${table.trigger} IN ('manual','algorithm_update','artifact_schema_update','validation_contract_update','initial_backfill')`
    ),
    check(
      "series_analysis_campaigns_status_check",
      sql`${table.status} IN ('queued','expanding','running','terminal')`
    ),
    check(
      "series_analysis_campaigns_schema_version_check",
      sql`${table.artifactSchemaVersion} >= 1`
    ),
    checkSeriesAnalysisValidationContract(
      "series_analysis_campaigns_validation_contract_check",
      table.validationContractId
    ),
    checkSeriesAnalysisValidationSchema(
      "series_analysis_campaigns_validation_schema_check",
      table.artifactSchemaVersion,
      table.validationContractId
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
    legacyGameTitleId: text("legacy_game_title_id").notNull(),
    legacyJobRequestId: text("legacy_job_request_id"),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => seriesAnalysisCampaigns.id, { onDelete: "cascade" }),
    gameTitleId: uuid("game_title_id").notNull(),
    inputRevision: bigint("input_revision", { mode: "bigint" }).notNull(),
    algorithmVersion: text("algorithm_version")
      .notNull()
      .default("series-analysis-v1"),
    artifactSchemaVersion: integer("artifact_schema_version")
      .notNull()
      .default(1),
    validationContractId: text("validation_contract_id"),
    status: text("status").notNull().default("pending"),
    jobRequestId: uuid("job_request_id"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    check("series_analysis_campaign_targets_job_request_legacy_null_check", sql`(${table.jobRequestId} IS NULL) = (${table.legacyJobRequestId} IS NULL)`),
    primaryKey({ columns: [table.campaignId, table.gameTitleId] }),
    check(
      "series_analysis_campaign_targets_input_revision_check",
      sql`${table.inputRevision} >= 0`
    ),
    check(
      "series_analysis_campaign_targets_schema_version_check",
      sql`${table.artifactSchemaVersion} >= 1`
    ),
    checkSeriesAnalysisValidationContract(
      "series_analysis_campaign_targets_validation_contract_check",
      table.validationContractId
    ),
    checkSeriesAnalysisValidationSchema(
      "series_analysis_campaign_targets_validation_schema_check",
      table.artifactSchemaVersion,
      table.validationContractId
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
