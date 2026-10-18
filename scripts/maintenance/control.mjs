import { createHash } from 'node:crypto';

export class ControlError extends Error {
  constructor(code) { super(code); this.name = 'ControlError'; this.code = code; }
}
const check = (condition, code) => { if (!condition) throw new ControlError(code); };
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 1;
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const repositories = { db: 'ponta2git/momo-db', summit: 'ponta2git/summit', result: 'ponta2git/momo-result' };
const nextPhase = {
  PREPARING: 'DRAINING', DRAINING: 'FROZEN', FROZEN: 'VERIFIED', VERIFIED: 'DB_APPLIED',
  DB_APPLIED: 'SUMMIT_STAGED', SUMMIT_STAGED: 'CONSUMERS_STAGED', CONSUMERS_STAGED: 'READY_TO_RESUME',
  READY_TO_RESUME: 'REOPENING', REOPENING: 'RESUMED',
  RECOVERY_READY: 'RECOVERY_REOPENING', RECOVERY_REOPENING: 'RECOVERY_RESUMED',
};
const operationPhase = {
  database: ['VERIFIED'], consumers: ['SUMMIT_STAGED'],
  analysis: ['CONSUMERS_STAGED', 'READY_TO_RESUME'], publish: ['RESUMED'],
};
// This one preparation operation uses its own receipt and transition validator.
// It must never inherit the migration/deploy receipt or ordinary mutation guard.
export const preparationRepairOperation = 'preparation-runtime-repair';
const shaKey = { database: 'db', consumers: 'result', analysis: 'result', publish: 'result' };
export const operationWorkflow = {
  database: '.github/workflows/ci.yml', consumers: '.github/workflows/deploy-maintenance.yml',
  analysis: '.github/workflows/analysis-maintenance.yml', publish: '.github/workflows/runtime-release.yml',
};
const phaseEvidence = {
  DRAINING: 'deploymentFreeze', FROZEN: 'writersStopped', VERIFIED: 'finalRehearsal',
  DB_APPLIED: 'databaseApplied', SUMMIT_STAGED: 'summitReady', CONSUMERS_STAGED: 'consumersReady',
  READY_TO_RESUME: 'resumeReadiness', REOPENING: 'reopenBoundary', RESUMED: 'stability',
  RECOVERY_READY: 'recoveryReadiness', RECOVERY_REOPENING: 'recoveryReopenBoundary', RECOVERY_RESUMED: 'recoveryStability',
};

export function canonicalJson(value) {
  const sort = item => Array.isArray(item) ? item.map(sort) : item && typeof item === 'object' ?
    Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])])) : item;
  return JSON.stringify(sort(value));
}
export const digest = value => createHash('sha256').update(canonicalJson(value)).digest('hex');

function exactKeys(value, keys, code) {
  check(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(key => keys.includes(key)) && keys.every(key => key in value), code);
}

export function validateControl(record) {
  exactKeys(record, ['formatVersion', 'stateVersion', 'operator', 'updatedAt', 'epoch', 'completed', 'cutover'], 'INVALID_CONTROL_RECORD');
  check(record.formatVersion === 1 && integer(record.stateVersion), 'INVALID_CONTROL_VERSION');
  check(typeof record.operator === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(record.operator), 'INVALID_OPERATOR');
  check(timestamp(record.updatedAt), 'INVALID_CONTROL_TIME');
  check(Number.isSafeInteger(record.epoch) && record.epoch >= 0, 'INVALID_CONTROL_EPOCH');
  if (record.completed !== null) {
    exactKeys(record.completed, ['id', 'stopEpoch', 'outcome', 'evidenceDigest', 'completedAt'], 'INVALID_COMPLETION');
    check(id(record.completed.id) && integer(record.completed.stopEpoch) && record.completed.stopEpoch <= record.epoch &&
      ['published', 'recovered'].includes(record.completed.outcome) && hash(record.completed.evidenceDigest) && timestamp(record.completed.completedAt), 'INVALID_COMPLETION');
  }
  if (record.cutover === null) return record;
  const cutover = record.cutover;
  exactKeys(cutover, ['id', 'stopEpoch', 'phase', 'candidates', 'evidence', 'permits', 'invalidatedReason'], 'INVALID_CUTOVER');
  check(id(cutover.id) && integer(cutover.stopEpoch) && cutover.stopEpoch === record.epoch, 'INVALID_STOP_IDENTITY');
  check([...Object.keys(nextPhase), 'RESUMED', 'RECOVERY_RESUMED', 'INVALIDATED'].includes(cutover.phase), 'INVALID_PHASE');
  check(cutover.invalidatedReason === null || ['writer-reopened', 'unplanned-deploy', 'uncertain-stop', 'recovery-target-changed'].includes(cutover.invalidatedReason), 'INVALID_INVALIDATION_REASON');
  if (cutover.candidates !== null) {
    exactKeys(cutover.candidates, ['db', 'summit', 'result'], 'INVALID_CANDIDATES');
    check(Object.values(cutover.candidates).every(sha), 'INVALID_CANDIDATE_SHA');
  }
  check(['PREPARING', 'INVALIDATED', 'RECOVERY_READY', 'RECOVERY_REOPENING', 'RECOVERY_RESUMED'].includes(cutover.phase) || cutover.candidates !== null, 'CANDIDATES_REQUIRED');
  check(cutover.evidence && typeof cutover.evidence === 'object' && !Array.isArray(cutover.evidence) &&
    Object.entries(cutover.evidence).every(([name, value]) =>
      (Object.values(phaseEvidence).includes(name) || name === 'preparationRepair') && hash(value)), 'INVALID_EVIDENCE');
  check(Array.isArray(cutover.permits) && cutover.permits.length <= 32, 'INVALID_PERMITS');
  for (const permit of cutover.permits) validatePermit(permit);
  if (cutover.permits.some(permit => permit.operation === preparationRepairOperation)) {
    check(cutover.phase === 'PREPARING' && cutover.candidates === null && cutover.permits.length === 1 &&
      Object.keys(cutover.evidence).length === 0 && cutover.invalidatedReason === null, 'INVALID_PREPARATION_REPAIR_STATE');
  }
  check(new Set(cutover.permits.map(permit => `${permit.repository}:${permit.runId}:${permit.runAttempt}:${permit.operation}`)).size === cutover.permits.length, 'DUPLICATE_PERMIT');
  return record;
}

