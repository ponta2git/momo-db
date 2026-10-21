import { digest, requireCondition as check } from './files.mjs';
import { compareFingerprints, databaseLocale } from './database.mjs';

const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) :
  value && typeof value === 'object' ?
    Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const configurationDigest = value => digest(canonical(value));

/** P3 produces this encrypted handoff; missing or provisional evidence never authorizes SQL. */
export function validateCutoverEvidence(evidence, { candidate, now = Date.now() }) {
  check(evidence?.formatVersion === 2 && evidence.kind === 'final-cutover-evidence',
    'FINAL_CUTOVER_EVIDENCE_REQUIRED');
  check(sha(candidate) && evidence.candidate === candidate &&
    evidence.profile === 'canonical-identities-retired-slots-v1', 'CUTOVER_CANDIDATE_DIFFERS');
  check(['db', 'summit', 'result'].every(name => sha(evidence.refs?.[name])) &&
    evidence.refs.db === candidate, 'THREE_FIXED_REFS_REQUIRED');
  check(Number.isFinite(Date.parse(evidence.expiresAt)) &&
    Date.parse(evidence.expiresAt) > now &&
    Date.parse(evidence.frozenAt) <= Date.parse(evidence.backup?.capturedAt) &&
    Date.parse(evidence.backup?.capturedAt) <= Date.parse(evidence.validatedAt) &&
    Date.parse(evidence.validatedAt) <= now &&
    Date.parse(evidence.expiresAt) <= Date.parse(evidence.frozenAt) + 120 * 60 * 1000,
  'FINAL_EVIDENCE_TIME_INVALID');
  check(evidence.backup?.restoredAndRead === true && hash(evidence.backup.archiveDigest) &&
    hash(evidence.backup.restoredReportDigest) &&
    evidence.finalData?.passed === true &&
    ['unchanged', 'affected-inputs-verified', 'full-rehearsal'].includes(evidence.finalData.path) &&
    hash(evidence.finalData.reportDigest), 'RESTORED_FINAL_BACKUP_AND_DATA_GATE_REQUIRED');
  check(evidence.report && evidence.verification &&
    digest(evidence.report) === evidence.finalData.reportDigest &&
    digest(evidence.verification) === evidence.verificationDigest,
  'FINAL_COMPARISON_REPORTS_REQUIRED');
  check(evidence.source?.rows?.algorithm === 'sha256-row-multiset-v2' &&
    Array.isArray(evidence.source.rows.tables) && Array.isArray(evidence.source.rows.sequences) &&
    Array.isArray(evidence.source.schema?.tables) && evidence.source.connection?.ledger?.length === 73 &&
    typeof evidence.source.role === 'string' && hash(evidence.source.rolesDigest) &&
    hash(evidence.source.locationIdentity), 'FINAL_SOURCE_BASELINE_REQUIRED');
  check(Array.isArray(evidence.machines) && evidence.machines.length === 3 &&
    new Set(evidence.machines.map(item => item.consumer)).size === 3 &&
    new Set(evidence.machines.map(item => `${item.app}/${item.id}`)).size === 3 &&
    evidence.machines.every(item => ['api', 'worker', 'summit'].includes(item.consumer) &&
      /^[a-z0-9-]+$/.test(item.app) && /^[a-z0-9]+$/.test(item.id) &&
      typeof item.instanceId === 'string' && item.instanceId.length > 0 &&
      hash(item.configDigest) && hash(item.eventsDigest)), 'THREE_STOPPED_MACHINES_REQUIRED');
  return evidence;
}

export function verifyStoppedMachines(expected, actual) {
  check(actual.length === expected.length, 'WRITER_MACHINE_SET_DIFFERS');
  for (let index = 0; index < expected.length; index++) {
    const wanted = expected[index];
    const machine = actual[index];
    check(machine?.id === wanted.id && machine.instance_id === wanted.instanceId &&
      machine.state === 'stopped' && machine.config?.restart?.policy === 'no' &&
      !machine.config?.schedule && !machine.config?.standbys?.length &&
      (machine.config?.services ?? []).every(service => service.autostart === false) &&
      configurationDigest(machine.config) === wanted.configDigest &&
      machine.eventsDigest === wanted.eventsDigest, 'WRITER_NOT_PINNED_AND_STOPPED');
  }
}

export function compareFinalSource(expected, actual) {
  check(expected.locationIdentity === actual.locationIdentity && expected.role === actual.role &&
    expected.rolesDigest === actual.rolesDigest, 'FINAL_SOURCE_IDENTITY_OR_ROLE_CHANGED');
  check(configurationDigest(expected.schema) === configurationDigest(actual.schema),
    'FINAL_SOURCE_SCHEMA_CHANGED');
  check(digest(expected.connection.ledger) === digest(actual.connection.ledger),
    'FINAL_SOURCE_LEDGER_CHANGED');
  check(digest(databaseLocale(expected.connection.server)) === digest(databaseLocale(actual.connection.server)),
    'FINAL_SOURCE_LOCALE_CHANGED');
  compareFingerprints(expected.rows, actual.rows, { sequences: true });
}

/** Injectable ordering makes failure paths testable without production credentials. */
export async function guardedApply({ evidence, candidate, observeMachines, inspectSource, migrate, record }) {
  validateCutoverEvidence(evidence, { candidate });
  verifyStoppedMachines(evidence.machines, await observeMachines());
  const source = await inspectSource();
  compareFinalSource(evidence.source, source);
  // Do not accept a Machine which restarted while the full source was being read.
  verifyStoppedMachines(evidence.machines, await observeMachines());
  validateCutoverEvidence(evidence, { candidate });
  await record({ state: 'sql-starting', candidate });
  try {
    await migrate();
    await record({ state: 'sql-returned-success-needs-postcomparison', candidate });
  } catch {
    await record({ state: 'sql-result-unknown-read-only-classification-required', candidate });
    check(false, 'SQL_RESULT_UNKNOWN_DO_NOT_RETRY');
  }
}
