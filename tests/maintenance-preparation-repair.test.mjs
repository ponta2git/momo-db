import assert from 'node:assert/strict';
import test from 'node:test';
import { initialControl, transition, digest, validateControl, validateReceipt, assertNormalMutation, preparationRepairOperation } from '../scripts/maintenance/control.mjs';
import { observePreparationRepair, preparationRepairSource, preparationRepairSourceSha256, preparationRepairWorkflow, preparationRepairBaseImages,
  preparationRepairRepository, validatePreparationReceipt, grantPreparationRepair, assertPreparationRepairMutation,
  completePreparationRepair, verifyPreparationProducer, inspectPreparationBarriers, verifyPreparationCompletion,
  verifyPreparationGrantParent, validatePreparationDeployment } from '../scripts/maintenance/preparation-repair.mjs';
import { guardPreparationExecution } from '../scripts/maintenance/preparation-repair-run.mjs';

const beforeTime = '2026-10-18T00:00:00.000Z';
const grantTime = '2026-10-18T00:00:01.000Z';
const now = '2026-10-18T00:00:10.000Z';
const deadline = '2026-10-18T01:00:00.000Z';
const baselineHead = 'a'.repeat(40);
const grantHead = 'b'.repeat(40);
const workflowSha = 'c'.repeat(40);
const e = name => digest({ fixture: name });
const code = expected => error => error.code === expected;
const baseImages = {
  api: 'registry.fly.io/momo-result@sha256:bdd3007ca599697e8f5a2d5c6d9ea979d63758854b73421830ffc16bfce910dd',
  worker: 'registry.fly.io/momo-result-analysis@sha256:d3735e2fc779cd192b95ff9b9a8a0912be7b1be9a33671be6bb0daad3ca44116',
  summit: `registry.fixture.invalid/summit@sha256:${e('summit-image')}`,
};
const writerDefinitions = {
  api: { http_admission: 'admission', http_continuations_and_runtime: 'all' },
  worker: { scheduler_and_attempts: 'admission', runtime_and_notifications: 'all' },
  summit: { startup: 'admission', discord_interactions: 'admission', reconnect_recovery: 'admission',
    scheduler: 'admission', ask_sends: 'admission', notification_operations: 'admission', result_notifications: 'all' },
};

function rawObservation() {
  const consumers = { api: 'momo-result-api', worker: 'momo-processing-worker', summit: 'summit' };
  const providers = {};
  for (const [index, role] of Object.keys(consumers).entries()) {
    providers[role] = { machines: [{ id: String(index + 1).repeat(14), instance: `fixture-instance-${role}`,
      image: baseImages[role], bootId: '00000000-0000-0000-0000-000000000001', events: [{ type: 'start' }],
      config: { image: baseImages[role], env: { MOMO_MAINTENANCE_MODE: 'normal', PRIVATE_CANARY: 'must-never-appear' },
        guest: { cpus: 1, memory_mb: 256 } } }],
    secrets: [{ name: 'PRIVATE_SECRET_CANARY', digest: 'private-secret-metadata-canary', status: 'Deployed' }],
    status: { consumer: consumers[role], scope: 'process', phase: 'running', cutoverId: null, stopEpoch: null, stage: null,
      writers: Object.entries(writerDefinitions[role]).map(([name, stage]) => ({ name, stage, status: 'active' })),
      ...(role === 'worker' ? { mode: 'normal', processId: 12 } : {}), inFlight: { requests: 1 } } };
  }
  return { observedAt: beforeTime, providers, database: { formatVersion: 1, targetFingerprint: e('old-target'),
    ledgerFingerprint: e('old-full-ledger') }, barrierDigest: e('barriers') };
}

