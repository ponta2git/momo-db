import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFinalProof, certifyFinalRehearsal, finalAcceptanceKinds, frozenBinding, receiptInput } from '../scripts/maintenance/final-rehearsal.mjs';
import { initialControl, transition, digest } from '../scripts/maintenance/control.mjs';
import { digest as databaseDigest } from '../scripts/migration/files.mjs';
import { databaseSchemaDigest, classifyDatabase } from '../scripts/maintenance/apply-database.mjs';

const hash = value => digest({ fixture: value });
const now = Date.parse('2026-10-18T02:00:00.000Z');
function fixture() {
  const candidates = { db: 'a'.repeat(40), summit: 'b'.repeat(40), result: 'c'.repeat(40) };
  const id = { cutoverId: 'fixture', stopEpoch: 1 };
  let record = initialControl('operator');
  record = transition(record, record.stateVersion, 'begin', { cutoverId: id.cutoverId });
  record = transition(record, record.stateVersion, 'pin', { ...id, candidates });
  record = transition(record, record.stateVersion, 'advance', { ...id, phase: 'DRAINING', evidenceDigest: hash('deployment') });
  const plan = { ...id, candidates, deploymentFreezeDigest: hash('deployment'), deadline: new Date(now + 3600000).toISOString(), recoveryReserveMs: 600000 };
  const freezeProof = { ...id, candidates, planDigest: digest(plan), frozenAt: new Date(now - 120000).toISOString() };
  record = transition(record, record.stateVersion, 'advance', { ...id, phase: 'FROZEN', evidenceDigest: digest(freezeProof) });
  const expected = [{ hash: hash('old'), created_at: '1' }, { hash: hash('new'), created_at: '2' }];
  const server = { encoding: 'UTF8', collation: 'C', ctype: 'C', localeProvider: 'c', locale: null,
    icuRules: null, collationVersion: null, actualCollationVersion: null };
  const report = (ledger, changed) => {
    const rows = { algorithm: 'sha256-row-multiset-v2', tables: [{ schema: 'public', name: 'fixture', rows: '7', digest: hash(changed ? 'target-rows' : 'rows') }],
      sequences: [{ schema: 'public', name: 'counter', last: '7', called: true }] };
    rows.digest = databaseDigest(rows);
    return { connection: { ledger, ledgerDigest: databaseDigest(ledger), server, pending: expected.slice(ledger.length) },
      schema: { columns: [{ name: 'id', type: changed ? 'uuid' : 'text' }] }, rows };
  };
  const source = report(expected.slice(0, 1), false);
  const baseline = structuredClone(source); const recovered = structuredClone(source);
  const migrated = report(expected, true); const first = structuredClone(migrated);
  const finalFreeze = frozenBinding(plan, freezeProof, hash('source'));
  const archiveDigest = hash('archive');
  const manifest = { runId: 'fixture-run', source: { identity: finalFreeze.sourceIdentity }, finalFreeze,
    candidate: { sha: candidates.db, migrationDigest: databaseDigest(expected), lockDigest: hash('lock') },
    state: 'recovery-verified', checks: Object.fromEntries(['sourceSnapshot', 'restore', 'migratorFirstRun', 'migratorNoop',
      'migration', 'migrationSchema', 'savedRows', 'databaseRecovery'].map(name => [name, true])),
    snapshot: { mode: 'frozen-consistent-snapshot', freezeDigest: databaseDigest(finalFreeze), archiveDigest,
      capturedAt: new Date(now - 90000).toISOString(), auditDigest: databaseDigest(source) },
    baselineDigest: databaseDigest(baseline), firstMigrationDigest: databaseDigest(first), migratedDigest: databaseDigest(migrated),
    recoveredDigest: databaseDigest(recovered), durationsMs: { snapshot: 100, restore: 10, rehearse: 20, 'recover-rehearsal': 10 } };
  const sourceNow = { identity: finalFreeze.sourceIdentity, ledger: source.connection.ledger,
    schemaDigest: databaseSchemaDigest(source.connection, source.schema), dataDigest: source.rows.digest };
  const acceptance = { formatVersion: 1, operator: record.operator, runId: manifest.runId, candidates,
    snapshotDigest: archiveDigest, migratedDigest: manifest.migratedDigest, recoveredDigest: manifest.recoveredDigest, incomplete: [],
    reviewedAt: new Date(now).toISOString(), validUntil: new Date(now + 1800000).toISOString(), checks: finalAcceptanceKinds.map(kind => ({
      kind, outcome: 'passed', reportDigest: hash(kind), executionDigest: hash(`execution-${kind}`), durationMs: 10,
      completedAt: new Date(now - 1000).toISOString() })) };
  const input = { manifest, source, baseline, first, migrated, recovered, sourceNow, archiveDigest, expected, acceptance, plan, freezeProof, record, now };
  const calls = []; const proofs = [];
  const dependencies = { now: () => now, verifyFreeze: async () => { calls.push('freeze'); }, captureSource: async () => { calls.push('capture'); return sourceNow; },
    save: async proof => { calls.push('save'); proofs.push(proof); }, store: {
      read: async () => ({ record: structuredClone(record), digest: digest(record) }),
      compareAndSwap: async (previous, next) => { calls.push('cas'); assert.equal(previous.digest, digest(record)); record = next; },
    } };
  return { input, dependencies, calls, proofs, record: () => record, changeRecord: value => { record = value; } };
}

