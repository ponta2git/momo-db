import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ControlError, digest, validateControl, preparationRepairOperation } from './control.mjs';
import { assertDrain, assertStagedBootConfiguration, validateDatabaseProof, validateSecrets, modeKey } from './freeze-contract.mjs';
import { githubApi } from './github-store.mjs';
import { approvalPolicy, deploymentEnvironments, verifyEnvironment } from './github-evidence.mjs';

const check = (condition, code) => { if (!condition) throw new ControlError(code); };
const same = (left, right) => digest(left) === digest(right);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const imageId = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const runId = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 1;
const time = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const exact = (value, keys, code) => check(value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), code);
export const preparationRepairRepository = 'ponta2git/momo-result';
export const preparationRepairWorkflow = '.github/workflows/preparation-runtime-repair.yml';
export const preparationRepairSourceSha256 = '133dbcf1b0fb522b0c24b319c38879b092aa390a0a4a9ff0cd65f72abe00b4a1';
const sourceBytes = readFileSync(new URL('./preparation-runtime-repair-source.json', import.meta.url));
check(createHash('sha256').update(sourceBytes).digest('hex') === preparationRepairSourceSha256, 'PREPARATION_REPAIR_SOURCE_MANIFEST_CHANGED');
export const preparationRepairSource = JSON.parse(sourceBytes);
export const preparationRepairBaseImages = {
  api: digest('registry.fly.io/momo-result@sha256:bdd3007ca599697e8f5a2d5c6d9ea979d63758854b73421830ffc16bfce910dd'),
  worker: digest('registry.fly.io/momo-result-analysis@sha256:d3735e2fc779cd192b95ff9b9a8a0912be7b1be9a33671be6bb0daad3ca44116'),
  summit: 'e725daddea9155204d889c0f8c649cf701ee5b48c1461013f5d87b9d46cfb063',
};
const roles = ['api', 'worker', 'summit'];
const machineKeys = ['identityDigest', 'configWithoutImageDigest', 'bootDigest', 'secretDigest', 'machineIdDigest',
  'imageDigest', 'normalWritersDigest', 'mode'];

// The caller gathers private full identities, secrets and actual process status.
// No private object, name, URL or machine id leaves this constructor.
export function observePreparationRepair(raw) {
  exact(raw, ['observedAt', 'providers', 'database', 'barrierDigest'], 'INVALID_PREPARATION_REPAIR_RAW_OBSERVATION');
  check(time(raw.observedAt) && hash(raw.barrierDigest), 'INVALID_PREPARATION_REPAIR_OBSERVATION_TIME');
  exact(raw.providers, roles, 'PREPARATION_REPAIR_ALL_CONSUMERS_REQUIRED');
  validateDatabaseProof(raw.database);
  const machines = {};
  for (const role of roles) {
    const provider = raw.providers[role];
    exact(provider, ['machines', 'secrets', 'status'], 'INVALID_PREPARATION_REPAIR_PROVIDER_OBSERVATION');
    check(Array.isArray(provider.machines) && provider.machines.length === 1, 'PREPARATION_REPAIR_SINGLE_MACHINE_REQUIRED');
    const identity = provider.machines[0];
    exact(identity, ['id', 'instance', 'config', 'image', 'events', 'bootId'], 'INVALID_PREPARATION_REPAIR_MACHINE_IDENTITY');
    check(typeof identity.id === 'string' && /^[a-f0-9]{10,32}$/.test(identity.id) &&
      typeof identity.instance === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(identity.instance) &&
      /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(identity.bootId ?? '') &&
      /^.+@sha256:[a-f0-9]{64}$/.test(identity.image ?? '') && Array.isArray(identity.events) && identity.events.length > 0 &&
      identity.config && typeof identity.config === 'object' && !Array.isArray(identity.config), 'INVALID_PREPARATION_REPAIR_MACHINE_IDENTITY');
    assertStagedBootConfiguration(identity.config);
    check(identity.config.env?.[modeKey] === undefined || identity.config.env[modeKey] === 'normal', 'PREPARATION_REPAIR_NORMAL_CONFIG_REQUIRED');
    const secrets = validateSecrets(provider.secrets);
    check(secrets.every(secret => secret.status === 'Deployed'), 'PREPARATION_REPAIR_DEPLOYED_SECRETS_REQUIRED');
    assertDrain(role, provider.status, null, 'normal');
    const configWithoutImage = structuredClone(identity.config);
    delete configWithoutImage.image;
    const normalWriters = provider.status.writers.map(({ name, stage, status }) => ({ name, stage, status }))
      .sort((a, b) => a.name.localeCompare(b.name));
    machines[role] = {
      identityDigest: digest(identity), configWithoutImageDigest: digest(configWithoutImage),
      bootDigest: digest({ id: identity.id, instance: identity.instance, bootId: identity.bootId }),
      secretDigest: digest(secrets.map(({ name, digest: value, status }) => ({ name, digest: value, status }))),
      machineIdDigest: digest(identity.id), imageDigest: digest(identity.image),
      normalWritersDigest: digest(normalWriters), mode: 'normal',
    };
  }
  return validatePreparationObservation({ formatVersion: 1, observedAt: raw.observedAt, machines,
    database: structuredClone(raw.database), barrierDigest: raw.barrierDigest });
}