function receipt() {
  const control = transition(initialControl('fixture-operator', beforeTime), 1, 'begin', { cutoverId: 'fixture-cutover' }, beforeTime);
  const candidate = { formatVersion: 1, operation: preparationRepairOperation,
    ...Object.fromEntries(['baseSha', 'patchSha', 'sourceSha', 'sourceTree'].map(key => [key, preparationRepairSource[key]])),
    sourceManifestSha256: preparationRepairSourceSha256, workflowSha, runId: '100', runAttempt: 2,
    archiveSha256: e('image-archive'), configDigest: `sha256:${e('image-config')}`, rootfsDigest: e('rootfs') };
  const baseline = observePreparationRepair(rawObservation());
  baseline.machines.summit.imageDigest = preparationRepairBaseImages.summit;
  return { formatVersion: 1, operation: preparationRepairOperation, cutoverId: 'fixture-cutover', stopEpoch: 1,
    baselineControl: { head: baselineHead, record: control }, candidate,
    producer: { workflowSha, runId: '100', runAttempt: 2, artifact: { id: '200', digest: e('producer-artifact') }, candidateDigest: digest(candidate) },
    baseline, copyProof: { formatVersion: 1, kind: 'preparation-runtime-repair-copy-proof',
      ...Object.fromEntries(['sourceSha', 'sourceManifestSha256', 'archiveSha256', 'configDigest', 'rootfsDigest'].map(key => [key, candidate[key]])),
      sourceDatabase: structuredClone(baseline.database), peerImageDigests: {
        worker: baseline.machines.worker.imageDigest, summit: baseline.machines.summit.imageDigest },
      snapshotDigest: e('snapshot'), sourceIdentityDigest: e('source-identity'),
      baselineLedgerDigest: e('ledger'), baselineSchemaDigest: e('schema'), savedDataDigest: e('saved-data'),
      normalReportDigest: e('normal'), frozenReportDigest: e('frozen'), restartReportDigest: e('restarts'), preservationReportDigest: e('preservation'),
      frozenBoots: 3, copies: 2, consumers: 3, frozenObservations: 18, normalPassed: true, frozenPassed: true, preservationPassed: true }, deadline,
    execution: { repository: preparationRepairRepository, workflow: preparationRepairWorkflow,
      ref: 'refs/heads/cutover/fixture-cutover', sha: workflowSha, runId: '300', runAttempt: 1 } };
}
const context = value => ({ eventName: 'workflow_dispatch', execution: structuredClone(value.execution) });
const granted = value => ({ head: grantHead, record: grantPreparationRepair(value.baselineControl, value, grantTime) });
const registryProof = value => ({ formatVersion: 1, archiveSha256: value.candidate.archiveSha256,
  configDigest: value.candidate.configDigest, rootfsDigest: value.candidate.rootfsDigest, imageDigest: e('actual-immutable-new-image') });
const evidence = value => ({ observation: structuredClone(value.baseline), registryProof: null });
function completion(value) {
  const observation = structuredClone(value.baseline);
  observation.observedAt = now;
  Object.assign(observation.machines.api, { imageDigest: registryProof(value).imageDigest, identityDigest: e('new-api-identity'), bootDigest: e('new-api-boot') });
  return { formatVersion: 1, receiptDigest: digest(value), grantHead, execution: structuredClone(value.execution), observation,
    freshObservation: structuredClone(observation),
    registryProof: registryProof(value), normalSmokeDigest: e('actual-normal-smoke'), normalSmokePassed: true,
    deploymentArtifact: { id: '400', digest: e('deployment-artifact') } };
}

