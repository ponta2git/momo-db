import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyDatabase, executeDatabase } from '../scripts/maintenance/apply-database.mjs';
import { digest as databaseDigest } from '../scripts/migration/files.mjs';
import { digest } from '../scripts/maintenance/control.mjs';

const hash = name => digest({ fixture: name });
const code = expected => error => error.code === expected;
function fixture() {
  const expected = [{ hash: hash('old-migration'), created_at: '1' }, { hash: hash('new-migration'), created_at: '2' }];
  const before = { identity: hash('source'), ledger: expected.slice(0, 1), schemaDigest: hash('old-schema'), dataDigest: hash('old-data') };
  const after = { ...before, ledger: expected, schemaDigest: hash('target-schema'), dataDigest: hash('target-data') };
  const candidates = { db: 'a'.repeat(40), summit: 'b'.repeat(40), result: 'c'.repeat(40) };
  const receipt = { formatVersion: 1, operation: 'database', scope: null, cutoverId: 'fixture', stopEpoch: 1, candidates,
    evidence: { sourceIdentity: before.identity, baselineLedger: databaseDigest(before.ledger), targetLedger: databaseDigest(expected),
      pendingTail: databaseDigest(expected.slice(1)), savedData: before.dataDigest, baselineSchema: before.schemaDigest,
      targetData: after.dataDigest, targetSchema: after.schemaDigest, snapshot: hash('snapshot'), finalRehearsal: hash('rehearsal'), previousStage: hash('stage') },
    producer: { runId: '100', runAttempt: 1, artifacts: [{ id: '200', digest: hash('artifact') }], configDigest: hash('config'), secretVersion: 'opaque-version' },
    execution: { repository: 'ponta2git/momo-db', workflow: '.github/workflows/ci.yml', ref: 'refs/heads/cutover/fixture',
      sha: candidates.db, runId: '300', runAttempt: 1 } };
  const calls = [];
  const captures = [before, after];
  const dependencies = { receipt, expected,
    guard: async () => { calls.push('guard'); return { head: 'd'.repeat(40), stateVersion: 5 }; },
    preflight: async () => { calls.push('preflight'); }, capture: async () => { calls.push('capture'); return captures.shift(); },
    migrate: async () => { calls.push('migrate'); }, verify: async () => { calls.push('verify'); } };
  return { receipt, expected, before, after, captures, calls, dependencies };
}

test('database application rechecks the barrier around the sole normal migrator and verifies all target evidence', async () => {
  const value = fixture();
  const proof = await executeDatabase(value.dependencies);
  assert.equal(proof.mode, 'applied-and-verified');
  assert.deepEqual(value.calls, ['guard', 'preflight', 'capture', 'guard', 'migrate', 'verify', 'capture', 'guard']);
  assert.equal(proof.targetData, value.receipt.evidence.targetData);
  assert.equal(proof.targetLedger, value.receipt.evidence.targetLedger);
});

test('a committed migration whose runner result was lost is verified without another SQL mutation', async () => {
  const value = fixture(); value.captures[0] = value.after;
  const proof = await executeDatabase(value.dependencies);
  assert.equal(proof.mode, 'verified-existing-target');
  assert.equal(value.calls.includes('migrate'), false);
  assert.equal(value.calls.filter(call => call === 'capture').length, 2);
});

test('a prefix alone, changed rows/schema/sequence digest, wrong source or different tail cannot authorize SQL', async () => {
  for (const [mutate, expectedError] of [
    [value => { value.before.ledger = []; }, 'EXACT_BASELINE_LEDGER_REQUIRED'],
    [value => { value.before.ledger[0] = { hash: hash('unknown'), created_at: '1' }; }, 'UNKNOWN_DATABASE_LEDGER'],
    [value => { value.before.dataDigest = hash('writer-ran'); }, 'BASELINE_DATABASE_PROOF_DIFFERS'],
    [value => { value.before.schemaDigest = hash('changed-index'); }, 'BASELINE_DATABASE_PROOF_DIFFERS'],
    [value => { value.before.identity = hash('other-database'); }, 'DATABASE_IDENTITY_CHANGED'],
    [value => { value.receipt.evidence.pendingTail = hash('different-tail'); }, 'PENDING_TAIL_CHANGED'],
    [value => { value.receipt.evidence.targetLedger = hash('different-candidate'); }, 'TARGET_MIGRATION_ARTIFACT_CHANGED'],
  ]) {
    const value = fixture(); mutate(value);
    await assert.rejects(executeDatabase(value.dependencies), code(expectedError));
    assert.equal(value.calls.includes('migrate'), false);
  }
});

test('target ledger with unverified state fails closed and post-commit proof failures never retry the migrator', async () => {
  const value = fixture(); value.after.dataDigest = hash('unapproved-target-data');
  assert.throws(() => classifyDatabase(value.receipt, value.after, value.expected), code('TARGET_DATABASE_PROOF_DIFFERS'));
  await assert.rejects(executeDatabase(value.dependencies), code('TARGET_DATABASE_PROOF_DIFFERS'));
  assert.equal(value.calls.filter(call => call === 'migrate').length, 1);
});

test('an invalidated freeze after the baseline read stops immediately before migration', async () => {
  const value = fixture(); let calls = 0;
  value.dependencies.guard = async () => { if (++calls === 2) throw new Error('fixture-writer-reopened'); };
  await assert.rejects(executeDatabase(value.dependencies), /fixture-writer-reopened/);
  assert.equal(value.calls.includes('migrate'), false);
});
