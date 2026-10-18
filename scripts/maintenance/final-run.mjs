#!/usr/bin/env node
import { access, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expectedMigrationHistory } from '../check-migration-history.mjs';
import { createWorkspace, loadKey, privateFile, readJson, writeJson, withRunLock, fileDigest, RehearsalError } from '../migration/files.mjs';
import { databaseLocation } from '../migration/database.mjs';
import { command } from '../migration/process.mjs';
import { runAction } from '../migration/run.mjs';
import { ControlError, digest, canonicalJson } from './control.mjs';
import { check } from './freeze-contract.mjs';
import { createStore } from './github-store.mjs';
import { verifyDeploymentFreeze } from './github-evidence.mjs';
import { createFlyProvider } from './fly-provider.mjs';
import { readConvergence } from './freeze-database.mjs';
import { verifyFrozen } from './freeze.mjs';
import { captureDatabase } from './apply-database.mjs';
import { certifyFinalRehearsal, frozenBinding, receiptInput } from './final-rehearsal.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const absent = async path => {
  try { await access(path); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
};
const privateInput = async path => {
  check(isAbsolute(path ?? ''), 'ABSOLUTE_PRIVATE_INPUT_REQUIRED');
  await privateFile(path);
  const bytes = await readFile(path);
  check(bytes.length <= 65536, 'FINAL_INPUT_TOO_LARGE');
  return JSON.parse(bytes.toString('utf8'));
};