test('one bounded preparation repair retains normal deployment hold and advances the epoch only after verified completion', () => {
  const value = receipt();
  validatePreparationReceipt(value);
  const current = granted(value);
  assert.equal(current.record.cutover.phase, 'PREPARING');
  assert.equal(current.record.cutover.candidates, null);
  assert.equal(current.record.epoch, 1);
  assert.throws(() => assertNormalMutation(current.record), code('NORMAL_MUTATION_HELD_FOR_MAINTENANCE'));
  assertPreparationRepairMutation(current, value, grantHead, context(value), evidence(value), 'registry-push', now);
  assertPreparationRepairMutation(current, value, grantHead, context(value), { ...evidence(value), registryProof: registryProof(value) }, 'runtime-update', now);
  const completed = completePreparationRepair(current, value, grantHead, completion(value), now);
  assert.equal(completed.cutover.phase, 'PREPARING');
  assert.equal(completed.cutover.candidates, null);
  assert.equal(completed.epoch, 2);
  assert.equal(completed.cutover.stopEpoch, 2);
  assert.deepEqual(completed.cutover.permits, []);
  assert.deepEqual(completed.cutover.evidence, { preparationRepair: digest(completion(value)) });
  assert.throws(() => assertNormalMutation(completed), code('NORMAL_MUTATION_HELD_FOR_MAINTENANCE'));
  const pinned = transition(completed, completed.stateVersion, 'pin', { cutoverId: value.cutoverId, stopEpoch: 2,
    candidates: { db: 'd'.repeat(40), summit: 'e'.repeat(40), result: 'f'.repeat(40) } }, now);
  const draining = transition(pinned, pinned.stateVersion, 'advance', { cutoverId: value.cutoverId, stopEpoch: 2,
    phase: 'DRAINING', evidenceDigest: e('new-deployment-freeze') }, now);
  assert.equal(draining.cutover.evidence.preparationRepair, completed.cutover.evidence.preparationRepair);
  assert.equal(draining.cutover.evidence.deploymentFreeze, e('new-deployment-freeze'));
  assert.throws(() => grantPreparationRepair({ head: 'd'.repeat(40), record: completed }, value, now), code('UNTOUCHED_PREPARATION_REQUIRED'));
  assert.throws(() => assertPreparationRepairMutation({ head: 'd'.repeat(40), record: completed }, value, grantHead, context(value), evidence(value), 'registry-push', now));
});

test('existing permits and receipt validators cannot authorize repair or turn it into ordinary deployment', () => {
  const value = receipt();
  const current = granted(value);
  const payload = { cutoverId: value.cutoverId, stopEpoch: 1, permit: current.record.cutover.permits[0] };
  assert.throws(() => transition(value.baselineControl.record, 2, 'permit', payload, now), code('DEDICATED_PREPARATION_REPAIR_GRANT_REQUIRED'));
  assert.throws(() => transition(current.record, 3, 'pin', { cutoverId: value.cutoverId, stopEpoch: 1,
    candidates: { db: 'd'.repeat(40), summit: 'e'.repeat(40), result: 'f'.repeat(40) } }, now), code('PREPARATION_REPAIR_IN_PROGRESS'));
  assert.throws(() => validateReceipt(value), code('INVALID_RECEIPT'));
  for (const mutate of [
    record => { record.cutover.phase = 'DRAINING'; record.cutover.candidates = { db: 'd'.repeat(40), summit: 'e'.repeat(40), result: 'f'.repeat(40) }; },
    record => { record.cutover.evidence.finalRehearsal = e('fake'); },
    record => { record.cutover.permits.push({ ...record.cutover.permits[0], runId: '301' }); },
  ]) {
    const changed = structuredClone(current.record); mutate(changed);
    assert.throws(() => validateControl(changed), code('INVALID_PREPARATION_REPAIR_STATE'));
  }
});

