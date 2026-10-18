import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKey, loadKey, readJson } from '../scripts/migration/files.mjs';
import { ControlError, digest, initialControl, transition } from '../scripts/maintenance/control.mjs';
import { assertDrain, assertFrozenReadiness, assertStagedBootConfiguration, externalWriterChecks, modeKey, validateExternalEvidence } from '../scripts/maintenance/freeze-contract.mjs';
import { convergenceQueries, isConverged } from '../scripts/maintenance/freeze-database.mjs';
import { prepareFreeze, executeFreeze, verifyFrozen } from '../scripts/maintenance/freeze.mjs';
import { createFlyProvider, processCommand } from '../scripts/maintenance/fly-provider.mjs';

const database = { formatVersion: 1, targetFingerprint: 'd'.repeat(64), ledgerFingerprint: 'e'.repeat(64) };
const candidates = { db: 'a'.repeat(40), summit: 'b'.repeat(40), result: 'c'.repeat(40) };
const names = {
  api: { http_admission: 'admission', http_continuations_and_runtime: 'all' },
  worker: { scheduler_and_attempts: 'admission', runtime_and_notifications: 'all' },
  summit: { startup: 'admission', discord_interactions: 'admission', reconnect_recovery: 'admission', scheduler: 'admission',
    ask_sends: 'admission', notification_operations: 'admission', result_notifications: 'all' },
};
function receipt(role, request = null, mode = 'normal') {
  return { consumer: { api: 'momo-result-api', worker: 'momo-processing-worker', summit: 'summit' }[role], scope: 'process',
    cutoverId: request?.cutoverId ?? null, stopEpoch: request?.stopEpoch ?? null, stage: request?.stage ?? null,
    phase: request ? 'drained' : 'running',
    writers: Object.entries(names[role]).map(([name, stage]) => ({ name, stage,
      status: request && (request.stage === 'all' || stage === 'admission') ? 'drained' : 'active' })),
    ...(role === 'api' ? { inFlight: { requests: 0, continuations: 0 } } :
      role === 'worker' ? { mode, processId: 17, inFlight: { operations: 0, attempts: 0, reconciliations: 0 } } : {}) };
}
function readiness(role) {
  return role === 'api' ? { event: 'runtime_maintenance_readiness', schemaVersion: 1, status: 'ok', database,
    checks: ['frozen_readiness', 'normal_routes_closed', 'database_contract', 'runtime_processes'] } :
    role === 'worker' ? { event: 'worker_maintenance_readiness', schemaVersion: 1, status: 'ready', mode: 'frozen', database } :
    { service: 'summit', mode: 'frozen', ready: true, contract: 'summit-read-schema-v1', database };
}
function fixture() {
  let now = Date.parse('2026-10-18T00:00:00.000Z');
  const deployment = { fixture: 'verified-github-barrier' };
  let record = initialControl('operator', new Date(now).toISOString());
  record = transition(record, record.stateVersion, 'begin', { cutoverId: 'fixture' }, new Date(now).toISOString());
  const identity = { cutoverId: 'fixture', stopEpoch: 1 };
  record = transition(record, record.stateVersion, 'pin', { ...identity, candidates }, new Date(now).toISOString());
  record = transition(record, record.stateVersion, 'advance', { ...identity, phase: 'DRAINING', evidenceDigest: digest(deployment) }, new Date(now).toISOString());
  const machines = {}; const secrets = {}; const receipts = {}; const operations = []; const journal = [];
  const targets = ['api', 'worker', 'summit'].map((role, index) => {
    const app = `fixture-${role}`; const id = String(index + 1).repeat(14); const image = `fixture/${role}@sha256:${'f'.repeat(64)}`;
    const config = { image, env: { FIXTURE: role }, restart: { policy: 'on-failure' } };
    machines[app] = { id, instance: `version${index}`, config, image, events: [{ type: 'start', timestamp: 1 }], bootId: `boot-${index}` };
    secrets[app] = [{ name: 'DATABASE_URL', digest: 'original', status: 'Deployed' }];
    receipts[app] = receipt(role);
    return { role, app, id, image, configDigest: digest(config) };
  });
  const externalEvidence = { formatVersion: 1, operator: record.operator, ...identity, candidates,
    deploymentFreezeDigest: digest(deployment), observedAt: new Date(now).toISOString(), validUntil: new Date(now + 7200000).toISOString(),
    checks: externalWriterChecks.map(kind => ({ kind, evidenceDigest: digest(kind) })) };
  const input = { formatVersion: 1, targets, database, externalEvidence, approvals: [],
    deadline: new Date(now + 3600000).toISOString(), recoveryReserveMs: 600000 };
  const settled = () => ({ database, pending: Object.fromEntries(Object.keys(convergenceQueries).map(name => [name, '0'])),
    activeTransactions: '0', preparedTransactions: '0', retainedPendingAttendance: '2' });
  const dependencies = {
    now: () => now, pause: async () => { now += 1000; },
    store: {
      read: async () => ({ head: digest(record).slice(0, 40), record: structuredClone(record), digest: digest(record) }),
      compareAndSwap: async (previous, next) => {
        assert.equal(previous.digest, digest(record)); record = next;
        return { head: digest(record).slice(0, 40), record, digest: digest(record) };
      },
    },
    verifyDeployment: async () => deployment,
    inspectDatabase: async () => settled(),
    save: async state => { journal.push(structuredClone(state)); },
    provider: {
      list: async app => [{ id: machines[app].id }],
      inspect: async target => structuredClone(machines[target.app]),
      secrets: async app => structuredClone(secrets[app]),
      stage: async (target, guard) => {
        await guard(); operations.push(`stage:${target.role}`);
        secrets[target.app].push({ name: modeKey, digest: 'frozen-version', status: 'Staged' });
      },
      process: async (target, action, request) => {
        if (action === 'readiness') return readiness(target.role);
        if (action === 'drain') {
          operations.push(`drain:${target.role}:${request.stage}`);
          receipts[target.app] = receipt(target.role, request);
        }
        return structuredClone(receipts[target.app]);
      },
      freeze: async (target, original, guard) => {
        await guard(); operations.push(`freeze:${target.role}`);
        assert.deepEqual(machines[target.app], original);
        const updated = { instance: original.instance + 'frozen', image: original.image,
          config: { ...original.config, image: original.image, env: { ...original.config.env, [modeKey]: 'frozen' } } };
        machines[target.app] = { ...original, ...updated, bootId: original.bootId + '-new', events: [{ type: 'start', timestamp: 2 }] };
        receipts[target.app] = receipt(target.role, null, 'frozen');
        return updated;
      },
    },
  };
  return { input, dependencies, machines, secrets, receipts, operations, journal, settled, deployment,
    record: () => record, setRecord: value => { record = value; }, elapse: ms => { now += ms; } };
}