function validatePermit(permit) {
  exactKeys(permit, ['operation', 'repository', 'runId', 'runAttempt', 'receiptDigest', 'deadline'], 'INVALID_PERMIT');
  check(permit.operation === preparationRepairOperation ? permit.repository === repositories.result :
    permit.operation in operationPhase && permit.repository === repositories[shaKey[permit.operation]], 'INVALID_PERMIT_SCOPE');
  check(typeof permit.runId === 'string' && /^[1-9][0-9]{0,19}$/.test(permit.runId) && integer(permit.runAttempt), 'INVALID_RUN_ATTEMPT');
  check(hash(permit.receiptDigest) && timestamp(permit.deadline), 'INVALID_PERMIT_EVIDENCE');
}

export function initialControl(operator, now = new Date().toISOString()) {
  return validateControl({ formatVersion: 1, stateVersion: 1, operator, updatedAt: now, epoch: 0, completed: null, cutover: null });
}

// The store updates one protected Git ref by fast-forward CAS. These operations
// never infer an expired lease as permission to reopen ordinary writers.
export function transition(record, expectedVersion, action, payload, now = new Date().toISOString()) {
  validateControl(record);
  check(record.stateVersion === expectedVersion, 'STALE_CONTROL_VERSION');
  const result = structuredClone(record);
  const cutover = result.cutover;
  if (action === 'begin') {
    check(cutover === null && id(payload.cutoverId), 'CUTOVER_ALREADY_ACTIVE_OR_INVALID');
    result.epoch++;
    result.cutover = { id: payload.cutoverId, stopEpoch: result.epoch, phase: 'PREPARING', candidates: null,
      evidence: {}, permits: [], invalidatedReason: null };
  } else {
    check(cutover !== null && payload.cutoverId === cutover.id && payload.stopEpoch === cutover.stopEpoch, 'STOP_IDENTITY_MISMATCH');
    if (action === 'pin') {
      check(['PREPARING', 'INVALIDATED'].includes(cutover.phase), 'CANDIDATES_ALREADY_FROZEN');
      check(!cutover.permits.some(permit => permit.operation === preparationRepairOperation), 'PREPARATION_REPAIR_IN_PROGRESS');
      cutover.candidates = payload.candidates;
    } else if (action === 'advance') {
      check(nextPhase[cutover.phase] === payload.phase && hash(payload.evidenceDigest), 'INVALID_PHASE_TRANSITION');
      check(cutover.phase.startsWith('RECOVERY_') || cutover.candidates !== null, 'CANDIDATES_REQUIRED');
      cutover.phase = payload.phase;
      cutover.evidence[phaseEvidence[payload.phase]] = payload.evidenceDigest;
      cutover.permits = [];
    } else if (action === 'permit') {
      validatePermit(payload.permit);
      check(payload.permit.operation !== preparationRepairOperation, 'DEDICATED_PREPARATION_REPAIR_GRANT_REQUIRED');
      check(operationPhase[payload.permit.operation].includes(cutover.phase), 'OPERATION_NOT_ALLOWED_IN_PHASE');
      check(Date.parse(payload.permit.deadline) > Date.parse(now), 'PERMIT_DEADLINE_PASSED');
      // Retrying a run needs a new exact attempt and newly reviewed receipt.
      cutover.permits = cutover.permits.filter(item => item.operation !== payload.permit.operation);
      cutover.permits.push(payload.permit);
    } else if (action === 'invalidate') {
      check(!['REOPENING', 'RESUMED', 'RECOVERY_REOPENING', 'RECOVERY_RESUMED'].includes(cutover.phase), 'REOPENED_CUTOVER_REQUIRES_FORWARD_FIX');
      cutover.stopEpoch = ++result.epoch;
      cutover.phase = 'INVALIDATED';
      cutover.invalidatedReason = payload.reason;
      cutover.evidence = {};
      cutover.permits = [];
    } else if (action === 'refreeze') {
      check(cutover.phase === 'INVALIDATED' && hash(payload.deploymentFreezeDigest), 'INVALID_REFREEZE');
      cutover.phase = 'DRAINING';
      cutover.invalidatedReason = null;
      cutover.evidence.deploymentFreeze = payload.deploymentFreezeDigest;
    } else if (action === 'recovery-ready') {
      check(!['REOPENING', 'RESUMED', 'RECOVERY_REOPENING', 'RECOVERY_RESUMED'].includes(cutover.phase), 'REOPENED_CUTOVER_REQUIRES_FORWARD_FIX');
      check(hash(payload.recoveryEvidenceDigest), 'RECOVERY_EVIDENCE_REQUIRED');
      // A cancelled preparation or restored old configuration has its own
      // reopen path. It never pretends the new DB or consumers were deployed.
      cutover.stopEpoch = ++result.epoch;
      cutover.phase = 'RECOVERY_READY';
      cutover.evidence = { recoveryReadiness: payload.recoveryEvidenceDigest };
      cutover.permits = [];
      cutover.invalidatedReason = null;
    } else if (action === 'close') {
      check(cutover.phase === 'RESUMED' && hash(payload.publishedReleaseDigest), 'STABLE_PUBLISHED_RELEASE_REQUIRED');
      result.completed = { id: cutover.id, stopEpoch: cutover.stopEpoch, outcome: 'published',
        evidenceDigest: payload.publishedReleaseDigest, completedAt: now };
      result.cutover = null;
    } else if (action === 'close-recovery') {
      check(cutover.phase === 'RECOVERY_RESUMED' && hash(payload.recoveredReleaseDigest), 'STABLE_RECOVERED_RELEASE_REQUIRED');
      result.completed = { id: cutover.id, stopEpoch: cutover.stopEpoch, outcome: 'recovered',
        evidenceDigest: payload.recoveredReleaseDigest, completedAt: now };
      result.cutover = null;
    } else throw new ControlError('UNKNOWN_CONTROL_ACTION');
  }
  result.stateVersion++;
  result.updatedAt = now;
  return validateControl(result);
}

