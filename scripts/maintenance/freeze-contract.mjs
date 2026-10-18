import { ControlError, digest, validateControl } from './control.mjs';

export const check = (condition, code) => { if (!condition) throw new ControlError(code); };
export const same = (left, right) => digest(left) === digest(right);
export const roles = ['api', 'worker', 'summit'];
export const modeKey = 'MOMO_MAINTENANCE_MODE';
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
export const externalWriterChecks = [
  'github-db-migrations', 'github-result-deploy', 'github-result-rollback', 'github-result-analysis',
  'github-result-publish', 'already-authorized-jobs', 'old-workflow-rejection-including-unprotected-publisher',
  'summit-manual-deploy', 'summit-cli-and-seed', 'manual-sql-and-provider-console',
  'ad-hoc-scripts-and-other-machines', 'external-credentials',
];
const writers = {
  api: { http_admission: 'admission', http_continuations_and_runtime: 'all' },
  worker: { scheduler_and_attempts: 'admission', runtime_and_notifications: 'all' },
  summit: { startup: 'admission', discord_interactions: 'admission', reconnect_recovery: 'admission',
    scheduler: 'admission', ask_sends: 'admission', notification_operations: 'admission', result_notifications: 'all' },
};
const consumer = { api: 'momo-result-api', worker: 'momo-processing-worker', summit: 'summit' };

export function validateDatabaseProof(value) {
  check(value?.formatVersion === 1 && hash(value.targetFingerprint) && hash(value.ledgerFingerprint) &&
    Object.keys(value).length === 3, 'INVALID_FREEZE_DATABASE_PROOF');
  return value;
}

export function assertStop(record, plan, phase = 'DRAINING') {
  validateControl(record);
  const current = record.cutover;
  check(current?.id === plan.cutoverId && current.stopEpoch === plan.stopEpoch && current.phase === phase &&
    same(current.candidates, plan.candidates) && current.evidence.deploymentFreeze === plan.deploymentFreezeDigest,
  'FREEZE_CONTROL_CHANGED');
}

export function validateExternalEvidence(evidence, record, deployment, now = Date.now()) {
  check(evidence?.formatVersion === 1 && evidence.operator === record.operator &&
    evidence.cutoverId === record.cutover?.id && evidence.stopEpoch === record.cutover.stopEpoch &&
    same(evidence.candidates, record.cutover.candidates) && evidence.deploymentFreezeDigest === digest(deployment),
  'EXTERNAL_WRITER_EVIDENCE_SCOPE_CHANGED');
  check(Number.isFinite(Date.parse(evidence.observedAt)) && Date.parse(evidence.observedAt) <= now &&
    Number.isFinite(Date.parse(evidence.validUntil)) && now < Date.parse(evidence.validUntil), 'EXTERNAL_WRITER_EVIDENCE_EXPIRED');
  check(Array.isArray(evidence.checks) && evidence.checks.length === externalWriterChecks.length &&
    externalWriterChecks.every(kind => evidence.checks.filter(item => item.kind === kind && hash(item.evidenceDigest)).length === 1),
  'EXTERNAL_WRITER_INVENTORY_INCOMPLETE');
  return evidence;
}

export function validateMachineTargets(targets) {
  check(Array.isArray(targets) && targets.length > 0 && targets.length <= 100 &&
    targets.every(target => roles.includes(target.role) && identifier(target.app) &&
    /^[a-f0-9]{10,32}$/.test(target.id) && /^.+@sha256:[a-f0-9]{64}$/.test(target.image) && hash(target.configDigest)) &&
    roles.every(role => targets.some(target => target.role === role)) &&
    new Set(targets.map(target => `${target.app}:${target.id}`)).size === targets.length &&
    new Set(targets.map(target => target.app)).size === roles.length &&
    roles.every(role => new Set(targets.filter(target => target.role === role).map(target => target.app)).size === 1),
  'EXACT_CONSUMER_MACHINE_INVENTORY_REQUIRED');
}

export function validateFreezeInput(input, record, now = Date.now()) {
  check(input?.formatVersion === 1, 'INVALID_FREEZE_INPUT');
  validateMachineTargets(input.targets);
  validateControl(record);
  check(record.cutover?.phase === 'DRAINING' && record.cutover.candidates, 'DRAINING_CONTROL_REQUIRED');
  validateDatabaseProof(input.database);
  check(Number.isFinite(Date.parse(input.deadline)) && Number.isSafeInteger(input.recoveryReserveMs) &&
    input.recoveryReserveMs > 0 && Date.parse(input.deadline) - input.recoveryReserveMs > now, 'FREEZE_TIME_BUDGET_EXHAUSTED');
  return input;
}

export function machineImage(machine) {
  const image = machine?.image_ref;
  check(typeof image?.registry === 'string' && typeof image.repository === 'string' &&
    /^sha256:[a-f0-9]{64}$/.test(image.digest), 'IMMUTABLE_MACHINE_IMAGE_REQUIRED');
  return `${image.registry}/${image.repository}@${image.digest}`;
}

// Keep lifecycle events as well as instance_id: a restart need not update config.
export function machineIdentity(machine) {
  check(machine?.state === 'started' && identifier(machine.instance_id) && machine.config &&
    Array.isArray(machine.events) && machine.events.length > 0, 'RUNNING_MACHINE_EVIDENCE_REQUIRED');
  return { id: machine.id, instance: machine.instance_id, config: machine.config, image: machineImage(machine),
    events: machine.events };
}

