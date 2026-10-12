import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { gameTitles } from "../catalog.js";
import { seriesAnalysisArtifacts } from "./artifacts.js";
import {
  checkSeriesAnalysisValidationContract,
  checkSeriesAnalysisValidationSchema
} from "./checks.js";

// source-of-truth: active analysis tuple inherited by titles registered after a promotion.
export const seriesAnalysisReleaseState = pgTable(
  "series_analysis_release_state",
  {
    singletonKey: text("singleton_key").primaryKey().default("current"),
    algorithmVersion: text("algorithm_version")
      .notNull()
      .default("series-analysis-v5"),
    artifactSchemaVersion: integer("artifact_schema_version")
      .notNull()
      .default(3),
    validationContractId: text("validation_contract_id").default(
      "series-analysis-artifact-v3-full-validation-v1"
    ),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    check(
      "series_analysis_release_state_singleton_check",
      sql`${table.singletonKey} = 'current'`
    ),
    check(
      "series_analysis_release_state_schema_version_check",
      sql`${table.artifactSchemaVersion} >= 1`
    ),
    checkSeriesAnalysisValidationContract(
      "series_analysis_release_state_validation_contract_check",
      table.validationContractId
    ),
    checkSeriesAnalysisValidationSchema(
      "series_analysis_release_state_validation_schema_check",
      table.artifactSchemaVersion,
      table.validationContractId
    )
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
    validationContractId: text("validation_contract_id"),
    pendingWork: boolean("pending_work").notNull().default(false),
    pendingForcedRunCount: integer("pending_forced_run_count")
      .notNull()
      .default(0),
    lastFailureCode: text("last_failure_code"),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
    currentArtifactId: text("current_artifact_id"),
    previousArtifactId: text("previous_artifact_id"),
    notificationBaselineState: text("notification_baseline_state")
      .notNull()
      .default("unknown"),
    notificationBaselineArtifactId: text("notification_baseline_artifact_id"),
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
    checkSeriesAnalysisValidationContract(
      "series_analysis_title_states_validation_contract_check",
      table.validationContractId
    ),
    checkSeriesAnalysisValidationSchema(
      "series_analysis_title_states_validation_schema_check",
      table.artifactSchemaVersion,
      table.validationContractId
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
    check(
      "series_analysis_title_states_notification_baseline_check",
      sql`(${table.notificationBaselineState} = 'artifact' AND ${table.notificationBaselineArtifactId} IS NOT NULL) OR (${table.notificationBaselineState} IN ('initial', 'unknown') AND ${table.notificationBaselineArtifactId} IS NULL)`
    ),
    foreignKey({
      columns: [table.notificationBaselineArtifactId, table.gameTitleId],
      foreignColumns: [
        seriesAnalysisArtifacts.id,
        seriesAnalysisArtifacts.gameTitleId
      ],
      name: "series_analysis_title_states_notification_baseline_artifact_fk"
    }).onDelete("restrict"),
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