test('stages every next boot before drain, converges users before stopping workers, and freezes the receiver last', async () => {
  const f = fixture();
  const plan = await prepareFreeze(f.input, f.dependencies);
  const proof = await executeFreeze(plan, f.dependencies);
  assert.deepEqual(f.operations, ['stage:api', 'stage:worker', 'stage:summit', 'drain:api:admission', 'drain:summit:admission',
    'drain:worker:admission', 'drain:api:all', 'drain:worker:all', 'drain:summit:all', 'freeze:api', 'freeze:worker', 'freeze:summit']);
  assert.equal(f.record().cutover.phase, 'FROZEN');
  assert.equal(f.record().cutover.evidence.writersStopped, digest(proof));
  assert.equal(proof.convergence.retainedPendingAttendance, '2');
  assert.ok(f.journal.some(item => item.status === 'mutation-started'));
  assert.equal(f.journal.at(-1).status, 'frozen');
  assert.deepEqual(await verifyFrozen(plan, proof, f.dependencies), { writersStoppedDigest: digest(proof), database });
});

test('unresolved admission and notification work prevents worker admission stop and respects recovery reserve', async () => {
  const f = fixture(); const plan = await prepareFreeze(f.input, f.dependencies);
  f.dependencies.inspectDatabase = async () => ({ ...f.settled(), pending: { ...f.settled().pending, ocrAdmissions: '1', resultNotifications: '1' } });
  f.dependencies.pause = async () => { f.elapse(3600000); };
  await assert.rejects(executeFreeze(plan, f.dependencies), { code: 'FREEZE_TIME_BUDGET_EXHAUSTED' });
  assert.equal(f.operations.includes('drain:worker:admission'), false);
  assert.equal(f.operations.some(item => item.startsWith('freeze:')), false);
  assert.equal(f.record().cutover.phase, 'INVALIDATED');
  assert.equal(f.record().epoch, 2);
  assert.equal(f.journal.at(-1).status, 'failed-inspect-before-retry');
  assert.ok(Object.values(f.secrets).every(items => items.some(item => item.name === modeKey)));
});

