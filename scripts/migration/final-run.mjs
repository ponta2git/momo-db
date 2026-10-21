import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stat } from 'node:fs/promises';
import { candidate, main as rehearsalMain } from './run.mjs';
import { connect } from './database.mjs';
import { inspectFinalSource, machineInventory } from './cutover-apply.mjs';
import { configurationDigest } from './cutover-guard.mjs';
import { produceFinalEvidence, readFullRehearsal } from './final-evidence.mjs';
import { exerciseRehearsalChecks } from './final-rehearsal-checks.mjs';
import { prepareSource, sourceApproval, verifySourceEndpoint } from './source-preflight.mjs';
import { assertOwned, localUrl, withLocalConnection } from './local.mjs';
import { command, start } from './process.mjs';
import { createWorkspace, digest, encryptStream, fileDigest, loadKey, readJson,
  writeJson, requireCondition as check, RehearsalError } from './files.mjs';

const profile = 'canonical-identities-retired-slots-v1';
const repository = resolve(new URL('../..', import.meta.url).pathname);

async function runCommand(action, directory, keyFile, signal) {
  await command(process.execPath, ['scripts/migration/run.mjs', action,
    '--manifest', resolve(directory, 'manifest.json.enc'), '--key-file', keyFile],
  { cwd: repository, signal, failureCode: `FINAL_${action.toUpperCase().replaceAll('-', '_')}_FAILED` });
}

async function prepare(directory, configuration, keyFile, image) {
  // Keep the ordinary CLI's clean candidate, endpoint, image and ownership checks.
  await rehearsalMain(['prepare', '--run-dir', directory, '--source-config', configuration,
    '--key-file', keyFile, '--postgres-image', image, '--profile', profile]);
}

async function full(directory, key, keyFile, fixed, source, checkpoint, signal) {
  await runCommand('restore', directory, keyFile, signal);
  await runCommand('rehearse', directory, keyFile, signal);
  await runCommand('recover-rehearsal', directory, keyFile, signal);
  const result = await readFullRehearsal(directory, key, fixed.sha, source);
  await checkpoint();
  return result;
}

// A separate archive really is taken from the quiescent owned baseline. The
// online production snapshot is only an input; its acquisition time and scope
// are retained and can never become evidence of a stopped production database.
async function snapshotCopy(seed, directory, key, fixed, source, signal) {
  await assertOwned(seed);
  await createWorkspace(directory, repository);
  const archive = resolve(directory, 'source.dump.enc');
  const sql = connect(localUrl(seed, 'momo_rehearsal_baseline'));
  try {
    await sql.begin('isolation level repeatable read read only', async tx => {
      const [{ snapshot }] = await tx`SELECT pg_export_snapshot() AS snapshot`;
      check(/^[0-9A-Fa-f-]+$/.test(snapshot), 'INVALID_EXPORTED_SNAPSHOT');
      const running = start('docker', ['exec', '-i', seed.local.container, 'pg_dump',
        '--username=postgres', '--dbname=momo_rehearsal_baseline', '--format=custom', `--snapshot=${snapshot}`],
      { signal, failureCode: 'FROZEN_COPY_DUMP_FAILED' });
      running.child.stdin.end();
      try { await Promise.all([encryptStream(running.child.stdout, archive, key), running.completed]); }
      catch (error) { running.child.kill('SIGKILL'); await running.completed.catch(() => {}); throw error; }
    });
  } finally { await sql.end(); }
  const manifest = { formatVersion: 1, runId: randomUUID(), candidate: fixed, postgres: seed.postgres,
    profile, createdAt: new Date().toISOString(), state: 'snapshotted',
    source: { identity: source.locationIdentity }, local: null,
    checks: { sourceSnapshot: true }, durationsMs: {},
    incomplete: ['application-role-behavior', 'consumer-smoke-and-connection-switch', 'production-approval-and-cutover'],
    snapshot: { mode: 'online-consistent-snapshot', capturedAt: new Date().toISOString(),
      archiveDigest: await fileDigest(archive), auditDigest: digest(source), bytes: (await stat(archive)).size,
      tableCount: source.rows.tables.length, ledgerCount: source.connection.ledger.length,
      pendingDigest: digest(source.connection.pending) },
    snapshotOrigin: { kind: 'owned-frozen-copy', onlineCapturedAt: seed.snapshot.capturedAt,
      onlineArchiveDigest: seed.snapshot.archiveDigest, runId: seed.runId } };
  await writeJson(resolve(directory, 'source.json.enc'), source, key);
  await writeJson(resolve(directory, 'manifest.json.enc'), manifest, key);
}