export function validatePreparationObservation(value) {
  exact(value, ['formatVersion', 'observedAt', 'machines', 'database', 'barrierDigest'], 'INVALID_PREPARATION_REPAIR_OBSERVATION');
  check(value.formatVersion === 1 && time(value.observedAt) && hash(value.barrierDigest), 'INVALID_PREPARATION_REPAIR_OBSERVATION');
  exact(value.machines, roles, 'PREPARATION_REPAIR_ALL_CONSUMERS_REQUIRED');
  for (const role of roles) {
    exact(value.machines[role], machineKeys, 'INVALID_PREPARATION_REPAIR_MACHINE_PROOF');
    check(machineKeys.filter(key => key !== 'mode').every(key => hash(value.machines[role][key])) &&
      value.machines[role].mode === 'normal', 'PREPARATION_REPAIR_NORMAL_MACHINE_PROOF_REQUIRED');
  }
  validateDatabaseProof(value.database);
  return value;
}

export function validatePreparationCandidate(value) {
  exact(value, ['formatVersion', 'operation', 'baseSha', 'patchSha', 'sourceSha', 'sourceTree', 'sourceManifestSha256',
    'workflowSha', 'runId', 'runAttempt', 'archiveSha256', 'configDigest', 'rootfsDigest'], 'INVALID_PREPARATION_REPAIR_CANDIDATE');
  check(value.formatVersion === 1 && value.operation === preparationRepairOperation &&
    ['baseSha', 'patchSha', 'sourceSha', 'sourceTree'].every(key => value[key] === preparationRepairSource[key]) &&
    value.sourceManifestSha256 === preparationRepairSourceSha256, 'PREPARATION_REPAIR_SOURCE_CHANGED');
  check(sha(value.workflowSha) && runId(value.runId) && integer(value.runAttempt) && hash(value.archiveSha256) &&
    imageId(value.configDigest) && hash(value.rootfsDigest), 'INVALID_PREPARATION_REPAIR_IMAGE_PROVENANCE');
  return value;
}

function assertPreparing(record, empty = true) {
  validateControl(record);
  const cutover = record.cutover;
  check(cutover?.phase === 'PREPARING' && cutover.candidates === null && cutover.invalidatedReason === null &&
    Object.keys(cutover.evidence).length === 0 && (!empty || cutover.permits.length === 0), 'UNTOUCHED_PREPARATION_REQUIRED');
  return cutover;
}