test('preparation rejects missing unprotected publisher evidence, extra machines and unrelated staged secrets', async () => {
  for (const scenario of ['publisher', 'machine', 'secret']) {
    const f = fixture();
    if (scenario === 'publisher') f.input.externalEvidence.checks = f.input.externalEvidence.checks.filter(item => !item.kind.includes('unprotected'));
    if (scenario === 'machine') f.dependencies.provider.list = async app => [{ id: f.machines[app].id }, { id: 'unknown' }];
    if (scenario === 'secret') f.secrets['fixture-api'][0].status = 'Staged';
    await assert.rejects(prepareFreeze(f.input, f.dependencies), { code: { publisher: 'EXTERNAL_WRITER_INVENTORY_INCOMPLETE',
      machine: 'PROVIDER_MACHINE_INVENTORY_CHANGED', secret: 'UNRELATED_STAGED_SECRETS_PRESENT' }[scenario] });
    assert.deepEqual(f.operations, []);
  }
});

test('a reboot, same-config new process, or changed credential after preparation cannot reuse a drain', async () => {
  for (const scenario of ['boot', 'process', 'secret']) {
    const f = fixture(); const plan = await prepareFreeze(f.input, f.dependencies);
    if (scenario === 'boot') f.machines['fixture-api'].bootId += '-changed';
    if (scenario === 'process') f.receipts['fixture-worker'] = receipt('worker', { cutoverId: 'other', stopEpoch: 7, stage: 'all' });
    if (scenario === 'secret') f.secrets['fixture-api'][0].digest = 'rotated';
    await assert.rejects(executeFreeze(plan, f.dependencies));
    assert.deepEqual(f.operations, []);
    assert.equal(f.record().cutover.phase, 'INVALIDATED');
  }
});

test('state changed during a slow provider lookup is rejected immediately before mutation', async () => {
  const f = fixture(); const plan = await prepareFreeze(f.input, f.dependencies);
  const original = f.dependencies.provider.inspect;
  let changed = false;
  f.dependencies.provider.inspect = async target => {
    const result = await original(target);
    if (!changed) {
      changed = true;
      const before = f.record();
      f.setRecord(transition(before, before.stateVersion, 'invalidate', { cutoverId: 'fixture', stopEpoch: 1, reason: 'writer-reopened' }));
    }
    return result;
  };
  await assert.rejects(executeFreeze(plan, f.dependencies), { code: 'FREEZE_CONTROL_CHANGED' });
  assert.deepEqual(f.operations, []);
});

