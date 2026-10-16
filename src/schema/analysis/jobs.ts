import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { gameTitles } from "../catalog.js";
import { seriesRadarBases } from "../radar.js";
import { seriesAnalysisOperationRequests, seriesAnalysisCampaigns } from "./operations.js";
import {
  checkSeriesAnalysisValidationContract,
  checkSeriesAnalysisValidationSchema
} from "./checks.js";

export const seriesAnalysisJobs = pgTable(
  "series_analysis_jobs",
  {
    id: text("id").primaryKey(),
    workKind: text("work_kind").notNull().default("analysis"),
    radarOperationId: text("radar_operation_id"),
    radarBasisId: text("radar_basis_id").references(() => seriesRadarBases.id),
    radarGeneration: bigint("radar_generation", { mode: "bigint" }).notNull().default(sql`0`),
    gameTitleId: text("game_title_id")
      .notNull()
      .references(() => gameTitles.id, { onDelete: "cascade" }),
    inputRevision: bigint("input_revision", { mode: "bigint" }).notNull(),
    algorithmVersion: text("algorithm_version").notNull(),
    artifactSchemaVersion: integer("artifact_schema_version").notNull(),
    validationContractId: text("validation_contract_id"),
    status: text("status").notNull().default("queued"),
    trigger: text("trigger").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    leaseOwner: text("lease_owner"),
    leaseAttemptId: text("lease_attempt_id"),
    leaseFencingToken: bigint("lease_fencing_token", { mode: "bigint" }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    leaseValidationContractId: text("lease_validation_contract_id"),
    attemptCount: integer("attempt_count").notNull().default(0),
    transientRetryCount: integer("transient_retry_count").notNull().default(0),
    leaseRecoveryCount: integer("lease_recovery_count").notNull().default(0),
    resultDisposition: text("result_disposition").notNull().default("none"),
    outputChecksum: text("output_checksum"),
    safeFailureCode: text("safe_failure_code"),
    elapsedMilliseconds: bigint("elapsed_milliseconds", { mode: "bigint" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    check("series_analysis_jobs_work_kind_check", sql`${table.workKind} IN ('analysis','radar_prepare')`),
    check("series_analysis_jobs_radar_purpose_check", sql`(${table.workKind} = 'radar_prepare') = (${table.radarOperationId} IS NOT NULL) AND ${table.radarGeneration} >= 0`),
    check(
      "series_analysis_jobs_input_revision_check",
      sql`${table.inputRevision} >= 0`
    ),
    check(
      "series_analysis_jobs_schema_version_check",
      sql`${table.artifactSchemaVersion} >= 1`
    ),
    checkSeriesAnalysisValidationContract(
      "series_analysis_jobs_validation_contract_check",
      table.validationContractId
    ),
    checkSeriesAnalysisValidationSchema(
      "series_analysis_jobs_validation_schema_check",
      table.artifactSchemaVersion,
      table.validationContractId
    ),
    checkSeriesAnalysisValidationContract(
      "series_analysis_jobs_lease_validation_id_check",
      table.leaseValidationContractId
    ),
    check(
      "series_analysis_jobs_status_check",
      sql`${table.status} IN ('queued','running','succeeded','failed','timed_out')`
    ),
    check(
      "series_analysis_jobs_trigger_check",
      sql`${table.trigger} IN ('manual','artifact_schema_update','algorithm_update','validation_contract_update','initial_backfill','match_mutation')`
    ),
    check(
      "series_analysis_jobs_counts_check",
      sql`${table.attemptCount} >= 0 AND ${table.transientRetryCount} BETWEEN 0 AND 3 AND ${table.leaseRecoveryCount} BETWEEN 0 AND 3`
    ),
    check(
      "series_analysis_jobs_result_disposition_check",
      sql`${table.resultDisposition} IN ('published','reused','none')`
    ),
    check(
      "series_analysis_jobs_lease_shape_check",
      sql`(${table.status} = 'running' AND ${table.leaseOwner} IS NOT NULL AND ${table.leaseAttemptId} IS NOT NULL AND ${table.leaseFencingToken} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL) OR (${table.status} <> 'running' AND ${table.leaseOwner} IS NULL AND ${table.leaseAttemptId} IS NULL AND ${table.leaseFencingToken} IS NULL AND ${table.leaseExpiresAt} IS NULL)`
    ),
    check(
      "series_analysis_jobs_lease_validation_contract_check",
      sql`(${table.status} = 'running' AND ${table.leaseValidationContractId} IS NOT DISTINCT FROM ${table.validationContractId}) OR (${table.status} <> 'running' AND ${table.leaseValidationContractId} IS NULL)`
    ),
    check(
      "series_analysis_jobs_terminal_shape_check",
      sql`(${table.status} IN ('succeeded','failed','timed_out')) = (${table.finishedAt} IS NOT NULL)`
    ),
    index("series_analysis_jobs_title_terminal_idx")
      .on(table.gameTitleId, table.finishedAt.desc().nullsLast(), table.id.desc().nullsFirst())
      .where(sql`${table.workKind} = 'analysis' AND ${table.status} IN ('succeeded','failed','timed_out')`),
    index("series_analysis_jobs_recent_idx")
      .on(table.createdAt.desc().nullsFirst(), table.id.desc().nullsFirst())
      .where(sql`${table.workKind} = 'analysis'`),
    uniqueIndex("series_analysis_jobs_active_title_unique")
      .on(table.gameTitleId)
      .where(sql`${table.status} IN ('queued','running')`),
    index("series_analysis_jobs_claim_idx")
      .on(table.availableAt, table.requestedAt, table.id)
      .where(sql`${table.status} = 'queued'`),
    index("series_analysis_jobs_terminal_cleanup_idx")
      .on(table.finishedAt)
      .where(sql`${table.status} IN ('succeeded','failed','timed_out')`)
  ]
);

export const seriesAnalysisJobRequests = pgTable(
  "series_analysis_job_requests",
  {
    id: text("id").primaryKey(),
    gameTitleId: text("game_title_id").notNull(),
    operationRequestId: text("operation_request_id").references(
      () => seriesAnalysisOperationRequests.id,
      { onDelete: "cascade" }
    ),
    campaignId: text("campaign_id").references(() => seriesAnalysisCampaigns.id, {
      onDelete: "cascade"
    }),
    inputRevision: bigint("input_revision", { mode: "bigint" }).notNull(),
    algorithmVersion: text("algorithm_version").notNull(),
    artifactSchemaVersion: integer("artifact_schema_version").notNull(),
    validationContractId: text("validation_contract_id"),
    trigger: text("trigger").notNull(),
    forceRun: boolean("force_run").notNull().default(false),
    status: text("status").notNull().default("pending"),
    assignedJobId: text("assigned_job_id").references(() => seriesAnalysisJobs.id, {
      onDelete: "set null"
    }),
    assignedAttemptId: text("assigned_attempt_id"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    fulfilledAt: timestamp("fulfilled_at", { withTimezone: true })
  },
  (table) => [
    check(
      "series_analysis_job_requests_input_revision_check",
      sql`${table.inputRevision} >= 0`
    ),
    check(
      "series_analysis_job_requests_schema_version_check",
      sql`${table.artifactSchemaVersion} >= 1`
    ),
    checkSeriesAnalysisValidationContract(
      "series_analysis_job_requests_validation_contract_check",
      table.validationContractId
    ),
    checkSeriesAnalysisValidationSchema(
      "series_analysis_job_requests_validation_schema_check",
      table.artifactSchemaVersion,
      table.validationContractId
    ),
    check(
      "series_analysis_job_requests_status_check",
      sql`${table.status} IN ('pending','assigned','fulfilled')`
    ),
    check(
      "series_analysis_job_requests_trigger_check",
      sql`${table.trigger} IN ('manual','artifact_schema_update','algorithm_update','validation_contract_update','initial_backfill','match_mutation')`
    ),
    check(
      "series_analysis_job_requests_fulfilled_shape_check",
      sql`(${table.status} = 'fulfilled') = (${table.fulfilledAt} IS NOT NULL)`
    ),
    index("series_analysis_job_requests_pending_title_idx")
      .on(table.gameTitleId, table.acceptedAt, table.id)
      .where(sql`${table.status} IN ('pending','assigned')`),
    index("series_analysis_job_requests_operation_idx")
      .on(table.operationRequestId)
      .where(sql`${table.operationRequestId} IS NOT NULL`),
    index("series_analysis_job_requests_campaign_idx")
      .on(table.campaignId)
      .where(sql`${table.campaignId} IS NOT NULL`),
    index("series_analysis_job_requests_job_idx")
      .on(table.assignedJobId, table.acceptedAt, table.id)
      .where(sql`${table.assignedJobId} IS NOT NULL`),
    index("series_analysis_job_requests_attempt_idx")
      .on(table.assignedAttemptId)
      .where(sql`${table.assignedAttemptId} IS NOT NULL`),
    index("series_analysis_job_requests_terminal_cleanup_idx")
      .on(table.fulfilledAt)
      .where(sql`${table.status} = 'fulfilled'`)
  ]
);

export const seriesAnalysisJobAttempts = pgTable(
  "series_analysis_job_attempts",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => seriesAnalysisJobs.id, { onDelete: "cascade" }),
    attemptNo: integer("attempt_no").notNull(),
    owner: text("owner").notNull(),
    fencingToken: bigint("fencing_token", { mode: "bigint" }).notNull(),
    inputRevision: bigint("input_revision", { mode: "bigint" }).notNull(),
    algorithmVersion: text("algorithm_version").notNull(),
    artifactSchemaVersion: integer("artifact_schema_version").notNull(),
    validationContractId: text("validation_contract_id"),
    status: text("status").notNull().default("running"),
    outcome: text("outcome"),
    effectiveConfigVersion: text("effective_config_version").notNull(),
    calculationTimeoutMilliseconds: bigint("calculation_timeout_milliseconds", {
      mode: "bigint"
    }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    elapsedMilliseconds: bigint("elapsed_milliseconds", { mode: "bigint" }),
    calculationMilliseconds: bigint("calculation_milliseconds", {
      mode: "bigint"
    }),
    stagingMilliseconds: bigint("staging_milliseconds", { mode: "bigint" }),
    publicationMilliseconds: bigint("publication_milliseconds", {
      mode: "bigint"
    }),
    childPeakBytes: bigint("child_peak_bytes", { mode: "bigint" }),
    workerPeakBytes: bigint("worker_peak_bytes", { mode: "bigint" })
  },
  (table) => [
    uniqueIndex("series_analysis_job_attempts_job_no_unique").on(
      table.jobId,
      table.attemptNo
    ),
    check(
      "series_analysis_job_attempts_positive_check",
      sql`${table.attemptNo} >= 1 AND ${table.fencingToken} >= 1 AND ${table.inputRevision} >= 0 AND ${table.artifactSchemaVersion} >= 1 AND ${table.calculationTimeoutMilliseconds} >= 1`
    ),
    checkSeriesAnalysisValidationContract(
      "series_analysis_job_attempts_validation_contract_check",
      table.validationContractId
    ),
    checkSeriesAnalysisValidationSchema(
      "series_analysis_job_attempts_validation_schema_check",
      table.artifactSchemaVersion,
      table.validationContractId
    ),
    check(
      "series_analysis_job_attempts_status_check",
      sql`${table.status} IN ('running','terminal')`
    ),
    check(
      "series_analysis_job_attempts_terminal_shape_check",
      sql`(${table.status} = 'terminal' AND ${table.outcome} IS NOT NULL AND ${table.finishedAt} IS NOT NULL) OR (${table.status} = 'running' AND ${table.outcome} IS NULL AND ${table.finishedAt} IS NULL)`
    ),
    check(
      "series_analysis_job_attempts_outcome_check",
      sql`${table.outcome} IS NULL OR ${table.outcome} IN ('succeeded','failed','timed_out','superseded','preempted','owner_lost','graceful_stop')`
    ),
    index("series_analysis_job_attempts_running_idx")
      .on(table.startedAt)
      .where(sql`${table.status} = 'running'`)
  ]
);

export const seriesAnalysisWorkerCapabilities = pgTable(
  "series_analysis_worker_capabilities",
  {
    workerId: text("worker_id").primaryKey(),
    algorithmVersions: jsonb("algorithm_versions").notNull(),
    artifactSchemaVersions: jsonb("artifact_schema_versions").notNull(),
    validationContractIds: jsonb("validation_contract_ids")
      .notNull()
      .default(sql`'[]'::jsonb`),
    draining: boolean("draining").notNull().default(false),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    check(
      "series_analysis_worker_capabilities_algorithms_array_check",
      sql`jsonb_typeof(${table.algorithmVersions}) = 'array'`
    ),
    check(
      "series_analysis_worker_capabilities_schemas_array_check",
      sql`jsonb_typeof(${table.artifactSchemaVersions}) = 'array'`
    ),
    check(
      "series_analysis_worker_validation_contracts_array_check",
      sql`jsonb_typeof(${table.validationContractIds}) = 'array'`
    ),
    index("series_analysis_worker_capabilities_heartbeat_idx").on(
      table.heartbeatAt
    )
  ]
);

export const seriesAnalysisReaderCapabilities = pgTable(
  "series_analysis_reader_capabilities",
  {
    readerId: text("reader_id").primaryKey(),
    artifactSchemaVersions: jsonb("artifact_schema_versions").notNull(),
    validationContractIds: jsonb("validation_contract_ids")
      .notNull()
      .default(sql`'[]'::jsonb`),
    draining: boolean("draining").notNull().default(false),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    check(
      "series_analysis_reader_capabilities_schemas_array_check",
      sql`jsonb_typeof(${table.artifactSchemaVersions}) = 'array'`
    ),
    check(
      "series_analysis_reader_validation_contracts_array_check",
      sql`jsonb_typeof(${table.validationContractIds}) = 'array'`
    ),
    index("series_analysis_reader_capabilities_heartbeat_idx").on(
      table.heartbeatAt
    )
  ]
);

export const workerExecutionSlots = pgTable(
  "worker_execution_slots",
  {
    slotKey: text("slot_key").primaryKey(),
    taskKind: text("task_kind"),
    owner: text("owner"),
    jobId: text("job_id"),
    attemptId: text("attempt_id"),
    holderPreemptible: boolean("holder_preemptible"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    fencingToken: bigint("fencing_token", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    preemptRequestedBy: text("preempt_requested_by"),
    preemptRequestedAt: timestamp("preempt_requested_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    check(
      "worker_execution_slots_key_check",
      sql`${table.slotKey} = 'shared-heavy-work'`
    ),
    check(
      "worker_execution_slots_task_kind_check",
      sql`${table.taskKind} IS NULL OR ${table.taskKind} IN ('analysis','ocr')`
    ),
    check(
      "worker_execution_slots_holder_shape_check",
      sql`(${table.owner} IS NULL AND ${table.taskKind} IS NULL AND ${table.jobId} IS NULL AND ${table.attemptId} IS NULL AND ${table.holderPreemptible} IS NULL AND ${table.leaseExpiresAt} IS NULL) OR (${table.owner} IS NOT NULL AND ${table.taskKind} IS NOT NULL AND ${table.jobId} IS NOT NULL AND ${table.attemptId} IS NOT NULL AND ${table.holderPreemptible} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)`
    ),
    check(
      "worker_execution_slots_preempt_shape_check",
      sql`(${table.preemptRequestedBy} IS NULL) = (${table.preemptRequestedAt} IS NULL)`
    ),
    check(
      "worker_execution_slots_fencing_token_check",
      sql`${table.fencingToken} >= 0`
    )
  ]
);
