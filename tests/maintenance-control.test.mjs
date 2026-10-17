import assert from 'node:assert/strict';
import test from 'node:test';
import { initialControl, transition, assertNormalMutation, assertMaintenanceMutation,
  canonicalJson, digest, validateControl } from '../scripts/maintenance/control.mjs';
import { createStore } from '../scripts/maintenance/github-store.mjs';
import { executionContext } from '../scripts/maintenance/run.mjs';

const now = '2026-10-18T00:00:00.000Z';
const deadline = '2026-10-18T01:00:00.000Z';
const candidates = { db: 'a'.repeat(40), summit: 'b'.repeat(40), result: 'c'.repeat(40) };
const evidence = name => digest({ fixture: name });
const code = expected => error => error.code === expected;
function update(record, action, payload = {}) {
  return transition(record, record.stateVersion, action, { cutoverId: 'fixture-cutover',
    stopEpoch: record.cutover?.stopEpoch ?? 1, ...payload }, now);
}
function verified() {
  let record = update(initialControl('fixture-operator', now), 'begin');
  record = update(record, 'pin', { candidates });
  for (const phase of ['DRAINING', 'FROZEN', 'VERIFIED']) record = update(record, 'advance', { phase, evidenceDigest: evidence(phase) });
  return record;
}
function databaseReceipt() {
  return {
    formatVersion: 1, operation: 'database', scope: null, cutoverId: 'fixture-cutover', stopEpoch: 1, candidates,
    evidence: { sourceIdentity: evidence('source'), baselineLedger: evidence('baseline'), targetLedger: evidence('target'),
      pendingTail: evidence('tail'), savedData: evidence('saved'), baselineSchema: evidence('baseline-schema'),
      targetData: evidence('target-data'), targetSchema: evidence('target-schema'), snapshot: evidence('archive'),
      finalRehearsal: evidence('VERIFIED'), previousStage: evidence('VERIFIED') },
    producer: { runId: '100', runAttempt: 1, artifacts: [{ id: '200', digest: evidence('artifact') }],
      configDigest: evidence('config'), secretVersion: 'opaque-version' },
    execution: { repository: 'ponta2git/momo-db', workflow: '.github/workflows/ci.yml',
      ref: 'refs/heads/cutover/fixture-cutover', sha: candidates.db, runId: '300', runAttempt: 1 },
  };
}
function permit(record, receipt) {
  return update(record, 'permit', { permit: { operation: receipt.operation, repository: receipt.execution.repository,
    runId: receipt.execution.runId, runAttempt: receipt.execution.runAttempt, receiptDigest: digest(receipt), deadline } });
}
const context = receipt => ({ eventName: 'workflow_dispatch', execution: structuredClone(receipt.execution) });

test('normal mutations remain closed across process exits, expiry, phase progress and stale transitions', () => {
  assert.doesNotThrow(() => assertNormalMutation(initialControl('fixture-operator', now)));
  const record = verified();
  const restarted = JSON.parse(canonicalJson(record));
  assert.throws(() => assertNormalMutation(restarted), code('NORMAL_MUTATION_HELD_FOR_MAINTENANCE'));
  assert.throws(() => transition(restarted, restarted.stateVersion - 1, 'advance', {}, now), code('STALE_CONTROL_VERSION'));
  assert.throws(() => update(restarted, 'advance', { phase: 'RESUMED', evidenceDigest: evidence('skip') }), code('INVALID_PHASE_TRANSITION'));
  const applied = update(restarted, 'advance', { phase: 'DB_APPLIED', evidenceDigest: evidence('applied') });
  assert.equal(applied.cutover.stopEpoch, restarted.cutover.stopEpoch);
  assert.equal(applied.cutover.evidence.finalRehearsal, restarted.cutover.evidence.finalRehearsal);
  assert.throws(() => assertNormalMutation(applied), code('NORMAL_MUTATION_HELD_FOR_MAINTENANCE'));
});

