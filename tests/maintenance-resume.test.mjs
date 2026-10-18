import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKey, loadKey, readJson, writeJson } from '../scripts/migration/files.mjs';
import { initialControl, transition, digest } from '../scripts/maintenance/control.mjs';
import { convergenceQueries } from '../scripts/maintenance/freeze-database.mjs';
import { externalWriterChecks, modeKey } from '../scripts/maintenance/freeze-contract.mjs';
import { prepareResume, executeResume, certifyStability, stabilityChecks } from '../scripts/maintenance/resume.mjs';

const database = { formatVersion: 1, targetFingerprint: 'd'.repeat(64), ledgerFingerprint: 'e'.repeat(64) };
const candidates = { db: 'a'.repeat(40), summit: 'b'.repeat(40), result: 'c'.repeat(40) };
const names = { api: { http_admission: 'admission', http_continuations_and_runtime: 'all' },
  worker: { scheduler_and_attempts: 'admission', runtime_and_notifications: 'all' },
  summit: { startup: 'admission', discord_interactions: 'admission', reconnect_recovery: 'admission', scheduler: 'admission',
    ask_sends: 'admission', notification_operations: 'admission', result_notifications: 'all' } };
function status(role, mode) {
  return { consumer: { api: 'momo-result-api', worker: 'momo-processing-worker', summit: 'summit' }[role], scope: 'process',
    phase: 'running', cutoverId: null, stopEpoch: null, stage: null,
    writers: Object.entries(names[role]).map(([name, stage]) => ({ name, stage, status: 'active' })),
    ...(role === 'worker' ? { mode, processId: 123 } : {}) };
}
function frozen(role) {
  return role === 'api' ? { event: 'runtime_maintenance_readiness', schemaVersion: 1, status: 'ok', database,
    checks: ['frozen_readiness', 'normal_routes_closed', 'database_contract', 'runtime_processes'] } :
    role === 'worker' ? { event: 'worker_maintenance_readiness', schemaVersion: 1, status: 'ready', mode: 'frozen', database } :
    { service: 'summit', mode: 'frozen', ready: true, contract: 'summit-read-schema-v1', database };
}
function fixture(recovery = false) {
  let now = Date.parse('2026-10-18T02:00:00.000Z');
  let record = initialControl('operator');
  record = transition(record, record.stateVersion, 'begin', { cutoverId: 'fixture' });
  let id = { cutoverId: 'fixture', stopEpoch: 1 };
  record = transition(record, record.stateVersion, 'pin', { ...id, candidates });
  const machines = {}; const secrets = {}; const operations = []; const journals = [];
  const targets = ['api', 'worker', 'summit'].map((role, index) => {
    const app = `fixture-${role}`; const machineId = String(index + 1).repeat(14); const image = `fixture/${role}@sha256:${'f'.repeat(64)}`;
    const config = { image, env: { [modeKey]: 'frozen', FIXTURE: role }, restart: { policy: 'on-failure' } };
    machines[app] = { id: machineId, instance: `version${index}`, config, image, events: [{ type: 'start', timestamp: 1 }], bootId: `boot-${index}` };
    secrets[app] = [{ name: 'DATABASE_URL', digest: 'original', status: 'Deployed' }, { name: modeKey, digest: 'frozen', status: 'Deployed' }];
    return { role, app, id: machineId, image, configDigest: digest(config) };
  });
  const readiness = { formatVersion: 1, targets, database, acceptanceDigest: digest('reviewed-application-acceptance') };
  if (recovery) {
    record = transition(record, record.stateVersion, 'recovery-ready', { ...id, recoveryEvidenceDigest: digest(readiness) });
    id = { ...id, stopEpoch: 2 };
  } else for (const phase of ['DRAINING', 'FROZEN', 'VERIFIED', 'DB_APPLIED', 'SUMMIT_STAGED', 'CONSUMERS_STAGED', 'READY_TO_RESUME']) {
    record = transition(record, record.stateVersion, 'advance', { ...id, phase,
      evidenceDigest: phase === 'READY_TO_RESUME' ? digest(readiness) : digest(phase) });
  }
  const opening = recovery ? 'RECOVERY_REOPENING' : 'REOPENING';
  const deployment = { fixture: 'verified-barrier', ...id };
  const input = { formatVersion: 1, readiness, approvals: [], deadline: new Date(now + 3600000).toISOString(), recoveryReserveMs: 600000,
    externalEvidence: { formatVersion: 1, operator: record.operator, ...id, candidates, deploymentFreezeDigest: digest(deployment),
      observedAt: new Date(now).toISOString(), validUntil: new Date(now + 7200000).toISOString(),
      checks: externalWriterChecks.map(kind => ({ kind, evidenceDigest: digest(kind) })) } };
  const settled = () => ({ database, pending: Object.fromEntries(Object.keys(convergenceQueries).map(name => [name, '0'])),
    activeTransactions: '0', preparedTransactions: '0', retainedPendingAttendance: '2' });
  const dependencies = { now: () => now, pause: async () => { now += 1000; },
    save: async value => { journals.push(structuredClone(value)); },
    store: { read: async () => ({ record: structuredClone(record), digest: digest(record) }),
      compareAndSwap: async (previous, next) => {
        assert.equal(previous.digest, digest(record)); operations.push(`control:${next.cutover.phase}`); record = next;
      } },
    inspectDatabase: async () => settled(), inspectConnection: async () => database, verifyDeployment: async () => deployment,
    provider: { list: async app => [{ id: machines[app].id }], inspect: async target => structuredClone(machines[target.app]),
      secrets: async app => structuredClone(secrets[app]),
      process: async (target, action) => action === 'readiness' ? frozen(target.role) : status(target.role, machines[target.app].config.env[modeKey]),
      stage: async (target, guard, mode) => {
        await guard(); assert.equal(record.cutover.phase, opening); assert.equal(mode, 'normal');
        operations.push(`stage:${target.role}`);
        secrets[target.app][1] = { name: modeKey, digest: 'normal', status: 'Staged' };
      },
      reopen: async (target, original, guard) => {
        await guard(); assert.equal(record.cutover.phase, opening); assert.deepEqual(original, machines[target.app]);
        operations.push(`reopen:${target.role}`);
        const updated = { instance: `${original.instance}-normal`, config: { ...original.config, env: { ...original.config.env, [modeKey]: 'normal' } }, image: original.image };
        machines[target.app] = { ...original, ...updated, bootId: `${original.bootId}-normal`, events: [{ type: 'start', timestamp: 2 }] };
        secrets[target.app][1].status = 'Deployed'; return updated;
      } } };
  const acceptance = proof => ({ formatVersion: 1, operator: record.operator, ...id, resumeProofDigest: digest(proof), incomplete: [],
    observedAt: new Date(now).toISOString(), validUntil: new Date(now + 600000).toISOString(),
    checks: stabilityChecks.map(kind => ({ kind, outcome: 'passed', reportDigest: digest(kind) })) });
  return { input, dependencies, machines, secrets, operations, journals, settled, acceptance, record: () => record,
    changeRecord: value => { record = value; }, elapse: value => { now += value; } };
}