export function validatePreparationCopyProof(value, candidate, baseline) {
  exact(value, ['formatVersion', 'kind', 'sourceSha', 'sourceManifestSha256', 'archiveSha256', 'configDigest', 'rootfsDigest',
    'sourceDatabase', 'peerImageDigests', 'snapshotDigest', 'sourceIdentityDigest', 'baselineLedgerDigest', 'baselineSchemaDigest', 'savedDataDigest',
    'normalReportDigest', 'frozenReportDigest', 'restartReportDigest', 'preservationReportDigest', 'frozenBoots', 'copies', 'consumers', 'frozenObservations',
    'normalPassed', 'frozenPassed', 'preservationPassed'], 'INVALID_PREPARATION_REPAIR_COPY_PROOF');
  check(value.formatVersion === 1 && value.kind === 'preparation-runtime-repair-copy-proof' &&
    ['sourceSha', 'sourceManifestSha256', 'archiveSha256', 'configDigest', 'rootfsDigest'].every(key => value[key] === candidate[key]),
  'PREPARATION_REPAIR_COPY_IMAGE_CHANGED');
  validateDatabaseProof(value.sourceDatabase);
  check(same(value.sourceDatabase, baseline.database), 'PREPARATION_REPAIR_COPY_SOURCE_CHANGED');
  exact(value.peerImageDigests, ['worker', 'summit'], 'INVALID_PREPARATION_REPAIR_COPY_PEERS');
  check(['worker', 'summit'].every(role => hash(value.peerImageDigests[role]) &&
    value.peerImageDigests[role] === baseline.machines[role].imageDigest), 'PREPARATION_REPAIR_COPY_PEER_CHANGED');
  check(['snapshotDigest', 'sourceIdentityDigest', 'baselineLedgerDigest', 'baselineSchemaDigest', 'savedDataDigest',
    'normalReportDigest', 'frozenReportDigest', 'restartReportDigest', 'preservationReportDigest'].every(key => hash(value[key])) &&
    value.frozenBoots === 3 && value.copies === 2 && value.consumers === 3 && value.frozenObservations === 18 &&
    value.normalPassed === true && value.frozenPassed === true && value.preservationPassed === true,
  'PREPARATION_REPAIR_COPY_NOT_VERIFIED');
  return value;
}

export function validatePreparationReceipt(receipt) {
  exact(receipt, ['formatVersion', 'operation', 'cutoverId', 'stopEpoch', 'baselineControl', 'candidate', 'producer',
    'baseline', 'copyProof', 'deadline', 'execution'], 'INVALID_PREPARATION_REPAIR_RECEIPT');
  check(receipt.formatVersion === 1 && receipt.operation === preparationRepairOperation &&
    typeof receipt.cutoverId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(receipt.cutoverId) && integer(receipt.stopEpoch) &&
    time(receipt.deadline), 'INVALID_PREPARATION_REPAIR_RECEIPT_IDENTITY');
  exact(receipt.baselineControl, ['head', 'record'], 'INVALID_PREPARATION_REPAIR_BASELINE_CONTROL');
  check(sha(receipt.baselineControl.head), 'INVALID_PREPARATION_REPAIR_BASELINE_HEAD');
  const cutover = assertPreparing(receipt.baselineControl.record);
  check(cutover.id === receipt.cutoverId && cutover.stopEpoch === receipt.stopEpoch, 'PREPARATION_REPAIR_STOP_CHANGED');
  validatePreparationCandidate(receipt.candidate);
  exact(receipt.producer, ['workflowSha', 'runId', 'runAttempt', 'artifact', 'candidateDigest'], 'INVALID_PREPARATION_REPAIR_PRODUCER');
  exact(receipt.producer.artifact, ['id', 'digest'], 'INVALID_PREPARATION_REPAIR_ARTIFACT');
  check(['workflowSha', 'runId', 'runAttempt'].every(key => receipt.producer[key] === receipt.candidate[key]) &&
    receipt.producer.candidateDigest === digest(receipt.candidate) && runId(receipt.producer.artifact.id) && hash(receipt.producer.artifact.digest),
  'PREPARATION_REPAIR_PRODUCER_CHANGED');
  validatePreparationObservation(receipt.baseline);
  check(Object.entries(preparationRepairBaseImages).every(([role, image]) => receipt.baseline.machines[role].imageDigest === image),
    'PREPARATION_REPAIR_BASE_IMAGE_CHANGED');
  validatePreparationCopyProof(receipt.copyProof, receipt.candidate, receipt.baseline);
  exact(receipt.execution, ['repository', 'workflow', 'ref', 'sha', 'runId', 'runAttempt'], 'INVALID_PREPARATION_REPAIR_EXECUTION');
  check(receipt.execution.repository === preparationRepairRepository && receipt.execution.workflow === preparationRepairWorkflow &&
    receipt.execution.ref === `refs/heads/cutover/${receipt.cutoverId}` && receipt.execution.sha === receipt.producer.workflowSha &&
    runId(receipt.execution.runId) && integer(receipt.execution.runAttempt) && receipt.execution.runId !== receipt.producer.runId,
  'PREPARATION_REPAIR_EXECUTION_CHANGED');
  check(Date.parse(receipt.deadline) > Date.parse(receipt.baseline.observedAt), 'INVALID_PREPARATION_REPAIR_DEADLINE');
  return receipt;
}