export function assertStagedBootConfiguration(config) {
  const overrides = [config, ...(config.processes ?? [])];
  check(Array.isArray(config.processes ?? []) && (!config.containers || config.containers.length === 0) &&
    overrides.every(value => !value.ignore_app_secrets && (!value.secrets || value.secrets.length === 0) &&
      (!value.env_from || value.env_from.every(item => item.env_var !== modeKey))) &&
    (config.processes ?? []).every(value => !Object.hasOwn(value.env ?? {}, modeKey)),
  'APP_SECRET_BOOT_CONTRACT_REQUIRED');
}

export function validateSecrets(secrets) {
  check(Array.isArray(secrets) && secrets.length < 1000 && secrets.every(item =>
    typeof item.name === 'string' && /^[A-Z][A-Z0-9_]*$/.test(item.name) && typeof item.digest === 'string' && item.digest.length > 0 &&
    ['Deployed', 'Staged', 'Partial', 'Unknown'].includes(item.status)) &&
    new Set(secrets.map(item => item.name)).size === secrets.length, 'SECRET_METADATA_UNAVAILABLE');
  return secrets.toSorted((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

export function assertSecretStage(before, after) {
  before = validateSecrets(before); after = validateSecrets(after);
  check(before.every(item => item.status === 'Deployed'), 'UNRELATED_STAGED_SECRETS_PRESENT');
  check(same(before.filter(item => item.name !== modeKey), after.filter(item => item.name !== modeKey)), 'UNRELATED_SECRETS_CHANGED');
  const mode = after.find(item => item.name === modeKey);
  check(mode?.status === 'Staged' && mode.digest !== before.find(item => item.name === modeKey)?.digest,
    'FROZEN_SECRET_STAGE_UNCONFIRMED');
}

export function assertSecretsUnchanged(expected, actual) {
  expected = validateSecrets(expected); actual = validateSecrets(actual);
  check(same(expected.map(({ name, digest: value }) => ({ name, digest: value })),
    actual.map(({ name, digest: value }) => ({ name, digest: value }))), 'SECRET_VERSION_CHANGED');
  check(actual.filter(item => item.name !== modeKey).every(item => item.status === 'Deployed') &&
    actual.filter(item => item.name === modeKey).every(item => item.status !== 'Unknown'), 'SECRET_DEPLOYMENT_UNCERTAIN');
}

export function assertDrain(role, value, request = null, mode = 'normal') {
  check(value?.consumer === consumer[role] && value.scope === 'process' && Array.isArray(value.writers) &&
    value.writers.length === Object.keys(writers[role] ?? {}).length &&
    Object.entries(writers[role] ?? {}).every(([name, stage]) => value.writers.filter(item => item.name === name && item.stage === stage).length === 1),
  'INCOMPLETE_PROCESS_WRITER_RECEIPT');
  check(value.writers.every(item => ['active', 'draining', 'drained'].includes(item.status) && !item.failure) &&
    ['running', 'draining', 'drained'].includes(value.phase), 'PROCESS_DRAIN_FAILED');
  if (role === 'worker') check(value.mode === mode && Number.isSafeInteger(value.processId) && value.processId > 0, 'LIVE_WORKER_MODE_CHANGED');
  if (!request) {
    check(value.cutoverId === null && value.stopEpoch === null && value.stage === null && value.phase === 'running' &&
      value.writers.every(item => item.status === 'active'), 'NORMAL_PROCESS_REQUIRED');
    return false;
  }
  check(value.cutoverId === request.cutoverId && value.stopEpoch === request.stopEpoch && value.stage === request.stage,
    'PROCESS_STOP_IDENTITY_CHANGED');
  const selected = value.writers.filter(item => request.stage === 'all' || item.stage === 'admission');
  const settled = selected.every(item => item.status === 'drained');
  check((value.phase === 'drained') === settled, 'INCONSISTENT_PROCESS_DRAIN_RECEIPT');
  if (settled && role !== 'summit') {
    const names = role === 'api' ? request.stage === 'all' ? ['requests', 'continuations'] : ['requests']
      : request.stage === 'all' ? ['operations', 'attempts', 'reconciliations'] : ['operations', 'attempts'];
    check(names.every(name => value.inFlight?.[name] === 0), 'PROCESS_WORK_STILL_ACTIVE');
  }
  return settled;
}

export function assertFrozenReadiness(role, value, expected) {
  validateDatabaseProof(value?.database);
  check(same(value.database, expected), 'CONSUMER_DATABASE_PROOF_CHANGED');
  if (role === 'api') check(value.event === 'runtime_maintenance_readiness' && value.status === 'ok' && value.schemaVersion === 1 &&
    ['frozen_readiness', 'normal_routes_closed', 'database_contract', 'runtime_processes'].every(name => value.checks?.includes(name)),
  'FROZEN_API_READINESS_REQUIRED');
  else if (role === 'worker') check(value.event === 'worker_maintenance_readiness' && value.status === 'ready' &&
    value.schemaVersion === 1 && value.mode === 'frozen', 'FROZEN_CONSUMER_READINESS_REQUIRED');
  else check(value.mode === 'frozen' && value.ready === true && value.service === 'summit' &&
    value.contract === 'summit-read-schema-v1', 'FROZEN_CONSUMER_READINESS_REQUIRED');
}