test('normal observation hashes private identities and rejects uncertain inventory, secrets or process mode', () => {
  const normalized = observePreparationRepair(rawObservation());
  const output = JSON.stringify(normalized);
  for (const forbidden of ['must-never-appear', 'PRIVATE_CANARY', 'PRIVATE_SECRET_CANARY', 'private-secret-metadata-canary',
    'fixture-instance', '11111111111111', 'registry.fly.io']) assert.equal(output.includes(forbidden), false, forbidden);
  const raw = rawObservation(); raw.providers.api.status.inFlight.requests++;
  assert.deepEqual(observePreparationRepair(raw), normalized);
  for (const mutate of [
    item => { item.providers.api.machines.push(item.providers.api.machines[0]); },
    item => { item.providers.worker.status.mode = 'frozen'; },
    item => { item.providers.api.status.phase = 'draining'; },
    item => { item.providers.summit.status.writers.pop(); },
    item => { item.providers.api.status.writers[0].failure = true; },
    item => { item.providers.api.secrets[0].status = 'Staged'; },
    item => { item.providers.api.machines[0].config.env.MOMO_MAINTENANCE_MODE = 'frozen'; },
    item => { item.providers.api.machines[0].config.ignore_app_secrets = true; },
    item => { item.providers.worker.machines[0].bootId = ''; },
    item => { delete item.providers.summit; },
    item => { item.database.ledgerFingerprint = ''; },
  ]) {
    const changed = rawObservation(); mutate(changed);
    assert.throws(() => observePreparationRepair(changed));
  }
});

test('receipt rejects source, copy, producer, baseline and public-field substitutions', () => {
  for (const mutate of [
    value => { value.operation = 'consumers'; },
    value => { value.candidate.sourceSha = 'e'.repeat(40); },
    value => { value.candidate.sourceTree = 'e'.repeat(40); },
    value => { value.candidate.sourceManifestSha256 = e('another-source'); },
    value => { value.producer.runAttempt++; },
    value => { value.producer.candidateDigest = e('another-candidate'); },
    value => { value.producer.artifact.secret = 'private-canary'; },
    value => { value.baselineControl.record.cutover.candidates = { db: 'd'.repeat(40), summit: 'e'.repeat(40), result: 'f'.repeat(40) }; },
    value => { value.baseline.machines.api.imageDigest = e('another-base-image'); },
    value => { value.baseline.machines.summit.imageDigest = e('another-summit-image'); },
    value => { value.baseline.machines.api.machineId = 'private-canary'; },
    value => { value.copyProof.archiveSha256 = e('another-image'); },
    value => { value.copyProof.sourceDatabase.ledgerFingerprint = e('another-ledger'); },
    value => { value.copyProof.peerImageDigests.worker = e('another-worker'); },
    value => { value.copyProof.peerImageDigests.summit = e('another-summit'); },
    value => { value.copyProof.frozenBoots = 2; },
    value => { value.copyProof.frozenObservations = 12; },
    value => { value.copyProof.consumers = 2; },
    value => { value.copyProof.copies = 1; },
    value => { value.copyProof.preservationPassed = false; },
    value => { value.execution.sha = value.candidate.sourceSha; },
    value => { value.execution.ref = 'refs/heads/master'; },
    value => { value.execution.runId = value.producer.runId; },
    value => { value.deadline = 'tomorrow'; },
    value => { value.secret = 'private-canary'; },
  ]) {
    const value = receipt(); mutate(value);
    assert.throws(() => validatePreparationReceipt(value));
  }
});