const permitFor = receipt => ({ operation: preparationRepairOperation, repository: preparationRepairRepository,
  runId: receipt.execution.runId, runAttempt: receipt.execution.runAttempt, receiptDigest: digest(receipt), deadline: receipt.deadline });

export function grantPreparationRepair(previous, receipt, now = new Date().toISOString()) {
  validatePreparationReceipt(receipt);
  assertPreparing(previous.record);
  check(previous.head === receipt.baselineControl.head && same(previous.record, receipt.baselineControl.record), 'PREPARATION_REPAIR_BASELINE_CONTROL_CHANGED');
  check(time(now) && Date.parse(now) < Date.parse(receipt.deadline), 'PREPARATION_REPAIR_DEADLINE_PASSED');
  const record = structuredClone(previous.record);
  record.stateVersion++;
  record.updatedAt = now;
  record.cutover.permits = [permitFor(receipt)];
  return validateControl(record);
}

function assertGrant(current, receipt, grantHead, now) {
  validatePreparationReceipt(receipt);
  assertPreparing(current.record, false);
  check(sha(grantHead) && current.head === grantHead, 'PREPARATION_REPAIR_GRANT_HEAD_CHANGED');
  const expected = grantPreparationRepair({ head: receipt.baselineControl.head, record: receipt.baselineControl.record }, receipt, current.record.updatedAt);
  check(same(current.record, expected), 'PREPARATION_REPAIR_GRANT_RECORD_CHANGED');
  check(time(now) && Date.parse(now) < Date.parse(receipt.deadline), 'PREPARATION_REPAIR_DEADLINE_PASSED');
}

function freshObservation(observation, now) {
  validatePreparationObservation(observation);
  const age = Date.parse(now) - Date.parse(observation.observedAt);
  check(Number.isFinite(age) && age >= 0 && age <= 90000, 'PREPARATION_REPAIR_OBSERVATION_EXPIRED');
}

export function validatePreparationRegistryProof(proof, candidate) {
  exact(proof, ['formatVersion', 'archiveSha256', 'configDigest', 'rootfsDigest', 'imageDigest'], 'INVALID_PREPARATION_REPAIR_REGISTRY_PROOF');
  check(proof.formatVersion === 1 && ['archiveSha256', 'configDigest', 'rootfsDigest'].every(key => proof[key] === candidate[key]) &&
    hash(proof.imageDigest), 'PREPARATION_REPAIR_REGISTRY_IMAGE_CHANGED');
  return proof;
}

