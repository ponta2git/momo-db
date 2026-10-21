import { resolve } from 'node:path';
import { digest, fileDigest, readJson, requireCondition as check } from './files.mjs';
import { compareRestore, compareMigration } from './run.mjs';
import { compareCanonicalIdentityTransition } from './canonical-identities.mjs';
import { configurationDigest, compareFinalSource, validateCutoverEvidence, verifyStoppedMachines } from './cutover-guard.mjs';

const profileName = 'canonical-identities-retired-slots-v1';
const requiredChecks = ['sourceSnapshot', 'restore', 'freshReference', 'migratorFirstRun',
  'migratorNoop', 'migration', 'migrationSchema', 'savedRows', 'canonicalIdentityProjection',
  'workerSlotRetirement', 'databaseRecovery'];

// Read authenticated reports and repeat the comparisons. A manifest boolean or
// manually assembled success summary is never sufficient to authorize SQL.
export async function readFullRehearsal(directory, key, candidate, source) {
  const manifest = await readJson(resolve(directory, 'manifest.json.enc'), key);
  check(manifest.candidate?.sha === candidate && manifest.profile === profileName &&
    manifest.state === 'recovery-verified' && requiredChecks.every(name => manifest.checks?.[name] === true) &&
    !manifest.incomplete?.includes('interrupted-migrator-execution-requires-fresh-run'),
  'COMPLETE_FIXED_DB_REHEARSAL_REQUIRED');
  check(await fileDigest(resolve(directory, 'source.dump.enc')) === manifest.snapshot?.archiveDigest,
    'FINAL_ARCHIVE_DIGEST_DIFFERS');
  const read = async (name, expected) => {
    const value = await readJson(resolve(directory, `${name}.json.enc`), key);
    check(typeof expected === 'string' && digest(value) === expected, 'FINAL_REPORT_DIGEST_DIFFERS');
    return value;
  };
  const baseline = await read('baseline', manifest.baselineDigest);
  const original = await read('source', manifest.snapshot.auditDigest);
  const profile = await read('profile', manifest.profileDigest);
  const sourceTransition = await read('canonical-source', manifest.sourceTransitionDigest);
  const first = await read('migrated-first', manifest.firstMigrationDigest);
  const migrated = await read('migrated', manifest.migratedDigest);
  const recovered = await read('recovered', manifest.recoveredDigest);
  compareRestore(source, original);
  // Unlike the ordinary online snapshot, this handoff must certify sequence
  // state against the stopped source, not just two restores of one archive.
  compareRestore(source, baseline, { sequences: true });
  compareRestore(baseline, recovered, { sequences: true });
  compareCanonicalIdentityTransition({ before: baseline, after: first, sourceTransition,
    transition: first.transition, profile });
  compareMigration(first, migrated);
  return { manifest, verification: { baseline, profile, sourceTransition },
    report: { runId: manifest.runId, candidate, archiveDigest: manifest.snapshot.archiveDigest,
      baselineDigest: manifest.baselineDigest, profileDigest: manifest.profileDigest,
      sourceTransitionDigest: manifest.sourceTransitionDigest,
      firstMigrationDigest: manifest.firstMigrationDigest, migratedDigest: manifest.migratedDigest,
      recoveredDigest: manifest.recoveredDigest, checks: manifest.checks, durationsMs: manifest.durationsMs } };
}

export function pinStoppedMachines(inventory, actual) {
  check(inventory.length === 3 && actual.length === 3, 'THREE_WRITERS_REQUIRED');
  const pinned = inventory.map((item, index) => ({ consumer: item.consumer, app: item.app,
    id: item.id, instanceId: actual[index].instance_id,
    configDigest: configurationDigest(actual[index].config), eventsDigest: actual[index].eventsDigest }));
  verifyStoppedMachines(pinned, actual);
  return pinned;
}

// The same ordering runs against the real stopped source and an owned frozen
// copy. Only the real Fly/approved-Neon adapter can request production scope.
export async function produceFinalEvidence({ candidate, refs, inventory, observeMachines, inspectSource,
  runFullRehearsal, scope, producer, budgetMs = 120 * 60 * 1000, recoveryReserveMs, signal,
  now = () => Date.now(), record = async () => {} }) {
  check(['production', 'rehearsal'].includes(scope) && Number.isInteger(budgetMs) && budgetMs > 0 &&
    budgetMs <= 120 * 60 * 1000 && Number.isInteger(recoveryReserveMs) && recoveryReserveMs > 0 &&
    recoveryReserveMs < budgetMs, 'STOP_AND_RECOVERY_BUDGET_REQUIRED');
  const frozenAt = now();
  const deadline = frozenAt + budgetMs - recoveryReserveMs;
  const continuing = () => {
    check(!signal?.aborted, 'FINAL_EVIDENCE_INTERRUPTED');
    check(now() < deadline, 'FINAL_EVIDENCE_RECOVERY_RESERVE_REACHED');
  };
  continuing();
  const machines = pinStoppedMachines(inventory, await observeMachines());
  const source = await inspectSource();
  verifyStoppedMachines(machines, await observeMachines());
  continuing();
  await record({ state: 'frozen-source-read', frozenAt: new Date(frozenAt).toISOString(), machines,
    sourceDigest: digest(source) });
  const checkpoint = async () => {
    continuing();
    verifyStoppedMachines(machines, await observeMachines());
    compareFinalSource(source, await inspectSource());
    verifyStoppedMachines(machines, await observeMachines());
    continuing();
  };
  const result = await runFullRehearsal({ source, checkpoint });
  await checkpoint();
  const validatedAt = now();
  const evidence = { formatVersion: 2,
    kind: scope === 'production' ? 'final-cutover-evidence' : 'cutover-rehearsal-evidence',
    candidate, refs, profile: profileName, producer,
    frozenAt: new Date(frozenAt).toISOString(), validatedAt: new Date(validatedAt).toISOString(),
    expiresAt: new Date(Math.min(deadline, validatedAt + 15 * 60 * 1000)).toISOString(),
    backup: { capturedAt: result.manifest.snapshot.capturedAt, restoredAndRead: true,
      archiveDigest: result.manifest.snapshot.archiveDigest,
      restoredReportDigest: result.manifest.baselineDigest },
    finalData: { passed: true, path: 'full-rehearsal', reportDigest: digest(result.report) },
    source, machines, report: result.report, verification: result.verification,
    verificationDigest: digest(result.verification), budgetMs, recoveryReserveMs,
    durationMs: validatedAt - frozenAt };
  // Validate the shared structure, but do not turn a rehearsal into a production
  // artifact. SQL validates the original kind and rejects every rehearsal.
  validateCutoverEvidence({ ...evidence, kind: 'final-cutover-evidence' }, { candidate, now: validatedAt });
  await record({ state: 'final-evidence-complete', evidenceDigest: digest(evidence), scope });
  return evidence;
}