// Stopped local sentinels exercise the continuous-stop ordering and restart
// detection. They are labelled simulation, never represented as real consumers.
// Real image business/stop/recovery gates remain P4's separate evidence.
async function createSentinels(seed) {
  const entries = [];
  try {
    for (const consumer of ['api', 'worker', 'summit']) {
      const id = await command('docker', ['create', '--network', 'none', '--restart=no',
        '--label', `io.momo.final.simulation=${seed.runId}`, '--entrypoint', 'sleep', seed.postgres.id, '600']);
      entries.push({ consumer, app: 'local-simulation', id });
      await command('docker', ['start', id]);
      await command('docker', ['stop', '--time', '1', id]);
    }
    return entries;
  } catch (error) { await removeSentinels(seed, entries); throw error; }
}
async function observeSentinels(seed, entries) {
  const result = [];
  for (const item of entries) {
    const [actual] = JSON.parse(await command('docker', ['inspect', item.id]));
    check(actual.Id === item.id && actual.Config.Labels?.['io.momo.final.simulation'] === seed.runId &&
      actual.Image === seed.postgres.id && actual.HostConfig.NetworkMode === 'none', 'SIMULATION_OWNERSHIP_CHANGED');
    result.push({ id: actual.Id, instance_id: actual.State.StartedAt,
      state: actual.State.Running ? 'started' : 'stopped',
      config: { restart: { policy: actual.HostConfig.RestartPolicy.Name }, services: [],
        image: actual.Image, network: actual.HostConfig.NetworkMode },
      eventsDigest: configurationDigest({ started: actual.State.StartedAt, finished: actual.State.FinishedAt,
        restarts: actual.RestartCount }) });
  }
  return result;
}
async function removeSentinels(seed, entries) {
  for (const item of entries) {
    const [actual] = JSON.parse(await command('docker', ['inspect', item.id]));
    check(actual.Config.Labels?.['io.momo.final.simulation'] === seed.runId && actual.Image === seed.postgres.id,
      'SIMULATION_OWNERSHIP_CHANGED');
    await command('docker', ['rm', '--force', item.id]);
  }
}

