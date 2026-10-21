import { resolve } from 'node:path';
import { connect } from './database.mjs';
import { readJson, digest, writeJson, requireCondition as check, RehearsalError } from './files.mjs';
import { assertOwned, localUrl, withLocalConnection } from './local.mjs';
import { inspectFinalSource } from './cutover-apply.mjs';
import { classifyCutoverState } from './cutover-classify.mjs';
import { guardedApply, validateCutoverEvidence } from './cutover-guard.mjs';
import { command } from './process.mjs';

// Only the rehearsal adapter calls this on owned disposable databases. All
// injected faults and identity mapping are labelled; no production proof is
// emitted and the guard's migrate callback cannot execute SQL.
export async function exerciseRehearsalChecks({ seed, directory, key, evidence, repository,
  observeMachines, inspectSource }) {
  check(evidence.kind === 'cutover-rehearsal-evidence', 'REHEARSAL_ONLY');
  await assertOwned(seed);
  const results = {};
  const refused = async (name, operation) => {
    let rejected = false;
    try { await operation(); }
    catch (error) { if (!(error instanceof RehearsalError)) throw error; rejected = true; results[name] = error.code; }
    check(rejected, 'REHEARSAL_FAULT_WAS_NOT_REFUSED');
  };
  await refused('simulation-cannot-authorize-sql', async () => validateCutoverEvidence(evidence, { candidate: evidence.candidate }));
  const guardInput = { ...evidence, kind: 'final-cutover-evidence' };
  const guarded = proof => guardedApply({ evidence: proof, candidate: evidence.candidate, observeMachines, inspectSource,
    migrate: async () => { throw new Error('Fault fixture reached SQL callback'); }, record: async () => {} });
  await refused('missing-evidence', () => guarded({}));
  await refused('candidate-mismatch', () => guarded({ ...guardInput, candidate: '0'.repeat(40) }));
  await refused('expired-evidence', () => guarded({ ...guardInput, expiresAt: '2000-01-01T00:00:00Z' }));

  const baseline = await inspectSource();
  check(classifyCutoverState(evidence, baseline).state === 'baseline-unchanged', 'BASELINE_CLASSIFICATION_FAILED');
  results.baseline = 'baseline-unchanged';
  const final = await readJson(resolve(directory, 'manifest.json.enc'), key);
  await withLocalConnection(final, async () => {
    const url = localUrl(final, 'momo_rehearsal_migration');
    const sql = connect(url);
    let actual;
    try { actual = await inspectFinalSource(sql, url, repository, { allowAnyLedger: true, profile: evidence.verification.profile }); }
    finally { await sql.end(); }
    // A rehearsal's migration target is a distinct owned copy. This explicit
    // topology mapping does not change the stored final evidence/source.
    const mapped = { ...evidence, source: { ...evidence.source, locationIdentity: actual.locationIdentity } };
    check(classifyCutoverState(mapped, actual).state === 'target-preserved', 'TARGET_POSTCOMPARISON_FAILED');
    results.target = 'target-preserved';
    const partial = structuredClone(actual); partial.connection.ledger.pop();
    check(classifyCutoverState(mapped, partial).state === 'partial-or-unknown', 'PARTIAL_CLASSIFICATION_FAILED');
    results.partialObservationFixture = 'partial-or-unknown';
  });

  // Commit a one-row mutation on the frozen source copy, prove the real full
  // read rejects it, then restore exactly that value before the sequence case.
  const url = localUrl(seed, 'momo_rehearsal_baseline');
  const change = connect(url, { readOnly: false });
  let row;
  try {
    [row] = await change`SELECT id, display_name FROM public.members ORDER BY id LIMIT 1`;
    check(row, 'REAL_COPY_MEMBER_REQUIRED_FOR_FAULT_CASE');
    await change`UPDATE public.members SET display_name = ${row.display_name === 'cutover-fault' ? 'cutover-fault-2' : 'cutover-fault'} WHERE id = ${row.id}`;
  } finally { await change.end(); }
  try { await refused('changed-saved-row', () => guarded(guardInput)); }
  finally {
    const restore = connect(url, { readOnly: false });
    try { await restore`UPDATE public.members SET display_name = ${row.display_name} WHERE id = ${row.id}`; }
    finally { await restore.end(); }
  }
  const sequence = evidence.source.rows.sequences.find(item => item.schema === 'drizzle' && item.name === '__drizzle_migrations_id_seq');
  check(sequence, 'LEDGER_SEQUENCE_REQUIRED_FOR_FAULT_CASE');
  const mutateSequence = connect(url, { readOnly: false });
  try { await mutateSequence`SELECT setval('drizzle.__drizzle_migrations_id_seq'::regclass,
    ${String(BigInt(sequence.last_value) + 1n)}::bigint, true)`; }
  finally { await mutateSequence.end(); }
  try { await refused('changed-sequence', () => guarded(guardInput)); }
  finally {
    const restore = connect(url, { readOnly: false });
    try { await restore`SELECT setval('drizzle.__drizzle_migrations_id_seq'::regclass,
      ${sequence.last_value}::bigint, ${sequence.is_called})`; }
    finally { await restore.end(); }
  }
  check(classifyCutoverState(evidence, await inspectSource()).state === 'baseline-unchanged', 'FAULT_FIXTURE_NOT_RESTORED');
  await observeMachines(); // The adapter checks the simulation's ownership labels.
  await command('docker', ['start', evidence.machines[0].id]);
  await command('docker', ['stop', '--time', '1', evidence.machines[0].id]);
  await refused('writer-restarted-and-stopped-again', () => guarded(guardInput));
  const report = { kind: 'owned-copy-refusal-and-postcomparison', candidate: evidence.candidate,
    evidenceDigest: digest(evidence), archiveDigest: evidence.backup.archiveDigest,
    actualCopyFaults: ['changed-saved-row', 'changed-sequence', 'writer-restarted-and-stopped-again'],
    results, passed: true };
  await writeJson(resolve(directory, 'rehearsal-checks.json.enc'), report, key);
  return report;
}