test('records reopening before staging any normal boot, starts receiver first and requires separate stability acceptance', async () => {
  const f = fixture(); const plan = await prepareResume(f.input, f.dependencies); const proof = await executeResume(plan, f.dependencies);
  assert.deepEqual(f.operations, ['control:REOPENING', 'stage:api', 'stage:worker', 'stage:summit', 'reopen:summit', 'reopen:worker', 'reopen:api']);
  assert.equal(f.record().cutover.phase, 'REOPENING');
  assert.equal(f.journals.at(-1).status, 'opened-awaiting-stability');
  assert.equal(f.record().cutover.evidence.reopenBoundary, digest(proof.boundary));
  const result = await certifyStability(plan, proof, f.acceptance(proof), f.dependencies);
  assert.equal(f.record().cutover.phase, 'RESUMED');
  assert.equal(f.record().cutover.evidence.stability, digest(result));
});

test('restored old consumers use the new recovery epoch and never pretend the new DB/deploy succeeded', async () => {
  const f = fixture(true); const plan = await prepareResume(f.input, f.dependencies); const proof = await executeResume(plan, f.dependencies);
  assert.equal(plan.stopEpoch, 2); assert.equal(f.record().cutover.phase, 'RECOVERY_REOPENING');
  await certifyStability(plan, proof, f.acceptance(proof), f.dependencies);
  assert.equal(f.record().cutover.phase, 'RECOVERY_RESUMED');
  assert.equal(f.record().cutover.evidence.databaseApplied, undefined);
});

test('changed frozen release, secret, boot, unresolved work or other DB prevents the first normal boot', async () => {
  for (const scenario of ['boot', 'secret', 'config', 'work', 'database', 'deadline']) {
    const f = fixture(); const plan = await prepareResume(f.input, f.dependencies);
    if (scenario === 'boot') f.machines['fixture-api'].bootId += '-other';
    if (scenario === 'secret') f.secrets['fixture-worker'][0].digest = 'other';
    if (scenario === 'config') f.machines['fixture-summit'].config.env.FIXTURE = 'changed';
    if (scenario === 'work') f.dependencies.inspectDatabase = async () => ({ ...f.settled(), activeTransactions: '1' });
    if (scenario === 'database') f.dependencies.inspectConnection = async () => ({ ...database, targetFingerprint: 'f'.repeat(64) });
    if (scenario === 'deadline') f.elapse(3600000);
    await assert.rejects(executeResume(plan, f.dependencies)); assert.deepEqual(f.operations, []);
    assert.equal(f.record().cutover.phase, 'READY_TO_RESUME');
  }
});