export async function main(args) {
  const options = {};
  const names = ['mode', 'run-dir', 'key-file', 'postgres-image', 'summit-ref', 'result-ref', 'reserve-minutes'];
  const allowed = [...names, 'snapshot-manifest'];
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]?.slice(2);
    check(args[index]?.startsWith('--') && allowed.includes(name) && !Object.hasOwn(options, name) && args[index + 1],
      'FINAL_RUN_ARGUMENTS_INVALID');
    options[name] = args[index + 1];
  }
  check(names.every(name => options[name]) && ['production', 'rehearsal'].includes(options.mode), 'FINAL_RUN_ARGUMENTS_REQUIRED');
  check(!options['snapshot-manifest'] || options.mode === 'rehearsal', 'SNAPSHOT_IMPORT_REHEARSAL_ONLY');
  const fixed = await candidate();
  const key = await loadKey(options['key-file']);
  check(['summit-ref', 'result-ref'].every(name => /^[a-f0-9]{40}$/.test(options[name])), 'FIXED_CONSUMER_REFS_REQUIRED');
  const reserve = Number(options['reserve-minutes']);
  check(Number.isInteger(reserve) && reserve > 0 && reserve < 120, 'RECOVERY_RESERVE_REQUIRED');
  const directory = await createWorkspace(options['run-dir'], repository);
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const url = process.env.DIRECT_URL;
  const approval = options['snapshot-manifest'] ? null : sourceApproval();
  const config = resolve(directory, 'source-config.json.enc');
  const seedDirectory = resolve(directory, 'online-input');
  const finalDirectory = resolve(directory, 'final');
  const producer = { runId: process.env.GITHUB_RUN_ID ?? null, attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    workflow: '.github/workflows/cutover-final-evidence.yml' };
  const shared = { candidate: fixed.sha, refs: { db: fixed.sha, summit: options['summit-ref'], result: options['result-ref'] },
    scope: options.mode, producer, recoveryReserveMs: reserve * 60 * 1000, signal: controller.signal,
    record: value => writeJson(resolve(directory, 'progress.json.enc'), { ...value, at: new Date().toISOString() }, key) };
  try {
    if (!options['snapshot-manifest']) await prepareSource({ url, approval, key, destination: config });
    let evidence;
    if (options.mode === 'production') {
      check(process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_REF === 'refs/heads/master' &&
        process.env.GITHUB_SHA === fixed.sha, 'FIXED_MASTER_PRODUCER_REQUIRED');
      const inventory = JSON.parse(process.env.CUTOVER_WRITER_INVENTORY_JSON ?? 'null');
      check(Array.isArray(inventory) && inventory.length === 3, 'APPROVED_WRITER_INVENTORY_REQUIRED');
      await prepare(finalDirectory, config, options['key-file'], options['postgres-image']);
      evidence = await produceFinalEvidence({ ...shared, inventory,
        observeMachines: () => machineInventory(inventory),
        inspectSource: async () => {
          await verifySourceEndpoint(url, approval);
          const sql = connect(url);
          try { return await inspectFinalSource(sql, url, repository); }
          finally { await sql.end(); }
        },
        runFullRehearsal: async ({ source, checkpoint }) => {
          await runCommand('snapshot', finalDirectory, options['key-file'], controller.signal);
          await checkpoint();
          return full(finalDirectory, key, options['key-file'], fixed, source, checkpoint, controller.signal);
        } });
    } else {
      if (options['snapshot-manifest']) {
        await rehearsalMain(['prepare', '--run-dir', seedDirectory,
          '--snapshot-manifest', options['snapshot-manifest'], '--key-file', options['key-file'],
          '--postgres-image', options['postgres-image'], '--profile', profile]);
      } else {
        await prepare(seedDirectory, config, options['key-file'], options['postgres-image']);
        await runCommand('snapshot', seedDirectory, options['key-file'], controller.signal);
      }
      await runCommand('restore', seedDirectory, options['key-file'], controller.signal);
      const seed = await readJson(resolve(seedDirectory, 'manifest.json.enc'), key);
      const inventory = await createSentinels(seed);
      try {
        // One relay lifetime gives every live observation the same DB identity.
        evidence = await withLocalConnection(seed, async () => {
          const local = localUrl(seed, 'momo_rehearsal_baseline');
          const observeMachines = () => observeSentinels(seed, inventory);
          const inspectSource = async () => {
              const sql = connect(local);
              try { return await inspectFinalSource(sql, local, repository); }
              finally { await sql.end(); }
            };
          const result = await produceFinalEvidence({ ...shared, inventory, observeMachines, inspectSource,
            runFullRehearsal: async ({ source, checkpoint }) => {
              await snapshotCopy(seed, finalDirectory, key, fixed, source, controller.signal);
              await checkpoint();
              return full(finalDirectory, key, options['key-file'], fixed, source, checkpoint, controller.signal);
            } });
          await exerciseRehearsalChecks({ seed, directory: finalDirectory, key, evidence: result,
            repository, observeMachines, inspectSource });
          return result;
        }, { signal: controller.signal });
      } finally { await removeSentinels(seed, inventory); }
    }
    await writeJson(resolve(directory, 'final-evidence.json.enc'), evidence, key);
    console.log(JSON.stringify({ scope: options.mode, candidate: fixed.sha, passed: true,
      evidenceSha256: await fileDigest(resolve(directory, 'final-evidence.json.enc')),
      durationMs: evidence.durationMs, remainingForRecoveryMs: 120 * 60 * 1000 - evidence.durationMs }));
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    // The archived reports remain usable; only this run's Docker resources are removed.
    for (const path of [finalDirectory, seedDirectory]) {
      if (await stat(resolve(path, 'manifest.json.enc')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) {
        await runCommand('cleanup', path, options['key-file']);
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof RehearsalError ? error.code : 'FINAL_RUN_FAILED_PRIVATE_DETAILS_WITHHELD');
    process.exitCode = 1;
  }
}