export function assertPreparationRepairMutation(current, receipt, grantHead, context, evidence, step, now = new Date().toISOString()) {
  assertGrant(current, receipt, grantHead, now);
  check(context.eventName === 'workflow_dispatch' && same(context.execution, receipt.execution), 'PREPARATION_REPAIR_EXECUTION_CHANGED');
  check(['registry-push', 'runtime-update'].includes(step), 'INVALID_PREPARATION_REPAIR_STEP');
  exact(evidence, ['observation', 'registryProof'], 'INVALID_PREPARATION_REPAIR_GUARD_EVIDENCE');
  freshObservation(evidence.observation, now);
  check(['machines', 'database', 'barrierDigest'].every(key => same(evidence.observation[key], receipt.baseline[key])),
    'PREPARATION_REPAIR_BASELINE_DRIFTED');
  if (step === 'runtime-update') validatePreparationRegistryProof(evidence.registryProof, receipt.candidate);
  else check(evidence.registryProof === null, 'UNEXPECTED_PREPARATION_REPAIR_REGISTRY_PROOF');
  return { controlHead: current.head, stateVersion: current.record.stateVersion, cutoverId: receipt.cutoverId,
    stopEpoch: receipt.stopEpoch, receiptDigest: digest(receipt), step };
}

const deploymentKeys = ['formatVersion', 'receiptDigest', 'grantHead', 'execution', 'observation', 'registryProof', 'normalSmokeDigest', 'normalSmokePassed'];

// Validate the deploy artifact before upload without inventing its future id or
// digest. Operator completion adds that identity and a new matching observation.
export function validatePreparationDeployment(receipt, grantHead, completion) {
  validatePreparationReceipt(receipt);
  exact(completion, deploymentKeys, 'INVALID_PREPARATION_REPAIR_DEPLOYMENT');
  check(completion.formatVersion === 1 && completion.receiptDigest === digest(receipt) && completion.grantHead === grantHead &&
    sha(grantHead) && same(completion.execution, receipt.execution) && hash(completion.normalSmokeDigest) &&
    completion.normalSmokePassed === true, 'PREPARATION_REPAIR_COMPLETION_NOT_VERIFIED');
  validatePreparationObservation(completion.observation);
  validatePreparationRegistryProof(completion.registryProof, receipt.candidate);
  const before = receipt.baseline;
  const after = completion.observation;
  check(same(before.database, after.database) && before.barrierDigest === after.barrierDigest &&
    ['worker', 'summit'].every(role => same(before.machines[role], after.machines[role])), 'PREPARATION_REPAIR_PEER_OR_DATABASE_CHANGED');
  check(['configWithoutImageDigest', 'secretDigest', 'machineIdDigest', 'normalWritersDigest', 'mode']
    .every(key => before.machines.api[key] === after.machines.api[key]) &&
    before.machines.api.bootDigest !== after.machines.api.bootDigest && before.machines.api.identityDigest !== after.machines.api.identityDigest &&
    after.machines.api.imageDigest === completion.registryProof.imageDigest && before.machines.api.imageDigest !== after.machines.api.imageDigest,
  'PREPARATION_REPAIR_RUNTIME_UPDATE_NOT_VERIFIED');
  return completion;
}

