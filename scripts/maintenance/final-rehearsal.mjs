import { digest as databaseDigest } from '../migration/files.mjs';
import { compareFingerprints, historyState } from '../migration/database.mjs';
import { databaseSchemaDigest } from './apply-database.mjs';
import { digest, transition, validateControl, validateReceipt, operationWorkflow } from './control.mjs';
import { assertStop, check, same } from './freeze-contract.mjs';

const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
export const finalAcceptanceKinds = [
  'fresh-schema', 'application-role-mapping', 'consumer-startup-and-connection-switch',
  'legacy-http-auth-url-browser', 'analysis-compute-and-next-operation', 'notification-preservation',
  'ocr-input-object-and-deadlines', 'lease-and-scheduler', 'recovery-consumers-and-old-pools',
];

export function frozenBinding(plan, proof, sourceIdentity) {
  check(proof?.planDigest === digest(plan) && hash(sourceIdentity) && same(proof.candidates, plan.candidates) &&
    proof.cutoverId === plan.cutoverId && proof.stopEpoch === plan.stopEpoch && timestamp(proof.frozenAt), 'INVALID_FINAL_FREEZE');
  return { formatVersion: 1, cutoverId: plan.cutoverId, stopEpoch: plan.stopEpoch,
    candidates: plan.candidates, sourceIdentity, writersStoppedDigest: digest(proof), frozenAt: proof.frozenAt };
}

function snapshot(report) {
  check(report?.rows?.algorithm === 'sha256-row-multiset-v2' && Array.isArray(report.rows.tables) &&
    Array.isArray(report.rows.sequences) && report.rows.tables.length > 0, 'COMPLETE_DATABASE_FINGERPRINT_REQUIRED');
  const { algorithm, tables, sequences } = report.rows;
  check(report.rows.digest === databaseDigest({ algorithm, tables, sequences }), 'DATABASE_FINGERPRINT_CHANGED');
  check(report.connection.ledgerDigest === databaseDigest(report.connection.ledger), 'LEDGER_REPORT_CHANGED');
  return { ledger: report.connection.ledger, dataDigest: report.rows.digest,
    schemaDigest: databaseSchemaDigest(report.connection, report.schema) };
}

function restored(source, restored) {
  const before = snapshot(source); const after = snapshot(restored);
  check(same(before.ledger, after.ledger) && before.schemaDigest === after.schemaDigest, 'FINAL_RESTORED_SCHEMA_OR_LEDGER_CHANGED');
  compareFingerprints(source.rows, restored.rows, { sequences: true });
}

// These are explicit operator-reviewed application acceptance records. Hashes
// bind the actual private logs/reports; they never stand in for executing them.
export function validateFinalAcceptance(acceptance, manifest, operator, now) {
  check(acceptance?.formatVersion === 1 && acceptance.operator === operator && acceptance.runId === manifest.runId &&
    same(acceptance.candidates, manifest.finalFreeze.candidates) && acceptance.snapshotDigest === manifest.snapshot.archiveDigest &&
    acceptance.migratedDigest === manifest.migratedDigest && acceptance.recoveredDigest === manifest.recoveredDigest &&
    same(acceptance.incomplete, []), 'FINAL_ACCEPTANCE_SCOPE_CHANGED');
  check(timestamp(acceptance.reviewedAt) && Date.parse(acceptance.reviewedAt) <= now &&
    timestamp(acceptance.validUntil) && now < Date.parse(acceptance.validUntil), 'FINAL_ACCEPTANCE_EXPIRED');
  check(Array.isArray(acceptance.checks) && acceptance.checks.length === finalAcceptanceKinds.length &&
    finalAcceptanceKinds.every(kind => acceptance.checks.filter(item => item.kind === kind).length === 1), 'FINAL_ACCEPTANCE_INCOMPLETE');
  for (const item of acceptance.checks) {
    check(item.outcome === 'passed' && hash(item.reportDigest) && hash(item.executionDigest) &&
      Number.isSafeInteger(item.durationMs) && item.durationMs >= 0 && timestamp(item.completedAt) &&
      Date.parse(item.completedAt) >= Date.parse(manifest.snapshot.capturedAt) &&
      Date.parse(item.completedAt) <= Date.parse(acceptance.reviewedAt), 'FINAL_ACCEPTANCE_NOT_PASSED');
  }
}

