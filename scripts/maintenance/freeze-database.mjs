import { fileURLToPath } from 'node:url';
import { loadCanonicalIdentityHistory, WORKER_SLOT_RETIREMENT_PROFILE } from '../migration/canonical-identities.mjs';
import { migrationHistoryMatches } from '../check-migration-history.mjs';
import { connect } from '../migration/database.mjs';
import { inspectConnectionProof } from './connection-proof.mjs';
import { check } from './freeze-contract.mjs';

// Keep the old writer inventory until the exact reviewed retirement history
// proves that the global slot was removed. Unknown missing tables still fail.
export const convergenceQueries = {
  ocrAdmissions: ['ocr_submissions', "status NOT IN ('settled','aborted')"],
  ocrMembers: ['ocr_submission_members', "status NOT IN ('registered','failed')"],
  ocrJobs: ['ocr_jobs', "status NOT IN ('succeeded','failed','cancelled') OR lease_owner IS NOT NULL OR lease_token IS NOT NULL OR lease_expires_at IS NOT NULL OR attempt_id IS NOT NULL"],
  analysisJobs: ['series_analysis_jobs', "status NOT IN ('succeeded','failed','timed_out') OR lease_owner IS NOT NULL OR lease_attempt_id IS NOT NULL OR lease_expires_at IS NOT NULL OR lease_fencing_token IS NOT NULL"],
  analysisRequests: ['series_analysis_job_requests', "status <> 'fulfilled'"],
  analysisOperations: ['series_analysis_operation_requests', "status <> 'terminal'"],
  analysisCampaigns: ['series_analysis_campaigns', "status <> 'terminal'"],
  analysisTargets: ['series_analysis_campaign_targets', "status NOT IN ('succeeded','failed','skipped_title_deleted')"],
  analysisAttempts: ['series_analysis_job_attempts', "status <> 'terminal'"],
  executionSlot: ['worker_execution_slots', 'owner IS NOT NULL OR task_kind IS NOT NULL OR job_id IS NOT NULL OR attempt_id IS NOT NULL OR lease_expires_at IS NOT NULL OR holder_preemptible IS NOT NULL OR preempt_requested_by IS NOT NULL OR preempt_requested_at IS NOT NULL'],
  resultNotifications: ['discord_notifications', "family = 'result' AND status NOT IN ('DELIVERED','FAILED','CANCELLED')"],
  notificationClaims: ['discord_notifications', "status = 'IN_FLIGHT' OR claim_token IS NOT NULL OR claim_expires_at IS NOT NULL"],
  notificationSends: ['discord_notification_parts', "status = 'IN_FLIGHT' OR (status = 'PENDING' AND (claim_token IS NOT NULL OR send_started_at IS NOT NULL))"],
};

export async function inspectConvergence(sql, url) {
  const database = await inspectConnectionProof(sql, url);
  const pending = {};
  for (const [name, [table, predicate]] of Object.entries(convergenceQueries)) {
    if (name === 'executionSlot') {
      const [relation] = await sql`SELECT to_regclass('public.worker_execution_slots') IS NOT NULL AS present`;
      if (!relation.present) {
        const expected = await loadCanonicalIdentityHistory(fileURLToPath(new URL('../../', import.meta.url)),
          { profile: WORKER_SLOT_RETIREMENT_PROFILE });
        const actual = await sql`SELECT hash, created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY id`;
        check(migrationHistoryMatches(expected.entries, actual), 'RETIRED_SLOT_HISTORY_REQUIRED');
        pending[name] = '0';
        continue;
      }
    }
    const [access] = await sql`SELECT row_security_active(${`public.${table}`}::regclass) AS filtered`;
    check(access?.filtered === false, 'UNFILTERED_WRITER_TABLE_REQUIRED');
    const [row] = await sql.unsafe(`SELECT count(*)::text AS count FROM public."${table}" WHERE ${predicate}`);
    check(/^[0-9]+$/.test(row?.count), 'INVALID_WRITER_COUNT');
    pending[name] = row.count;
  }
  const [visibility] = await sql`SELECT rolsuper OR pg_has_role(current_user, 'pg_read_all_stats', 'USAGE') AS visible
    FROM pg_roles WHERE rolname = current_user`;
  check(visibility?.visible === true, 'ALL_DATABASE_SESSIONS_MUST_BE_VISIBLE');
  const [active] = await sql`SELECT count(*)::text AS count FROM pg_stat_activity
    WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'
      AND (state IS DISTINCT FROM 'idle' OR xact_start IS NOT NULL)`;
  const [prepared] = await sql`SELECT count(*)::text AS count FROM pg_prepared_xacts WHERE database = current_database()`;
  const [attendance] = await sql`SELECT count(*)::text AS count FROM public.discord_notifications
    WHERE family = 'attendance' AND status = 'PENDING'`;
  check([active?.count, prepared?.count, attendance?.count].every(value => /^[0-9]+$/.test(value)), 'INVALID_WRITER_COUNT');
  return { database, pending, activeTransactions: active.count, preparedTransactions: prepared.count,
    retainedPendingAttendance: attendance.count };
}

export function isConverged(report, all = false) {
  check(report?.pending && Object.keys(report.pending).length === Object.keys(convergenceQueries).length &&
    Object.keys(convergenceQueries).every(name => /^[0-9]+$/.test(report.pending[name])), 'INCOMPLETE_CONVERGENCE_REPORT');
  return Object.values(report.pending).every(count => count === '0') && report.preparedTransactions === '0' &&
    (!all || report.activeTransactions === '0');
}

export async function readConvergence(url) {
  const sql = connect(url);
  try { return await sql.begin('isolation level repeatable read read only', tx => inspectConvergence(tx, url)); }
  finally { await sql.end(); }
}