export function completePreparationRepair(current, receipt, grantHead, completion, now = new Date().toISOString()) {
  assertGrant(current, receipt, grantHead, now);
  exact(completion, [...deploymentKeys, 'freshObservation', 'deploymentArtifact'], 'INVALID_PREPARATION_REPAIR_COMPLETION');
  validatePreparationDeployment(receipt, grantHead, Object.fromEntries(deploymentKeys.map(key => [key, completion[key]])));
  exact(completion.deploymentArtifact, ['id', 'digest'], 'INVALID_PREPARATION_REPAIR_COMPLETION_ARTIFACT');
  check(runId(completion.deploymentArtifact.id) && hash(completion.deploymentArtifact.digest), 'PREPARATION_REPAIR_COMPLETION_NOT_VERIFIED');
  freshObservation(completion.freshObservation, now);
  check(Date.parse(completion.observation.observedAt) >= Date.parse(current.record.updatedAt) &&
    Date.parse(completion.observation.observedAt) <= Date.parse(completion.freshObservation.observedAt) &&
    ['machines', 'database', 'barrierDigest'].every(key => same(completion.observation[key], completion.freshObservation[key])),
  'PREPARATION_REPAIR_POST_DEPLOY_DRIFTED');
  const record = structuredClone(current.record);
  record.epoch++;
  record.stateVersion++;
  record.updatedAt = now;
  record.cutover.stopEpoch = record.epoch;
  record.cutover.permits = [];
  record.cutover.evidence = { preparationRepair: digest(completion) };
  return validateControl(record);
}

export async function verifyPreparationProducer(receipt, request = githubApi) {
  validatePreparationReceipt(receipt);
  const root = `repos/${preparationRepairRepository}`;
  const producer = receipt.producer;
  const run = await request(`${root}/actions/runs/${producer.runId}/attempts/${producer.runAttempt}`);
  check(String(run.id) === producer.runId && run.run_attempt === producer.runAttempt && run.head_sha === producer.workflowSha &&
    run.head_branch === `cutover/${receipt.cutoverId}` && run.event === 'workflow_dispatch' && run.path === preparationRepairWorkflow &&
    run.status === 'completed' && run.conclusion === 'success', 'PREPARATION_REPAIR_SUCCESSFUL_PRODUCER_REQUIRED');
  const artifact = await request(`${root}/actions/artifacts/${producer.artifact.id}`);
  check(String(artifact.id) === producer.artifact.id && artifact.expired === false && artifact.digest === `sha256:${producer.artifact.digest}` &&
    String(artifact.workflow_run?.id) === producer.runId && artifact.workflow_run.head_sha === producer.workflowSha &&
    artifact.workflow_run.head_branch === `cutover/${receipt.cutoverId}` &&
    artifact.name === `preparation-runtime-image-${producer.runId}-${producer.runAttempt}`, 'PREPARATION_REPAIR_ARTIFACT_CHANGED');
  return { runId: producer.runId, runAttempt: producer.runAttempt, artifactId: producer.artifact.id, candidateDigest: digest(receipt.candidate) };
}