export function assertNormalMutation(record) {
  validateControl(record);
  check(record.cutover === null, 'NORMAL_MUTATION_HELD_FOR_MAINTENANCE');
}

export function validateReceipt(receipt) {
  exactKeys(receipt, ['formatVersion', 'operation', 'cutoverId', 'stopEpoch', 'candidates', 'evidence', 'producer', 'execution', 'scope'], 'INVALID_RECEIPT');
  check(receipt.formatVersion === 1 && receipt.operation in operationPhase && id(receipt.cutoverId) && integer(receipt.stopEpoch), 'INVALID_RECEIPT_IDENTITY');
  if (receipt.operation === 'analysis') {
    exactKeys(receipt.scope, ['operationId', 'campaignId', 'planDigest'], 'INVALID_ANALYSIS_SCOPE');
    check([receipt.scope.operationId, receipt.scope.campaignId].every(value =>
      typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) &&
      typeof receipt.scope.planDigest === 'string' && /^sha256:[a-f0-9]{64}$/.test(receipt.scope.planDigest), 'INVALID_ANALYSIS_SCOPE');
  } else if (receipt.operation === 'publish') {
    exactKeys(receipt.scope, ['deploymentRunId', 'deploymentRunAttempt', 'provenanceArtifactId', 'provenanceArtifactDigest'], 'INVALID_PUBLISH_SCOPE');
    check([receipt.scope.deploymentRunId, receipt.scope.provenanceArtifactId].every(value =>
      typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value)) && integer(receipt.scope.deploymentRunAttempt) &&
      hash(receipt.scope.provenanceArtifactDigest), 'INVALID_PUBLISH_SCOPE');
  } else check(receipt.scope === null, 'UNEXPECTED_RECEIPT_SCOPE');
  exactKeys(receipt.candidates, ['db', 'summit', 'result'], 'INVALID_RECEIPT_CANDIDATES');
  check(Object.values(receipt.candidates).every(sha), 'INVALID_RECEIPT_CANDIDATE_SHA');
  exactKeys(receipt.evidence, ['sourceIdentity', 'baselineLedger', 'targetLedger', 'pendingTail', 'savedData', 'baselineSchema',
    'targetData', 'targetSchema', 'snapshot', 'finalRehearsal', 'previousStage'], 'INVALID_RECEIPT_EVIDENCE');
  check(Object.values(receipt.evidence).every(hash), 'MISSING_REHEARSAL_EVIDENCE');
  exactKeys(receipt.producer, ['runId', 'runAttempt', 'artifacts', 'configDigest', 'secretVersion'], 'INVALID_PRODUCER');
  check(typeof receipt.producer.runId === 'string' && /^[1-9][0-9]{0,19}$/.test(receipt.producer.runId) && integer(receipt.producer.runAttempt), 'INVALID_PRODUCER_RUN');
  check(Array.isArray(receipt.producer.artifacts) && receipt.producer.artifacts.length >= 1 && receipt.producer.artifacts.length <= 8, 'PRODUCER_ARTIFACTS_REQUIRED');
  for (const artifact of receipt.producer.artifacts) {
    exactKeys(artifact, ['id', 'digest'], 'INVALID_ARTIFACT');
    check(typeof artifact.id === 'string' && /^[1-9][0-9]{0,19}$/.test(artifact.id) && hash(artifact.digest), 'INVALID_ARTIFACT_IDENTITY');
  }
  check(new Set(receipt.producer.artifacts.map(item => item.id)).size === receipt.producer.artifacts.length, 'DUPLICATE_PRODUCER_ARTIFACT');
  check(hash(receipt.producer.configDigest) && id(receipt.producer.secretVersion), 'INVALID_CONFIGURATION_IDENTITY');
  exactKeys(receipt.execution, ['repository', 'workflow', 'ref', 'sha', 'runId', 'runAttempt'], 'INVALID_EXECUTION');
  check(receipt.execution.repository === repositories[shaKey[receipt.operation]] &&
    receipt.execution.workflow === operationWorkflow[receipt.operation], 'INVALID_EXECUTION_SCOPE');
  check(receipt.execution.ref === `refs/heads/cutover/${receipt.cutoverId}` &&
    receipt.execution.sha === receipt.candidates[shaKey[receipt.operation]], 'EXECUTION_CANDIDATE_MISMATCH');
  check(typeof receipt.execution.runId === 'string' && /^[1-9][0-9]{0,19}$/.test(receipt.execution.runId) && integer(receipt.execution.runAttempt), 'INVALID_EXECUTION_ATTEMPT');
  return receipt;
}