export async function main(args) {
  const [action, ...rest] = args;
  const additional = { prepare: ['--freeze-run', '--postgres-image', '--profile'], seal: ['--acceptance'],
    receipt: ['--input', '--output'] }[action] ?? [];
  check(['prepare', 'snapshot', 'restore', 'rehearse', 'verify', 'recover-rehearsal', 'seal', 'receipt', 'status', 'cleanup'].includes(action) &&
    rest.length % 2 === 0, 'INVALID_FINAL_REHEARSAL_COMMAND');
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    check(['--run', '--key', ...additional].includes(name) && !(name in options), 'INVALID_FINAL_REHEARSAL_ARGUMENT');
    options[name] = rest[index + 1];
  }
  check(isAbsolute(options['--run'] ?? '') && isAbsolute(options['--key'] ?? ''), 'ABSOLUTE_RUN_AND_KEY_REQUIRED');
  const directory = resolve(options['--run']);
  const key = await loadKey(options['--key']);
  const rehearsal = resolve(directory, 'rehearsal');
  const manifestPath = resolve(rehearsal, 'manifest.json.enc');
  const bindingPath = resolve(directory, 'binding.json.enc');
  const proofPath = resolve(directory, 'final-proof.json.enc');
  if (action === 'prepare') {
    check(isAbsolute(options['--freeze-run'] ?? ''), 'ABSOLUTE_FREEZE_RUN_REQUIRED');
    await createWorkspace(directory, repository);
  }
  return withRunLock(directory, async () => {
    if (action === 'status') {
      const manifest = await readJson(manifestPath, key);
      const proof = await absent(proofPath) ? null : await readJson(proofPath, key);
      console.log(JSON.stringify({ state: manifest.state, runId: manifest.runId,
        cutoverId: manifest.finalFreeze.cutoverId, stopEpoch: manifest.finalFreeze.stopEpoch,
        finalRehearsalDigest: proof ? digest(proof) : null }));
      return;
    }
    const store = createStore();
    if (action === 'receipt') {
      check(isAbsolute(options['--output'] ?? ''), 'ABSOLUTE_RECEIPT_OUTPUT_REQUIRED');
      const proof = await readJson(proofPath, key);
      const input = await privateInput(options['--input']);
      const receipt = receiptInput(proof, (await store.read()).record, input);
      await writeFile(options['--output'], canonicalJson(receipt) + '\n', { mode: 0o600, flag: 'wx' });
      console.log(JSON.stringify({ status: 'receipt-input-created', operation: receipt.operation, finalRehearsalDigest: digest(proof) }));
      return;
    }
    if (action === 'cleanup') {
      await withRunLock(rehearsal, async () => {
        const manifest = await readJson(manifestPath, key);
        const save = () => writeJson(manifestPath, manifest, key);
        await runAction('cleanup', manifest, rehearsal, key, save);
        await save();
      });
      console.log('OWNED_FINAL_REHEARSAL_RESOURCES_REMOVED'); return;
    }
    check(await absent(proofPath), 'FINAL_PROOF_ALREADY_SAVED_INSPECT_CONTROL_BEFORE_RETRY');
    const binding = action === 'prepare' ? { freezeRun: resolve(options['--freeze-run']) } : await readJson(bindingPath, key);
    await withRunLock(binding.freezeRun, async () => {
      const plan = await readJson(resolve(binding.freezeRun, 'plan.json.enc'), key);
      const state = await readJson(resolve(binding.freezeRun, 'state.json.enc'), key);
      const { url } = await readJson(resolve(binding.freezeRun, 'source.json.enc'), key);
      check(['frozen', 'finalizing'].includes(state.status) && state.proof, 'COMPLETED_FREEZE_PROOF_REQUIRED');
      const freezeDependencies = { store, provider: await createFlyProvider(), verifyDeployment: verifyDeploymentFreeze,
        inspectDatabase: () => readConvergence(url) };
      const verifyFreeze = () => verifyFrozen(plan, state.proof, freezeDependencies);
      const finalFreeze = frozenBinding(plan, state.proof, databaseLocation(url).identity);
      const freezeGuard = async () => { await verifyFreeze(); return finalFreeze; };
      await freezeGuard();
      if (action === 'prepare') {
        await writeJson(resolve(directory, 'source.json.enc'), { sourceUrl: url }, key);
        await command(process.execPath, [resolve(repository, 'scripts/migration/run.mjs'), 'prepare', '--run-dir', rehearsal,
          '--key-file', options['--key'], '--source-config', resolve(directory, 'source.json.enc'),
          ...(options['--postgres-image'] ? ['--postgres-image', options['--postgres-image']] : []),
          ...(options['--profile'] ? ['--profile', options['--profile']] : [])], { cwd: repository, failureCode: 'FINAL_REHEARSAL_PREPARE_FAILED' });
        const manifest = await readJson(manifestPath, key);
        check(manifest.state === 'prepared' && manifest.candidate.sha === plan.candidates.db, 'FINAL_CANDIDATE_CHANGED');
        manifest.finalFreeze = finalFreeze;
        await freezeGuard();
        await writeJson(manifestPath, manifest, key);
        await writeJson(bindingPath, binding, key);
        console.log(JSON.stringify({ status: 'prepared', runId: manifest.runId, cutoverId: plan.cutoverId, stopEpoch: plan.stopEpoch }));
        return;
      }
      await withRunLock(rehearsal, async () => {
        const manifest = await readJson(manifestPath, key);
        if (action === 'seal') {
          check(isAbsolute(options['--acceptance'] ?? ''), 'ABSOLUTE_ACCEPTANCE_REPORT_REQUIRED');
          check(await command('git', ['status', '--porcelain'], { cwd: repository }) === '' &&
            await command('git', ['rev-parse', 'HEAD'], { cwd: repository }) === manifest.candidate.sha, 'FINAL_CANDIDATE_CHANGED');
          const reports = {};
          for (const [name, file] of Object.entries({ source: 'source', baseline: 'baseline', first: 'migrated-first',
            migrated: 'migrated', recovered: 'recovered' })) reports[name] = await readJson(resolve(rehearsal, `${file}.json.enc`), key);
          const proof = await certifyFinalRehearsal({ manifest, ...reports, plan, freezeProof: state.proof,
            acceptance: await readJson(options['--acceptance'], key), archiveDigest: await fileDigest(resolve(rehearsal, 'source.dump.enc')),
            expected: expectedMigrationHistory(resolve(repository, 'drizzle')) }, {
            store, verifyFreeze, captureSource: () => captureDatabase(url), save: proof => writeJson(proofPath, proof, key),
          });
          console.log(JSON.stringify({ status: 'verified', finalRehearsalDigest: digest(proof) }));
          return;
        }
        const controller = new AbortController();
        const interrupt = () => controller.abort();
        const save = () => writeJson(manifestPath, manifest, key);
        const started = performance.now();
        process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
        try {
          await runAction(action, manifest, rehearsal, key, save, { signal: controller.signal, freezeGuard });
          await freezeGuard();
          manifest.durationsMs[action] = Math.round(performance.now() - started);
          await save();
        } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
        console.log(JSON.stringify({ status: manifest.state, runId: manifest.runId }));
      });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof ControlError || error instanceof RehearsalError ? error.code : 'FINAL_REHEARSAL_FAILED_PRIVATE_DETAILS_WITHHELD');
    process.exitCode = 1;
  }
}