test('partial frozen rollout records uncertainty and never changes any mode to normal', async () => {
  const f = fixture(); const plan = await prepareFreeze(f.input, f.dependencies);
  const original = f.dependencies.provider.freeze;
  f.dependencies.provider.freeze = async (...args) => {
    if (args[0].role === 'worker') throw new Error('private-provider-error');
    return original(...args);
  };
  await assert.rejects(executeFreeze(plan, f.dependencies), { code: 'FREEZE_EXECUTION_FAILED' });
  assert.equal(f.machines['fixture-api'].config.env[modeKey], 'frozen');
  assert.equal(f.record().cutover.phase, 'INVALIDATED');
  assert.equal(JSON.stringify(f.journal).includes('private-provider-error'), false);
  assert.equal(f.operations.includes('freeze:summit'), false);
});

test('frozen verification rejects changed boot, live database, and external evidence expiry', async () => {
  for (const scenario of ['boot', 'database', 'expiry']) {
    const f = fixture(); const plan = await prepareFreeze(f.input, f.dependencies);
    const proof = await executeFreeze(plan, f.dependencies);
    if (scenario === 'boot') f.machines['fixture-api'].bootId += '-restarted';
    if (scenario === 'database') f.dependencies.inspectDatabase = async () => ({ ...f.settled(), database: { ...database, ledgerFingerprint: 'f'.repeat(64) } });
    if (scenario === 'expiry') f.elapse(7200000);
    await assert.rejects(verifyFrozen(plan, proof, f.dependencies));
    assert.equal(f.record().cutover.phase, 'INVALIDATED');
  }
});

test('writer receipts require every writer, consistent phase, zero owned work and matching stop identity', () => {
  const request = { cutoverId: 'fixture', stopEpoch: 1, stage: 'all' };
  for (const mutate of [value => value.writers.pop(), value => { value.writers[0].status = 'timed_out'; },
    value => { value.inFlight.attempts = 1; }, value => { value.stopEpoch = 2; }, value => { value.phase = 'draining'; }]) {
    const value = receipt('worker', request); mutate(value);
    assert.throws(() => assertDrain('worker', value, request));
  }
  assert.throws(() => assertFrozenReadiness('api', { ...readiness('api'), database: { ...database, targetFingerprint: 'a'.repeat(64) } }, database));
  assert.throws(() => isConverged({ pending: { ocrAdmissions: '0' } }));
});

test('evidence expiry and changed candidates cannot be replaced with a bare success boolean', () => {
  const f = fixture();
  assert.throws(() => validateExternalEvidence({ success: true }, f.record(), f.deployment));
  assert.throws(() => validateExternalEvidence({ ...f.input.externalEvidence, candidates: { ...candidates, db: 'f'.repeat(40) } }, f.record(), f.deployment));
  assert.throws(() => validateExternalEvidence(f.input.externalEvidence, f.record(), f.deployment, Date.parse(f.input.externalEvidence.validUntil)));
});