test('writer reopen invalidates final evidence and permits even when database rows later look unchanged', () => {
  const receipt = databaseReceipt();
  const record = permit(verified(), receipt);
  assert.doesNotThrow(() => assertMaintenanceMutation(record, receipt, context(receipt), 'database', now));
  const invalidated = update(record, 'invalidate', { reason: 'writer-reopened' });
  assert.equal(invalidated.cutover.stopEpoch, 2);
  assert.deepEqual(invalidated.cutover.evidence, {});
  assert.deepEqual(invalidated.cutover.permits, []);
  assert.throws(() => assertMaintenanceMutation(invalidated, receipt, context(receipt), 'database', now), code('STOP_IDENTITY_MISMATCH'));
  const restarted = update(invalidated, 'refreeze', { deploymentFreezeDigest: evidence('new-freeze') });
  assert.equal(restarted.cutover.phase, 'DRAINING');
  assert.throws(() => assertNormalMutation(restarted), code('NORMAL_MUTATION_HELD_FOR_MAINTENANCE'));
});

test('approval evidence binds the producer separately from the exact mutation run and attempt', () => {
  const receipt = databaseReceipt();
  const record = permit(verified(), receipt);
  for (const mutate of [
    value => { value.execution.runId = '301'; },
    value => { value.execution.runAttempt++; },
    value => { value.producer.artifacts[0].digest = evidence('different-image'); },
    value => { value.producer.runAttempt++; },
    value => { value.evidence.savedData = evidence('different-baseline'); },
  ]) {
    const changed = structuredClone(receipt); mutate(changed);
    assert.throws(() => assertMaintenanceMutation(record, changed, context(changed), 'database', now), code('EXACT_EXECUTION_NOT_PERMITTED'));
  }
  const wrongContext = context(receipt); wrongContext.execution.runAttempt++;
  assert.throws(() => assertMaintenanceMutation(record, receipt, wrongContext, 'database', now), code('EXECUTION_TUPLE_CHANGED'));
  const oldWorkflow = context(receipt); oldWorkflow.eventName = 'push'; oldWorkflow.execution.ref = 'refs/heads/master';
  assert.throws(() => assertMaintenanceMutation(record, receipt, oldWorkflow, 'database', now), code('EXECUTION_TUPLE_CHANGED'));
  assert.throws(() => assertMaintenanceMutation(record, receipt, context(receipt), 'database', deadline), code('PERMIT_DEADLINE_PASSED'));
  assert.throws(() => assertNormalMutation(record), code('NORMAL_MUTATION_HELD_FOR_MAINTENANCE'));
  const retry = structuredClone(receipt); retry.execution.runId = '302'; retry.execution.runAttempt = 2;
  const permitted = permit(record, retry);
  assert.equal(retry.producer.runAttempt, 1);
  assert.doesNotThrow(() => assertMaintenanceMutation(permitted, retry, context(retry), 'database', now));
  assert.throws(() => assertMaintenanceMutation(permitted, receipt, context(receipt), 'database', now), code('EXACT_EXECUTION_NOT_PERMITTED'));
});

test('reopening is recorded before writes and a reopened cutover cannot reuse backup rollback semantics', () => {
  let record = verified();
  for (const phase of ['DB_APPLIED', 'SUMMIT_STAGED', 'CONSUMERS_STAGED', 'READY_TO_RESUME', 'REOPENING']) {
    record = update(record, 'advance', { phase, evidenceDigest: evidence(phase) });
  }
  assert.throws(() => update(record, 'invalidate', { reason: 'uncertain-stop' }), code('REOPENED_CUTOVER_REQUIRES_FORWARD_FIX'));
  const publish = databaseReceipt();
  publish.operation = 'publish';
  publish.scope = { deploymentRunId: '400', deploymentRunAttempt: 1, provenanceArtifactId: '500', provenanceArtifactDigest: evidence('deployed') };
  publish.execution = { ...publish.execution, repository: 'ponta2git/momo-result', sha: candidates.result,
    workflow: '.github/workflows/runtime-release.yml' };
  assert.throws(() => permit(record, publish), code('OPERATION_NOT_ALLOWED_IN_PHASE'));
  record = update(record, 'advance', { phase: 'RESUMED', evidenceDigest: evidence('stable') });
  publish.evidence.previousStage = evidence('stable');
  record = permit(record, publish);
  assert.doesNotThrow(() => assertMaintenanceMutation(record, publish, context(publish), 'publish', now));
  assert.throws(() => assertNormalMutation(record), code('NORMAL_MUTATION_HELD_FOR_MAINTENANCE'));
  record = update(record, 'close', { publishedReleaseDigest: evidence('published') });
  assert.doesNotThrow(() => assertNormalMutation(record));
});