// A fresh API read provides the same public policy digest at bind, grant and
// both mutation boundaries. The one repair run is excluded only by its full
// execution tuple. Failed or truncated inventories never become permission.
export async function inspectPreparationBarriers(record, execution = null, request = githubApi) {
  validateControl(record);
  check(record.cutover?.phase === 'PREPARING', 'PREPARATION_REPAIR_PHASE_REQUIRED');
  const environments = [];
  for (const expected of deploymentEnvironments) {
    const path = `repos/${expected.repository}/environments/${encodeURIComponent(expected.name)}`;
    const [environment, policies] = await Promise.all([request(path), request(`${path}/deployment-branch-policies?per_page=100`)]);
    environments.push(verifyEnvironment(environment, policies, expected, record.cutover.id, approvalPolicy(environment)));
  }
  const protection = await request('repos/ponta2git/momo-db/branches/maintenance-control/protection');
  check(protection.enforce_admins?.enabled === true && protection.allow_force_pushes?.enabled === false &&
    protection.allow_deletions?.enabled === false, 'CONTROL_REF_PROTECTION_REQUIRED');
  const collaborators = await request('repos/ponta2git/momo-db/collaborators?per_page=100&affiliation=all');
  check(Array.isArray(collaborators) && collaborators.length < 100, 'CONTROL_WRITER_INVENTORY_INCOMPLETE');
  const writers = collaborators.filter(item => item.permissions?.push || item.permissions?.maintain || item.permissions?.admin);
  check(writers.length === 1 && writers[0].login === record.operator, 'SINGLE_CONTROL_WRITER_REQUIRED');
  const publisher = await request(`repos/${preparationRepairRepository}/actions/workflows/runtime-release.yml`);
  check(publisher.path === '.github/workflows/runtime-release.yml' && publisher.state === 'disabled_manually', 'PREPARATION_REPAIR_PUBLISHER_NOT_DISABLED');
  for (const repository of ['ponta2git/momo-db', preparationRepairRepository, 'ponta2git/summit']) {
    for (const status of ['queued', 'requested', 'pending', 'in_progress', 'waiting']) {
      const runs = await request(`repos/${repository}/actions/runs?status=${status}&per_page=100`);
      check(Number.isSafeInteger(runs.total_count) && runs.total_count >= 0 && runs.total_count < 100 &&
        Array.isArray(runs.workflow_runs) && runs.workflow_runs.length === runs.total_count, 'PREPARATION_REPAIR_JOB_INVENTORY_INCOMPLETE');
      check(runs.workflow_runs.every(run => execution && repository === execution.repository && String(run.id) === execution.runId &&
        run.run_attempt === execution.runAttempt && run.head_sha === execution.sha && run.head_branch === execution.ref.replace(/^refs\/heads\//, '') &&
        run.path === execution.workflow && run.event === 'workflow_dispatch'), 'PREPARATION_REPAIR_OTHER_RUN_ACTIVE');
    }
  }
  return digest({ formatVersion: 1, cutoverId: record.cutover.id, environments, controlProtection: true,
    operator: record.operator, publisherDisabled: true, otherRunsActive: false });
}

export async function verifyPreparationGrantParent(grantHead, receipt, request = githubApi) {
  check(sha(grantHead), 'INVALID_PREPARATION_REPAIR_GRANT_HEAD');
  const commit = await request(`repos/ponta2git/momo-db/git/commits/${grantHead}`);
  check(Array.isArray(commit.parents) && commit.parents.length === 1 && commit.parents[0].sha === receipt.baselineControl.head,
    'PREPARATION_REPAIR_GRANT_PARENT_CHANGED');
}

export async function verifyPreparationCompletion(receipt, completion, request = githubApi) {
  validatePreparationReceipt(receipt);
  const root = `repos/${preparationRepairRepository}`;
  const execution = receipt.execution;
  const run = await request(`${root}/actions/runs/${execution.runId}/attempts/${execution.runAttempt}`);
  check(String(run.id) === execution.runId && run.run_attempt === execution.runAttempt && run.head_sha === execution.sha &&
    run.head_branch === `cutover/${receipt.cutoverId}` && run.event === 'workflow_dispatch' && run.path === preparationRepairWorkflow &&
    run.status === 'completed' && run.conclusion === 'success', 'PREPARATION_REPAIR_SUCCESSFUL_EXECUTION_REQUIRED');
  const expected = completion.deploymentArtifact;
  exact(expected, ['id', 'digest'], 'INVALID_PREPARATION_REPAIR_COMPLETION_ARTIFACT');
  check(runId(expected.id) && hash(expected.digest), 'INVALID_PREPARATION_REPAIR_COMPLETION_ARTIFACT');
  const artifact = await request(`${root}/actions/artifacts/${expected.id}`);
  check(String(artifact.id) === expected.id && artifact.expired === false && artifact.digest === `sha256:${expected.digest}` &&
    String(artifact.workflow_run?.id) === execution.runId && artifact.workflow_run.head_sha === execution.sha &&
    artifact.workflow_run.head_branch === `cutover/${receipt.cutoverId}` &&
    artifact.name === `preparation-runtime-deployment-${execution.runId}-${execution.runAttempt}`, 'PREPARATION_REPAIR_COMPLETION_ARTIFACT_CHANGED');
}