test('both mutation boundaries reject stale heads, retries, deadlines, identity drift and wrong archive registration', () => {
  const value = receipt(); const current = granted(value);
  assert.throws(() => grantPreparationRepair({ ...value.baselineControl, head: 'd'.repeat(40) }, value, now), code('PREPARATION_REPAIR_BASELINE_CONTROL_CHANGED'));
  assert.throws(() => assertPreparationRepairMutation({ ...current, head: 'd'.repeat(40) }, value, grantHead, context(value), evidence(value), 'registry-push', now), code('PREPARATION_REPAIR_GRANT_HEAD_CHANGED'));
  const retried = context(value); retried.execution.runAttempt++;
  assert.throws(() => assertPreparationRepairMutation(current, value, grantHead, retried, evidence(value), 'registry-push', now), code('PREPARATION_REPAIR_EXECUTION_CHANGED'));
  assert.throws(() => assertPreparationRepairMutation(current, value, grantHead, context(value), evidence(value), 'registry-push', deadline), code('PREPARATION_REPAIR_DEADLINE_PASSED'));
  for (const mutate of [
    item => { item.observation.observedAt = '2026-10-17T23:00:00.000Z'; },
    item => { item.observation.observedAt = '2026-10-18T00:00:11.000Z'; },
    item => { item.observation.machines.api.identityDigest = e('same-image-but-restarted'); },
    item => { item.observation.machines.worker.bootDigest = e('worker-restarted'); },
    item => { item.observation.machines.summit.secretDigest = e('new-secret'); },
    item => { item.observation.database.ledgerFingerprint = e('new-ledger'); },
    item => { item.observation.barrierDigest = e('barrier-opened'); },
  ]) {
    const changed = evidence(value); mutate(changed);
    for (const step of ['registry-push', 'runtime-update']) assert.throws(() => assertPreparationRepairMutation(current, value, grantHead, context(value),
      { ...changed, registryProof: step === 'registry-push' ? null : registryProof(value) }, step, now));
  }
  for (const field of ['archiveSha256', 'configDigest', 'rootfsDigest']) {
    const changed = registryProof(value); changed[field] = field === 'configDigest' ? `sha256:${e('wrong')}` : e('wrong');
    assert.throws(() => assertPreparationRepairMutation(current, value, grantHead, context(value), { ...evidence(value), registryProof: changed }, 'runtime-update', now),
      code('PREPARATION_REPAIR_REGISTRY_IMAGE_CHANGED'));
  }
});

test('completion preserves every peer, mode, secret, old database and Runtime setting except image and boot', () => {
  const value = receipt(); const current = granted(value);
  const artifactBody = completion(value);
  delete artifactBody.freshObservation;
  delete artifactBody.deploymentArtifact;
  assert.doesNotThrow(() => validatePreparationDeployment(value, grantHead, artifactBody));
  assert.throws(() => validatePreparationDeployment(value, grantHead, { ...artifactBody, deploymentArtifact: null }),
    code('INVALID_PREPARATION_REPAIR_DEPLOYMENT'));
  for (const mutate of [
    item => { item.execution.runAttempt++; },
    item => { item.receiptDigest = e('different-receipt'); },
    item => { item.normalSmokePassed = false; },
    item => { item.normalSmokeDigest = ''; },
    item => { item.deploymentArtifact.digest = ''; },
    item => { item.observation.database.targetFingerprint = e('different-db'); },
    item => { item.observation.database.ledgerFingerprint = e('different-ledger'); },
    item => { item.observation.machines.worker.imageDigest = e('worker-updated'); },
    item => { item.observation.machines.summit.identityDigest = e('summit-restarted'); },
    item => { item.observation.machines.api.secretDigest = e('secret-changed'); },
    item => { item.observation.machines.api.configWithoutImageDigest = e('config-changed'); },
    item => { item.observation.machines.api.machineIdDigest = e('machine-changed'); },
    item => { item.observation.machines.api.normalWritersDigest = e('writer-changed'); },
    item => { item.observation.machines.api.mode = 'frozen'; },
    item => { item.observation.machines.api.imageDigest = e('unproven-registry-image'); },
    item => { item.observation.machines.api.bootDigest = value.baseline.machines.api.bootDigest; },
    item => { item.observation.barrierDigest = e('barrier-changed'); },
    item => { item.freshObservation.machines.api.bootDigest = e('restarted-after-deployment'); },
    item => { item.freshObservation.machines.worker.secretDigest = e('secret-after-deployment'); },
    item => { item.freshObservation.observedAt = beforeTime; },
  ]) {
    const changed = completion(value); mutate(changed);
    assert.throws(() => completePreparationRepair(current, value, grantHead, changed, now));
  }
  const delayed = completion(value);
  delayed.freshObservation.observedAt = '2026-10-18T00:05:00.000Z';
  assert.doesNotThrow(() => completePreparationRepair(current, value, grantHead, delayed, '2026-10-18T00:05:01.000Z'));
});