test('provider pins full config and current version under its own lease and sanitizes failures', async () => {
  const machine = { id: '11111111111111', instance_id: 'initial', state: 'started',
    config: { image: 'mutable:tag', env: { FIXTURE: 'kept' }, guest: { cpus: 1 } },
    image_ref: { registry: 'fixture', repository: 'api', digest: `sha256:${'f'.repeat(64)}` }, events: [{ type: 'start' }] };
  const requests = [];
  let guardCalls = 0;
  const provider = await createFlyProvider({ token: 'fixture-token',
    run: async (_command, args) => {
      assert.equal(args[0], 'machine');
      return JSON.stringify({ stdout: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n' });
    },
    fetcher: async (url, options) => {
      requests.push({ url, ...options });
      if (options.method === 'DELETE') return new Response(null, { status: 204 });
      if (url.endsWith('/lease')) return Response.json({ data: { nonce: 'our-lease', version: 'initial' } });
      if (options.method === 'POST') {
        assert.equal(guardCalls, 1);
        const body = JSON.parse(options.body);
        assert.equal(body.current_version, 'initial');
        assert.equal(options.headers['fly-machine-lease-nonce'], 'our-lease');
        assert.deepEqual(body.config.guest, machine.config.guest);
        assert.equal(body.config.env[modeKey], 'frozen');
        return Response.json({ ...machine, instance_id: 'updated', config: body.config });
      }
      return Response.json(machine);
    } });
  const target = { app: 'fixture-app', id: machine.id };
  const original = await provider.inspect(target);
  const updated = await provider.freeze(target, original, async () => { guardCalls++; });
  assert.equal(updated.instance, 'updated');
  assert.ok(requests.every(item => item.url.startsWith('https://api.machines.dev/v1/')));
  assert.equal(requests.at(-1).method, 'DELETE');
  const failing = await createFlyProvider({ token: 'fixture-token', fetcher: async () => { throw new Error('secret-url'); } });
  await assert.rejects(failing.list('fixture-app'), error => error instanceof ControlError && error.message === 'PROVIDER_REQUEST_FAILED');
});

test('boot configurations cannot bypass the app-wide staged stop secret', () => {
  for (const config of [
    { ignore_app_secrets: true }, { secrets: [{ env_var: 'DATABASE_URL' }] }, { containers: [{ name: 'unreviewed' }] },
    { processes: [{ env: { [modeKey]: 'normal' } }] }, { processes: [{ ignore_app_secrets: true }] },
    { env_from: [{ env_var: modeKey, field_ref: 'app_name' }] },
  ]) assert.throws(() => assertStagedBootConfiguration(config), { code: 'APP_SECRET_BOOT_CONTRACT_REQUIRED' });
  assert.doesNotThrow(() => assertStagedBootConfiguration({ env: { [modeKey]: 'normal' }, processes: [{ cmd: ['worker'] }] }));
});

test('provider lease-version race never updates a machine and only releases its acquired lease', async () => {
  const methods = [];
  const provider = await createFlyProvider({ token: 'fixture-token', fetcher: async (_url, options) => {
    methods.push(options.method);
    return options.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({ data: { nonce: 'ours', version: 'other' } });
  } });
  await assert.rejects(provider.freeze({ app: 'fixture-app', id: '11111111111111' }, { instance: 'initial' }, async () => {}),
    { code: 'MACHINE_LEASE_VERSION_CHANGED' });
  assert.deepEqual(methods, ['POST', 'DELETE']);
  assert.throws(() => processCommand('api', 'drain', { cutoverId: '$(secret)', stopEpoch: 1, stage: 'all' }));
});

test('a killed operator keeps its encrypted mutation journal and a new CLI refuses to replay it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'momo-freeze-kill-'));
  const keyPath = join(directory, 'key');
  try {
    await createKey(keyPath);
    const helper = new URL('../scripts/migration/files.mjs', import.meta.url).href;
    const script = `import {loadKey,writeJson} from ${JSON.stringify(helper)};
      const key=await loadKey(process.argv[1]);
      await writeJson(process.argv[2],{status:'mutation-started',step:'stage-frozen-boot',privateValue:'must-not-print'},key);
      process.stdout.write('persisted'); setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, keyPath, join(directory, 'state.json.enc')],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr.resume();
    await once(child.stdout, 'data');
    const closed = once(child, 'close'); child.kill('SIGKILL');
    assert.deepEqual(await closed, [null, 'SIGKILL']);
    const state = await readJson(join(directory, 'state.json.enc'), await loadKey(keyPath));
    assert.equal(state.status, 'mutation-started');
    const cli = spawn(process.execPath, [fileURLToPath(new URL('../scripts/maintenance/freeze-run.mjs', import.meta.url)),
      'stop', '--run', directory, '--key', keyPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; cli.stdout.on('data', value => { output += value; }); cli.stderr.on('data', value => { output += value; });
    const result = await once(cli, 'close');
    assert.equal(result[0], 1);
    assert.equal(output.trim(), 'FREEZE_ALREADY_STARTED_INSPECT_BEFORE_RETRY');
    assert.deepEqual(await readJson(join(directory, 'state.json.enc'), await loadKey(keyPath)), state);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
