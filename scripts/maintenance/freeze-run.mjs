#!/usr/bin/env node
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createKey, createWorkspace, loadKey, privateFile, readJson, writeJson, withRunLock, RehearsalError } from '../migration/files.mjs';
import { ControlError, digest } from './control.mjs';
import { check } from './freeze-contract.mjs';
import { createStore } from './github-store.mjs';
import { verifyDeploymentFreeze } from './github-evidence.mjs';
import { createFlyProvider } from './fly-provider.mjs';
import { readConvergence } from './freeze-database.mjs';
import { executeFreeze, prepareFreeze, verifyFrozen } from './freeze.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const privateText = async path => {
  check(typeof path === 'string', 'PRIVATE_INPUT_FILE_REQUIRED');
  await privateFile(path);
  const bytes = await readFile(path);
  check(bytes.length <= 1024 * 1024, 'PRIVATE_INPUT_TOO_LARGE');
  return bytes.toString('utf8');
};
const missing = async path => {
  try { await access(path); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
};
export async function main(args) {
  const [action, ...rest] = args;
  if (action === 'create-key') {
    check(rest.length === 1, 'ABSOLUTE_KEY_PATH_REQUIRED');
    await createKey(rest[0]); console.log('PRIVATE_FREEZE_KEY_CREATED'); return;
  }
  check(['prepare', 'stop', 'status', 'verify'].includes(action) && rest.length % 2 === 0, 'INVALID_FREEZE_COMMAND');
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    check(['--run', '--key', '--input', '--source-url-file'].includes(name) && !(name in options), 'INVALID_FREEZE_ARGUMENT');
    options[name] = rest[index + 1];
  }
  check(options['--run']?.startsWith('/') && options['--key']?.startsWith('/'), 'ABSOLUTE_RUN_AND_KEY_REQUIRED');
  check(action === 'prepare' ? Object.keys(options).length === 4 : Object.keys(options).length === 2, 'INVALID_FREEZE_ARGUMENT');
  const directory = resolve(options['--run']);
  const key = await loadKey(options['--key']);
  const planPath = resolve(directory, 'plan.json.enc');
  const statePath = resolve(directory, 'state.json.enc');
  const sourcePath = resolve(directory, 'source.json.enc');
  if (action === 'prepare') await createWorkspace(directory, repository);
  return withRunLock(directory, async () => {
    if (action === 'status') {
      const plan = await readJson(planPath, key);
      const state = await missing(statePath) ? null : await readJson(statePath, key);
      console.log(JSON.stringify({ status: state?.status ?? 'prepared', step: state?.step ?? null,
        cutoverId: plan.cutoverId, stopEpoch: plan.stopEpoch, planDigest: digest(plan) }));
      return;
    }
    if (action === 'stop') check(await missing(statePath), 'FREEZE_ALREADY_STARTED_INSPECT_BEFORE_RETRY');
    const url = action === 'prepare' ? (await privateText(options['--source-url-file'])).trim() : (await readJson(sourcePath, key)).url;
    const dependencies = { store: createStore(), provider: await createFlyProvider(), verifyDeployment: verifyDeploymentFreeze,
      inspectDatabase: () => readConvergence(url), save: state => writeJson(statePath, state, key) };
    if (action === 'prepare') {
      const input = JSON.parse(await privateText(options['--input']));
      const plan = await prepareFreeze(input, dependencies);
      await writeJson(sourcePath, { url }, key);
      await writeJson(planPath, plan, key);
      console.log(JSON.stringify({ status: 'prepared', cutoverId: plan.cutoverId, stopEpoch: plan.stopEpoch, planDigest: digest(plan) }));
    } else {
      const plan = await readJson(planPath, key);
      if (action === 'stop') {
        const proof = await executeFreeze(plan, dependencies);
        console.log(JSON.stringify({ status: 'frozen', cutoverId: plan.cutoverId, stopEpoch: plan.stopEpoch, writersStoppedDigest: digest(proof) }));
      } else {
        const state = await readJson(statePath, key);
        check(['frozen', 'finalizing'].includes(state.status) && state.proof, 'COMPLETED_FREEZE_PROOF_REQUIRED');
        console.log(JSON.stringify({ status: 'verified-frozen', ...await verifyFrozen(plan, state.proof, dependencies) }));
      }
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof ControlError || error instanceof RehearsalError ? error.code : 'MAINTENANCE_FREEZE_FAILED');
    process.exitCode = 1;
  }
}