function fakeGithub(value, overrides = {}) {
  const calls = [];
  const request = async path => {
    calls.push(path);
    if (overrides[path]) return structuredClone(overrides[path]);
    if (path.includes('/environments/') && path.includes('/deployment-branch-policies')) return { total_count: 1,
      branch_policies: [{ type: 'branch', name: 'cutover/fixture-cutover' }] };
    if (path.includes('/environments/')) {
      const name = decodeURIComponent(path.split('/environments/')[1]);
      return { name, can_admins_bypass: false, deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
        protection_rules: name === 'CI Actions' ? [] : [{ type: 'required_reviewers', prevent_self_review: false,
          reviewers: [{ type: 'User', reviewer: { id: 123 } }] }] };
    }
    if (path.endsWith('/branches/maintenance-control/protection')) return { enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } };
    if (path.endsWith('/collaborators?per_page=100&affiliation=all')) return [{ login: 'fixture-operator', permissions: { admin: true } }];
    if (path.endsWith('/actions/workflows/runtime-release.yml')) return { path: '.github/workflows/runtime-release.yml', state: 'disabled_manually' };
    if (path.includes('/actions/runs?status=')) return { total_count: 0, workflow_runs: [] };
    if (path.endsWith(`/git/commits/${grantHead}`)) return { parents: [{ sha: baselineHead }] };
    if (path.endsWith('/actions/runs/100/attempts/2')) return { id: 100, run_attempt: 2, head_sha: workflowSha, head_branch: 'cutover/fixture-cutover',
      event: 'workflow_dispatch', path: preparationRepairWorkflow, status: 'completed', conclusion: 'success' };
    if (path.endsWith('/actions/runs/300/attempts/1')) return { id: 300, run_attempt: 1, head_sha: workflowSha, head_branch: 'cutover/fixture-cutover',
      event: 'workflow_dispatch', path: preparationRepairWorkflow, status: 'completed', conclusion: 'success' };
    if (path.endsWith('/actions/artifacts/200')) return { id: 200, expired: false, digest: `sha256:${value.producer.artifact.digest}`,
      name: 'preparation-runtime-image-100-2', workflow_run: { id: 100, head_sha: workflowSha, head_branch: 'cutover/fixture-cutover' } };
    if (path.endsWith('/actions/artifacts/400')) return { id: 400, expired: false, digest: `sha256:${e('deployment-artifact')}`,
      name: 'preparation-runtime-deployment-300-1', workflow_run: { id: 300, head_sha: workflowSha, head_branch: 'cutover/fixture-cutover' } };
    throw new Error(`unexpected fixture API ${path}`);
  };
  return { request, calls };
}

test('producer, grant parent and completion APIs bind distinct successful attempts and unexpired artifacts', async () => {
  const value = receipt();
  const root = `repos/${preparationRepairRepository}`;
  const fixture = fakeGithub(value);
  await verifyPreparationProducer(value, fixture.request);
  await verifyPreparationGrantParent(grantHead, value, fixture.request);
  await verifyPreparationCompletion(value, completion(value), fixture.request);
  for (const [path, mutate] of [
    [`${root}/actions/runs/100/attempts/2`, item => { item.head_sha = value.candidate.sourceSha; }],
    [`${root}/actions/runs/100/attempts/2`, item => { item.run_attempt = 1; }],
    [`${root}/actions/runs/100/attempts/2`, item => { item.conclusion = 'failure'; }],
    [`${root}/actions/runs/100/attempts/2`, item => { item.head_branch = 'master'; }],
    [`${root}/actions/artifacts/200`, item => { item.expired = true; }],
    [`${root}/actions/artifacts/200`, item => { item.name = 'preparation-runtime-image-100-1'; }],
    [`${root}/actions/artifacts/200`, item => { item.digest = `sha256:${e('replaced-artifact')}`; }],
  ]) {
    const item = await fixture.request(path); mutate(item);
    await assert.rejects(() => verifyPreparationProducer(value, fakeGithub(value, { [path]: item }).request));
  }
  await assert.rejects(() => verifyPreparationGrantParent(grantHead, value, fakeGithub(value, {
    [`repos/ponta2git/momo-db/git/commits/${grantHead}`]: { parents: [{ sha: 'd'.repeat(40) }] },
  }).request), code('PREPARATION_REPAIR_GRANT_PARENT_CHANGED'));
  const completeRun = `${root}/actions/runs/300/attempts/1`;
  const failed = await fixture.request(completeRun); failed.status = 'in_progress'; failed.conclusion = null;
  await assert.rejects(() => verifyPreparationCompletion(value, completion(value), fakeGithub(value, { [completeRun]: failed }).request),
    code('PREPARATION_REPAIR_SUCCESSFUL_EXECUTION_REQUIRED'));
});