test('final proof binds the cold archive, full source including sequences, target and recovery to one stop generation', async () => {
  const f = fixture(); const proof = await certifyFinalRehearsal(f.input, f.dependencies);
  assert.deepEqual(f.calls, ['freeze', 'capture', 'freeze', 'save', 'freeze', 'cas']);
  assert.equal(f.record().cutover.phase, 'VERIFIED');
  assert.equal(f.record().cutover.evidence.finalRehearsal, digest(proof));
  const input = receiptInput(proof, f.record(), { operation: 'database', producer: { runId: '11', runAttempt: 1,
    artifacts: [{ id: '12', digest: hash('artifact') }], configDigest: hash('config'), secretVersion: 'version1' } });
  assert.equal(input.execution, undefined);
  const receipt = { ...input, execution: { repository: 'ponta2git/momo-db', workflow: '.github/workflows/ci.yml',
    ref: 'refs/heads/cutover/fixture', sha: proof.candidates.db, runId: '13', runAttempt: 1 } };
  assert.equal(classifyDatabase(receipt, f.input.sourceNow, f.input.expected), 'baseline');
  assert.equal(classifyDatabase(receipt, { identity: proof.evidence.sourceIdentity, ledger: f.input.migrated.connection.ledger,
    schemaDigest: proof.evidence.targetSchema, dataDigest: f.input.migrated.rows.digest }, f.input.expected), 'target');
});

test('online, imported, previous-generation, changed archive, incomplete or changed reports cannot become final evidence', () => {
  for (const mutate of [
    f => { f.manifest.snapshot.mode = 'online-consistent-snapshot'; },
    f => { f.manifest.snapshot.importedFrom = 'other'; },
    f => { f.manifest.finalFreeze.stopEpoch++; },
    f => { f.archiveDigest = hash('other'); },
    f => { f.manifest.checks.migratorNoop = false; },
    f => { f.manifest.candidate.sha = 'd'.repeat(40); },
    f => { f.source.rows.tables[0].digest = hash('changed'); },
    f => { f.recovered.rows.sequences[0].last = '8'; f.manifest.recoveredDigest = databaseDigest(f.recovered); },
    f => { f.sourceNow.dataDigest = hash('sequence-only-change'); },
    f => { f.sourceNow.identity = hash('different-endpoint'); },
    f => { f.now += 3600000; },
  ]) { const f = fixture().input; mutate(f); assert.throws(() => buildFinalProof(f)); }
});

test('consumer acceptance must cover this final copy and every required gate with actual reviewed evidence', () => {
  for (const mutate of [
    a => { a.incomplete = ['external-object-mirror']; }, a => { a.operator = 'other'; },
    a => { a.runId = 'earlier-run'; }, a => { a.snapshotDigest = hash('hot-copy'); },
    a => { a.checks.pop(); }, a => { a.checks[0] = a.checks[1]; },
    a => { a.checks[0].outcome = 'skipped'; }, a => { a.checks[0].executionDigest = true; },
    a => { a.checks[0].completedAt = new Date(now - 180000).toISOString(); },
    a => { a.validUntil = new Date(now - 1).toISOString(); },
  ]) { const f = fixture().input; mutate(f.acceptance); assert.throws(() => buildFinalProof(f)); }
});

test('a final source change or lost continuous freeze prevents VERIFIED and never runs a database mutation', async () => {
  const changed = fixture(); changed.input.sourceNow.dataDigest = hash('writer');
  await assert.rejects(certifyFinalRehearsal(changed.input, changed.dependencies), { code: 'FINAL_SOURCE_CHANGED' });
  assert.deepEqual(changed.proofs, []); assert.equal(changed.record().cutover.phase, 'FROZEN');
  const race = fixture(); let verifications = 0;
  race.dependencies.verifyFreeze = async () => {
    if (++verifications === 3) throw new Error('lost-freeze');
  };
  await assert.rejects(certifyFinalRehearsal(race.input, race.dependencies), /lost-freeze/);
  assert.equal(race.proofs.length, 1); assert.equal(race.record().cutover.phase, 'FROZEN');
  const saved = race.proofs[0];
  assert.throws(() => receiptInput(saved, race.record(), { operation: 'database' }), { code: 'FINAL_RECEIPT_CONTROL_CHANGED' });
});

test('CAS uncertainty preserves the private proof and does not automatically retry or advance twice', async () => {
  const f = fixture(); let attempts = 0;
  f.dependencies.store.compareAndSwap = async () => { attempts++; throw new Error('result-unknown'); };
  await assert.rejects(certifyFinalRehearsal(f.input, f.dependencies), /result-unknown/);
  assert.equal(f.proofs.length, 1); assert.equal(attempts, 1);
});