export function assertReceiptScope(record, receipt, context, expectedOperation) {
  validateControl(record);
  validateReceipt(receipt);
  check(expectedOperation === receipt.operation, 'UNEXPECTED_OPERATION');
  const cutover = record.cutover;
  check(cutover && cutover.id === receipt.cutoverId && cutover.stopEpoch === receipt.stopEpoch, 'STOP_IDENTITY_MISMATCH');
  check(operationPhase[receipt.operation].includes(cutover.phase), 'OPERATION_NOT_ALLOWED_IN_PHASE');
  check(digest(cutover.candidates) === digest(receipt.candidates), 'CANDIDATE_CHANGED');
  check(cutover.evidence.finalRehearsal === receipt.evidence.finalRehearsal, 'FINAL_REHEARSAL_CHANGED');
  const previousEvidence = phaseEvidence[cutover.phase];
  check(cutover.evidence[previousEvidence] === receipt.evidence.previousStage, 'PREVIOUS_STAGE_EVIDENCE_CHANGED');
  check(context.eventName === 'workflow_dispatch' && digest(context.execution) === digest(receipt.execution), 'EXECUTION_TUPLE_CHANGED');
  return cutover;
}

export function assertMaintenanceMutation(record, receipt, context, expectedOperation, now = new Date().toISOString()) {
  const cutover = assertReceiptScope(record, receipt, context, expectedOperation);
  const permit = cutover.permits.find(item => item.operation === receipt.operation && item.repository === receipt.execution.repository &&
    item.runId === receipt.execution.runId && item.runAttempt === receipt.execution.runAttempt);
  check(permit && permit.receiptDigest === digest(receipt), 'EXACT_EXECUTION_NOT_PERMITTED');
  check(Date.parse(now) < Date.parse(permit.deadline), 'PERMIT_DEADLINE_PASSED');
  return { cutoverId: cutover.id, stopEpoch: cutover.stopEpoch, stateVersion: record.stateVersion, receiptDigest: digest(receipt) };
}