test('control records reject unknown secret fields and missing or malformed evidence', () => {
  const record = verified();
  assert.throws(() => validateControl({ ...record, databaseUrl: 'fixture-secret' }), code('INVALID_CONTROL_RECORD'));
  const malformed = structuredClone(record); delete malformed.cutover.stopEpoch;
  assert.throws(() => validateControl(malformed), code('INVALID_CUTOVER'));
  const missing = databaseReceipt(); missing.evidence.snapshot = '';
  assert.throws(() => assertMaintenanceMutation(record, missing, context(missing), 'database', now), code('MISSING_REHEARSAL_EVIDENCE'));
  assert.deepEqual(executionContext({ GITHUB_WORKFLOW_REF: 'ponta2git/momo-db/.github/workflows/ci.yml@refs/heads/cutover/fixture-cutover',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'ponta2git/momo-db', GITHUB_REF: missing.execution.ref,
    GITHUB_SHA: candidates.db, GITHUB_RUN_ID: '300', GITHUB_RUN_ATTEMPT: '1' }), context(missing));
});

test('an operation permit cannot authorize a different mutation or workflow entry', () => {
  const receipt = databaseReceipt();
  const record = permit(verified(), receipt);
  assert.throws(() => assertMaintenanceMutation(record, receipt, context(receipt), 'analysis', now), code('UNEXPECTED_OPERATION'));
  receipt.execution.workflow = '.github/workflows/analysis-maintenance.yml';
  assert.throws(() => assertMaintenanceMutation(record, receipt, context(receipt), 'database', now), code('INVALID_EXECUTION_SCOPE'));
});

test('analysis approval binds the existing operation, campaign and exact reviewed plan', () => {
  let record = verified();
  for (const phase of ['DB_APPLIED', 'SUMMIT_STAGED', 'CONSUMERS_STAGED']) record = update(record, 'advance', { phase, evidenceDigest: evidence(phase) });
  const receipt = databaseReceipt();
  receipt.operation = 'analysis';
  receipt.scope = { operationId: 'existing-operation', campaignId: 'existing-campaign', planDigest: `sha256:${evidence('plan')}` };
  receipt.execution = { ...receipt.execution, repository: 'ponta2git/momo-result', sha: candidates.result,
    workflow: '.github/workflows/analysis-maintenance.yml' };
  receipt.evidence.previousStage = evidence('CONSUMERS_STAGED');
  record = permit(record, receipt);
  assert.doesNotThrow(() => assertMaintenanceMutation(record, receipt, context(receipt), 'analysis', now));
  for (const field of ['operationId', 'campaignId', 'planDigest']) {
    const changed = structuredClone(receipt);
    changed.scope[field] = field === 'planDigest' ? `sha256:${evidence('different-plan')}` : 'another-target';
    assert.throws(() => assertMaintenanceMutation(record, changed, context(changed), 'analysis', now), code('EXACT_EXECUTION_NOT_PERMITTED'));
  }
  const unknown = structuredClone(receipt); unknown.scope.extra = 'fixture-private-canary';
  assert.throws(() => assertMaintenanceMutation(record, unknown, context(unknown), 'analysis', now), code('INVALID_ANALYSIS_SCOPE'));
});

test('cancelled preparation and restored old consumers reopen through recovery evidence without a fictitious deployment', () => {
  for (const original of [update(initialControl('fixture-operator', now), 'begin'), verified()]) {
    let record = update(original, 'recovery-ready', { recoveryEvidenceDigest: evidence('restored-connections') });
    assert.equal(record.cutover.stopEpoch, original.cutover.stopEpoch + 1);
    assert.deepEqual(record.cutover.permits, []);
    assert.throws(() => assertNormalMutation(record), code('NORMAL_MUTATION_HELD_FOR_MAINTENANCE'));
    for (const phase of ['RECOVERY_REOPENING', 'RECOVERY_RESUMED']) record = update(record, 'advance', { phase, evidenceDigest: evidence(phase) });
    assert.throws(() => update(record, 'invalidate', { reason: 'uncertain-stop' }), code('REOPENED_CUTOVER_REQUIRES_FORWARD_FIX'));
    record = update(record, 'close-recovery', { recoveredReleaseDigest: evidence('recovered') });
    assert.equal(record.completed.outcome, 'recovered');
    assert.equal(record.completed.evidenceDigest, evidence('recovered'));
    assert.doesNotThrow(() => assertNormalMutation(record));
    const next = update(record, 'begin');
    assert.ok(next.cutover.stopEpoch > original.cutover.stopEpoch);
  }
});