test('a partial reopen retains the write boundary, journals uncertainty and cannot take the old-backup recovery path', async () => {
  const f = fixture(); const plan = await prepareResume(f.input, f.dependencies);
  const reopen = f.dependencies.provider.reopen;
  f.dependencies.provider.reopen = async (...args) => { if (args[0].role === 'worker') throw new Error('private-provider-failure'); return reopen(...args); };
  await assert.rejects(executeResume(plan, f.dependencies), { code: 'RESUME_EXECUTION_FAILED' });
  assert.equal(f.record().cutover.phase, 'REOPENING');
  assert.equal(f.machines['fixture-summit'].config.env[modeKey], 'normal');
  assert.equal(f.machines['fixture-api'].config.env[modeKey], 'frozen');
  assert.equal(f.journals.at(-1).boundaryMayBeRecorded, true);
  assert.equal(JSON.stringify(f.journals).includes('private-provider-failure'), false);
  assert.throws(() => transition(f.record(), f.record().stateVersion, 'recovery-ready', {
    cutoverId: plan.cutoverId, stopEpoch: plan.stopEpoch, recoveryEvidenceDigest: digest('old-backup'),
  }), { code: 'REOPENED_CUTOVER_REQUIRES_FORWARD_FIX' });
});

test('lost boundary CAS response never triggers a provider mutation or automatic undo', async () => {
  const f = fixture(); const plan = await prepareResume(f.input, f.dependencies);
  const cas = f.dependencies.store.compareAndSwap;
  f.dependencies.store.compareAndSwap = async (...args) => { await cas(...args); throw new Error('lost-response'); };
  await assert.rejects(executeResume(plan, f.dependencies), { code: 'RESUME_EXECUTION_FAILED' });
  assert.deepEqual(f.operations, ['control:REOPENING']);
  assert.equal(f.journals.at(-1).boundaryMayBeRecorded, true);
});

test('stability cannot reuse an older report, missing gate, failed check, or a changed running process', async () => {
  const f = fixture(); const plan = await prepareResume(f.input, f.dependencies); const proof = await executeResume(plan, f.dependencies);
  for (const mutate of [a => { a.stopEpoch++; }, a => { a.resumeProofDigest = digest('old'); },
    a => { a.incomplete = ['notifications']; }, a => { a.checks.pop(); }, a => { a.checks[0].outcome = 'failed'; },
    a => { a.validUntil = '2020-01-01T00:00:00Z'; }]) {
    const acceptance = f.acceptance(proof); mutate(acceptance);
    await assert.rejects(certifyStability(plan, proof, acceptance, f.dependencies), { code: 'STABILITY_ACCEPTANCE_INCOMPLETE' });
    assert.equal(f.record().cutover.phase, 'REOPENING');
  }
  f.machines['fixture-api'].bootId += '-restarted';
  await assert.rejects(certifyStability(plan, proof, f.acceptance(proof), f.dependencies), { code: 'RESUME_MACHINE_CHANGED' });
  assert.equal(f.record().cutover.phase, 'REOPENING');
});

test('a new CLI refuses persisted reopen and stability attempts before provider or credential lookup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'momo-resume-replay-'));
  const keyPath = join(directory, 'key');
  try {
    await createKey(keyPath); const key = await loadKey(keyPath);
    for (const [action, file, code] of [
      ['reopen', 'state.json.enc', 'RESUME_ALREADY_STARTED_INSPECT_BEFORE_RETRY'],
      ['stable', 'stability.json.enc', 'STABILITY_ALREADY_SAVED_INSPECT_CONTROL_BEFORE_RETRY'],
    ]) {
      const saved = { status: 'mutation-started', step: 'record-reopening', privateValue: 'must-not-print' };
      await writeJson(join(directory, file), saved, key);
      const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/maintenance/resume-run.mjs', import.meta.url)),
        action, '--run', directory, '--key', keyPath],
      { env: { PATH: '/nonexistent', FLY_API_TOKEN: 'fixture-token' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { output += value; });
      const result = await once(child, 'close');
      assert.equal(result[0], 1); assert.equal(output.trim(), code);
      assert.deepEqual(await readJson(join(directory, file), key), saved);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