export function buildFinalProof({ manifest, source, baseline, first, migrated, recovered, sourceNow,
  archiveDigest, expected, acceptance, plan, freezeProof, record, now = Date.now() }) {
  assertStop(record, plan, 'FROZEN');
  const binding = frozenBinding(plan, freezeProof, manifest.source.identity);
  check(same(manifest.finalFreeze, binding) && record.cutover.evidence.writersStopped === binding.writersStoppedDigest,
    'FINAL_FREEZE_CHANGED');
  check(manifest.candidate.sha === binding.candidates.db && manifest.candidate.migrationDigest === databaseDigest(expected),
    'FINAL_CANDIDATE_CHANGED');
  check(manifest.state === 'recovery-verified' && ['sourceSnapshot', 'restore', 'migratorFirstRun', 'migratorNoop',
    'migration', 'migrationSchema', 'savedRows', 'databaseRecovery'].every(name => manifest.checks[name] === true),
    'FINAL_REHEARSAL_INCOMPLETE');
  check(manifest.snapshot.mode === 'frozen-consistent-snapshot' && !manifest.snapshotOrigin && !manifest.snapshot.importedFrom &&
    manifest.snapshot.freezeDigest === databaseDigest(binding) && manifest.snapshot.archiveDigest === archiveDigest &&
    timestamp(manifest.snapshot.capturedAt) && Date.parse(manifest.snapshot.capturedAt) >= Date.parse(binding.frozenAt),
    'FINAL_COLD_SNAPSHOT_REQUIRED');
  for (const [report, expectedDigest] of [[source, manifest.snapshot.auditDigest], [baseline, manifest.baselineDigest],
    [first, manifest.firstMigrationDigest], [migrated, manifest.migratedDigest], [recovered, manifest.recoveredDigest]]) {
    check(hash(expectedDigest) && databaseDigest(report) === expectedDigest, 'FINAL_REPORT_DIGEST_CHANGED');
  }
  restored(source, baseline); restored(source, recovered);
  const old = snapshot(source); const target = snapshot(migrated);
  check(same(snapshot(first), target), 'FINAL_MIGRATOR_NOOP_CHANGED');
  check(historyState(expected, old.ledger) !== 'unknown' && historyState(expected, target.ledger) === 'target', 'FINAL_LEDGER_CHANGED');
  check(sourceNow.identity === binding.sourceIdentity && same(sourceNow.ledger, old.ledger) &&
    sourceNow.schemaDigest === old.schemaDigest && sourceNow.dataDigest === old.dataDigest, 'FINAL_SOURCE_CHANGED');
  check(now < Date.parse(plan.deadline) - plan.recoveryReserveMs, 'FINAL_REHEARSAL_TIME_BUDGET_EXHAUSTED');
  validateFinalAcceptance(acceptance, manifest, record.operator, now);
  const evidence = { sourceIdentity: binding.sourceIdentity, baselineLedger: databaseDigest(old.ledger),
    targetLedger: databaseDigest(expected), pendingTail: databaseDigest(expected.slice(old.ledger.length)),
    savedData: old.dataDigest, baselineSchema: old.schemaDigest, targetData: target.dataDigest,
    targetSchema: target.schemaDigest, snapshot: archiveDigest };
  return { formatVersion: 1, cutoverId: binding.cutoverId, stopEpoch: binding.stopEpoch, candidates: binding.candidates,
    runId: manifest.runId, verifiedAt: new Date(now).toISOString(), writersStoppedDigest: binding.writersStoppedDigest,
    manifestDigest: databaseDigest(manifest), acceptanceDigest: digest(acceptance), evidence,
    durationsMs: manifest.durationsMs, deadline: plan.deadline, recoveryReserveMs: plan.recoveryReserveMs };
}

export async function certifyFinalRehearsal(input, dependencies) {
  await dependencies.verifyFreeze();
  const sourceNow = await dependencies.captureSource();
  await dependencies.verifyFreeze();
  const current = await dependencies.store.read();
  const proof = buildFinalProof({ ...input, sourceNow, record: current.record, now: dependencies.now?.() ?? Date.now() });
  // Preserve the reviewable proof before its digest is published. A failed or
  // uncertain CAS never authorizes mutation or automatic normal-mode restart.
  await dependencies.save(proof);
  await dependencies.verifyFreeze();
  const previous = await dependencies.store.read();
  assertStop(previous.record, input.plan, 'FROZEN');
  check(previous.record.cutover.evidence.writersStopped === proof.writersStoppedDigest, 'FINAL_FREEZE_CHANGED');
  await dependencies.store.compareAndSwap(previous, transition(previous.record, previous.record.stateVersion, 'advance', {
    cutoverId: proof.cutoverId, stopEpoch: proof.stopEpoch, phase: 'VERIFIED', evidenceDigest: digest(proof),
  }, new Date(dependencies.now?.() ?? Date.now()).toISOString()));
  return proof;
}

export function receiptInput(proof, record, input) {
  validateControl(record);
  const stage = { database: ['VERIFIED', 'finalRehearsal'], consumers: ['SUMMIT_STAGED', 'summitReady'],
    analysis: [['CONSUMERS_STAGED', 'READY_TO_RESUME'], null], publish: ['RESUMED', 'stability'] }[input?.operation];
  const cutover = record.cutover;
  check(stage && cutover?.id === proof.cutoverId && cutover.stopEpoch === proof.stopEpoch &&
    same(cutover.candidates, proof.candidates) && cutover.evidence.finalRehearsal === digest(proof) &&
    [stage[0]].flat().includes(cutover.phase), 'FINAL_RECEIPT_CONTROL_CHANGED');
  const previous = stage[1] ?? (cutover.phase === 'CONSUMERS_STAGED' ? 'consumersReady' : 'resumeReadiness');
  const value = { formatVersion: 1, operation: input.operation, scope: input.scope ?? null,
    cutoverId: proof.cutoverId, stopEpoch: proof.stopEpoch, candidates: proof.candidates,
    evidence: { ...proof.evidence, finalRehearsal: digest(proof), previousStage: cutover.evidence[previous] }, producer: input.producer };
  // Validate the payload shape without inventing an authorized execution. CI
  // replaces this synthetic validation-only tuple with its actual run/attempt.
  const database = input.operation === 'database';
  validateReceipt({ ...value, execution: { repository: database ? 'ponta2git/momo-db' : 'ponta2git/momo-result',
    workflow: operationWorkflow[input.operation], ref: `refs/heads/cutover/${proof.cutoverId}`,
    sha: proof.candidates[database ? 'db' : 'result'], runId: '1', runAttempt: 1 } });
  return value;
}