test('public time fields are canonical UTC and completion retains the publish evidence and epoch', () => {
  const privateTime = 'Sun, 18 Oct 2026 01:00:00 GMT (fixture-private-canary)';
  assert.throws(() => initialControl('fixture-operator', privateTime), code('INVALID_CONTROL_TIME'));
  let record = verified();
  assert.throws(() => update(record, 'permit', { permit: { operation: 'database', repository: 'ponta2git/momo-db',
    runId: '300', runAttempt: 1, receiptDigest: evidence('receipt'), deadline: privateTime } }), code('INVALID_PERMIT_EVIDENCE'));
  for (const phase of ['DB_APPLIED', 'SUMMIT_STAGED', 'CONSUMERS_STAGED', 'READY_TO_RESUME', 'REOPENING', 'RESUMED']) {
    record = update(record, 'advance', { phase, evidenceDigest: evidence(phase) });
  }
  record = update(record, 'close', { publishedReleaseDigest: evidence('published') });
  assert.equal(record.completed.evidenceDigest, evidence('published'));
  assert.equal(record.completed.outcome, 'published');
  const next = update(record, 'begin');
  assert.equal(next.cutover.stopEpoch, 2);
});

function fakeGithub() {
  let head, counter = 0, login = 'fixture-operator';
  const blobs = new Map(), trees = new Map(), commits = new Map();
  const identifier = () => (++counter).toString(16).padStart(40, '0');
  const request = async (path, { method = 'GET', body } = {}) => {
    if (path === 'user') return { login };
    path = path.replace('repos/ponta2git/momo-db/', '');
    if (path === 'git/blobs') { const sha = identifier(); blobs.set(sha, body); return { sha }; }
    if (path === 'git/trees') { const sha = identifier(); trees.set(sha, body.tree); return { sha }; }
    if (path === 'git/commits') { const sha = identifier(); commits.set(sha, body); return { sha }; }
    if (path.startsWith('git/commits/')) return { tree: { sha: commits.get(path.slice(12)).tree } };
    if (path.startsWith('contents/control.json?ref=')) {
      const sha = path.split('=')[1];
      const value = blobs.get(trees.get(commits.get(sha).tree)[0].sha);
      return { type: 'file', encoding: 'base64', content: value.content, size: Buffer.from(value.content, 'base64').length };
    }
    if (path === 'git/refs' && method === 'POST') {
      if (head) throw new Error('ref exists');
      head = body.sha; return { object: { sha: head } };
    }
    if (path === 'git/ref/heads/maintenance-control') {
      if (!head) throw new Error('ref missing');
      return { object: { sha: head, type: 'commit' } };
    }
    if (path === 'git/refs/heads/maintenance-control' && method === 'PATCH') {
      assert.equal(body.force, false);
      if (commits.get(body.sha).parents[0] !== head) throw new Error('not fast-forward');
      head = body.sha; return { object: { sha: head } };
    }
    throw new Error('unexpected fixture API');
  };
  return { request, setLogin(value) { login = value; } };
}

test('Git control storage survives callers, refuses reset, and concurrent operators cannot overwrite each other', async () => {
  const github = fakeGithub();
  const store = createStore(github.request);
  await store.initialize(initialControl('fixture-operator', now));
  await assert.rejects(store.initialize(initialControl('fixture-operator', now)), /ref exists/);
  const first = await store.read();
  const second = await createStore(github.request).read();
  const next = update(first.record, 'begin');
  const outcomes = await Promise.allSettled([store.compareAndSwap(first, next), createStore(github.request).compareAndSwap(second, next)]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  const persisted = await createStore(github.request).read();
  assert.equal(persisted.record.cutover.phase, 'PREPARING');
  assert.throws(() => assertNormalMutation(persisted.record), code('NORMAL_MUTATION_HELD_FOR_MAINTENANCE'));
  await assert.rejects(store.compareAndSwap(first, next), code('STALE_CONTROL_HEAD'));
  github.setLogin('another-operator');
  await assert.rejects(store.compareAndSwap(persisted, update(persisted.record, 'pin', { candidates })), code('CONTROL_OPERATOR_REQUIRED'));
});