test('barriers reject active outsiders, partial inventory, changed policy and reenabled publisher', async () => {
  const value = receipt(); const fixture = fakeGithub(value);
  const baseline = await inspectPreparationBarriers(value.baselineControl.record, value.execution, fixture.request);
  assert.match(baseline, /^[a-f0-9]{64}$/);
  const runsPath = `repos/${preparationRepairRepository}/actions/runs?status=in_progress&per_page=100`;
  const own = { id: 300, run_attempt: 1, head_sha: workflowSha, head_branch: 'cutover/fixture-cutover',
    event: 'workflow_dispatch', path: preparationRepairWorkflow };
  assert.equal(await inspectPreparationBarriers(value.baselineControl.record, value.execution,
    fakeGithub(value, { [runsPath]: { total_count: 1, workflow_runs: [own] } }).request), baseline);
  for (const invalid of [
    { total_count: 1, workflow_runs: [{ ...own, run_attempt: 2 }] },
    { total_count: 1, workflow_runs: [{ ...own, id: 301 }] },
    { total_count: 2, workflow_runs: [own] },
    { total_count: 100, workflow_runs: [] },
  ]) await assert.rejects(() => inspectPreparationBarriers(value.baselineControl.record, value.execution,
    fakeGithub(value, { [runsPath]: invalid }).request));
  for (const [path, mutate] of [
    [`repos/${preparationRepairRepository}/actions/workflows/runtime-release.yml`, item => { item.state = 'active'; }],
    [`repos/${preparationRepairRepository}/environments/production`, item => { item.can_admins_bypass = true; }],
    [`repos/${preparationRepairRepository}/environments/production/deployment-branch-policies?per_page=100`, item => { item.branch_policies[0].name = 'master'; }],
    ['repos/ponta2git/momo-db/branches/maintenance-control/protection', item => { item.allow_force_pushes.enabled = true; }],
  ]) {
    const changed = await fixture.request(path); mutate(changed);
    await assert.rejects(() => inspectPreparationBarriers(value.baselineControl.record, value.execution, fakeGithub(value, { [path]: changed }).request));
  }
});

test('guard performs all remote lookups before the final mutable control read', async () => {
  const value = receipt(); const fixture = fakeGithub(value);
  value.baseline.barrierDigest = await inspectPreparationBarriers(value.baselineControl.record, value.execution, fixture.request);
  const current = granted(value); const events = [];
  const request = async path => { events.push('remote'); return fixture.request(path); };
  const store = { read: async () => { events.push('control'); return current; } };
  const result = await guardPreparationExecution(store, value, grantHead, evidence(value), 'registry-push', context(value), request, now);
  assert.equal(result.receiptDigest, digest(value));
  assert.equal(events.at(-1), 'control');
  assert.equal(events.filter(event => event === 'control').length, 1);
  await assert.rejects(() => guardPreparationExecution({ read: async () => ({ ...current, head: 'd'.repeat(40) }) }, value, grantHead,
    evidence(value), 'registry-push', context(value), request, now), code('PREPARATION_REPAIR_GRANT_HEAD_CHANGED'));
});
