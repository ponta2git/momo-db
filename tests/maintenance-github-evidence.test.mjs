import assert from 'node:assert/strict';
import test from 'node:test';
import { digest, initialControl, transition } from '../scripts/maintenance/control.mjs';
import { approvalPolicy, verifyEnvironment, verifyProducer } from '../scripts/maintenance/github-evidence.mjs';
import { guardMaintenanceExecution } from '../scripts/maintenance/run.mjs';

const code = expected => error => error.code === expected;
const evidence = name => digest({ fixture: name });
const environment = () => ({
  name: 'production-db', can_admins_bypass: false,
  deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
  protection_rules: [{ type: 'required_reviewers', prevent_self_review: false,
    reviewers: [{ type: 'User', reviewer: { id: 123 } }] }],
});
const expectedEnvironment = { repository: 'ponta2git/momo-db', name: 'production-db', approval: true };
const policies = () => ({ total_count: 1, branch_policies: [{ name: 'cutover/fixture-cutover', type: 'branch' }] });

test('environment gate rejects original master reruns, extra tags, bypass and changed existing approvals', () => {
  const previous = approvalPolicy(environment());
  assert.doesNotThrow(() => verifyEnvironment(environment(), policies(), expectedEnvironment, 'fixture-cutover', previous));
  for (const change of [
    value => { value.branch_policies[0].name = 'master'; },
    value => { value.branch_policies[0].name = 'cutover/*'; },
    value => { value.branch_policies[0].type = 'tag'; },
    value => { value.total_count = 2; },
  ]) {
    const changed = policies(); change(changed);
    assert.throws(() => verifyEnvironment(environment(), changed, expectedEnvironment, 'fixture-cutover', previous), code('OLD_DEPLOYMENT_REFS_NOT_REJECTED'));
  }
  const bypass = environment(); bypass.can_admins_bypass = true;
  assert.throws(() => verifyEnvironment(bypass, policies(), expectedEnvironment, 'fixture-cutover', previous), code('ENVIRONMENT_ADMIN_BYPASS_NOT_DISABLED'));
  const changed = environment(); changed.protection_rules[0].reviewers[0].reviewer.id++;
  assert.throws(() => verifyEnvironment(changed, policies(), expectedEnvironment, 'fixture-cutover', previous), code('EXISTING_APPROVAL_POLICY_CHANGED'));
  const removed = environment(); removed.protection_rules = [];
  assert.throws(() => verifyEnvironment(removed, policies(), expectedEnvironment, 'fixture-cutover', previous), code('EXISTING_APPROVAL_REQUIRED'));
});

function fixture() {
  const candidates = { db: 'a'.repeat(40), summit: 'b'.repeat(40), result: 'c'.repeat(40) };
  const receipt = { formatVersion: 1, operation: 'database', scope: null, cutoverId: 'fixture-cutover', stopEpoch: 1, candidates,
    evidence: Object.fromEntries(['sourceIdentity', 'baselineLedger', 'targetLedger', 'pendingTail', 'savedData', 'baselineSchema',
      'targetData', 'targetSchema', 'snapshot', 'finalRehearsal', 'previousStage'].map(key => [key, evidence(key)])),
    producer: { runId: '100', runAttempt: 2, artifacts: [{ id: '200', digest: evidence('artifact') }],
      configDigest: evidence('config'), secretVersion: 'opaque-version' },
    execution: { repository: 'ponta2git/momo-db', workflow: '.github/workflows/ci.yml', ref: 'refs/heads/cutover/fixture-cutover',
      sha: candidates.db, runId: '300', runAttempt: 1 } };
  const run = { id: 100, run_attempt: 2, head_sha: candidates.db, head_branch: 'master', event: 'push',
    path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success' };
  const artifact = { id: 200, name: 'db-candidate-100-2', expired: false, digest: `sha256:${evidence('artifact')}`,
    workflow_run: { id: 100, head_sha: candidates.db, head_branch: 'master' } };
  const request = async path => {
    if (path === 'repos/ponta2git/momo-db/actions/runs/100/attempts/2') return run;
    if (path === 'repos/ponta2git/momo-db/actions/artifacts/200') return artifact;
    throw new Error('Unexpected fixture API');
  };
  return { receipt, run, artifact, request };
}

test('producer checks immutable artifact identity, original run attempt and successful master quality independently of deployment', async () => {
  const valid = fixture();
  assert.equal((await verifyProducer(valid.receipt, valid.request)).runId, '100');
  assert.equal(valid.receipt.execution.runId, '300');
  for (const change of [
    value => { value.run.run_attempt = 3; },
    value => { value.run.head_sha = 'd'.repeat(40); },
    value => { value.run.event = 'pull_request'; },
    value => { value.run.head_branch = 'develop'; },
    value => { value.run.conclusion = 'failure'; },
    value => { value.run.path = '.github/workflows/unrelated.yml'; },
  ]) {
    const value = fixture(); change(value);
    await assert.rejects(verifyProducer(value.receipt, value.request), code('SUCCESSFUL_FIXED_PRODUCER_REQUIRED'));
  }
  for (const change of [
    value => { value.artifact.expired = true; },
    value => { value.artifact.digest = `sha256:${evidence('replacement')}`; },
    value => { value.artifact.workflow_run.id = 101; },
    value => { value.artifact.workflow_run.head_sha = 'd'.repeat(40); },
    value => { value.artifact.name = 'db-candidate-100-1'; },
  ]) {
    const value = fixture(); change(value);
    await assert.rejects(verifyProducer(value.receipt, value.request), code('PRODUCER_ARTIFACT_CHANGED_OR_EXPIRED'));
  }
});

test('invalidation or permit replacement during artifact inspection is seen by the final stop-state read', async () => {
  for (const action of ['invalidate', 'permit']) {
    const value = fixture();
    value.receipt.evidence.previousStage = value.receipt.evidence.finalRehearsal;
    let record = initialControl('fixture-operator');
    const apply = (operation, payload) => {
      record = transition(record, record.stateVersion, operation,
        { cutoverId: value.receipt.cutoverId, stopEpoch: record.epoch, ...payload });
    };
    apply('begin', {});
    apply('pin', { candidates: value.receipt.candidates });
    for (const phase of ['DRAINING', 'FROZEN', 'VERIFIED']) {
      apply('advance', { phase, evidenceDigest: value.receipt.evidence.finalRehearsal });
    }
    const permit = { operation: 'database', repository: value.receipt.execution.repository,
      runId: '300', runAttempt: 1, receiptDigest: digest(value.receipt), deadline: new Date(Date.now() + 60000).toISOString() };
    apply('permit', { permit });
    const calls = [];
    const request = async path => {
      calls.push(path.includes('/artifacts/') ? 'artifact' : 'producer');
      const result = await value.request(path);
      if (path.includes('/artifacts/')) {
        if (action === 'invalidate') apply('invalidate', { reason: 'writer-reopened' });
        else apply('permit', { permit: { ...permit, receiptDigest: evidence('replacement') } });
      }
      return result;
    };
    const store = { read: async () => { calls.push('control'); return { head: 'd'.repeat(40), record }; } };
    await assert.rejects(guardMaintenanceExecution(store, value.receipt,
      { eventName: 'workflow_dispatch', execution: value.receipt.execution }, 'database', request),
    code(action === 'invalidate' ? 'STOP_IDENTITY_MISMATCH' : 'EXACT_EXECUTION_NOT_PERMITTED'));
    assert.deepEqual(calls, ['producer', 'artifact', 'control']);
  }
});
