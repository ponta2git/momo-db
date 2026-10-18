#!/usr/bin/env node
import { access, readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createWorkspace, loadKey, privateFile, readJson, writeJson, withRunLock, RehearsalError } from '../migration/files.mjs';
import { connect } from '../migration/database.mjs';
import { ControlError, digest } from './control.mjs';
import { check } from './freeze-contract.mjs';
import { createStore } from './github-store.mjs';
import { verifyDeploymentFreeze } from './github-evidence.mjs';
import { createFlyProvider } from './fly-provider.mjs';
import { readConvergence } from './freeze-database.mjs';
import { inspectConnectionProof } from './connection-proof.mjs';
import { prepareResume, executeResume, certifyStability } from './resume.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const absent = async path => {
  try { await access(path); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
};
const privateText = async path => {
  check(isAbsolute(path ?? ''), 'ABSOLUTE_PRIVATE_INPUT_REQUIRED'); await privateFile(path);
  const bytes = await readFile(path); check(bytes.length <= 1024 * 1024, 'PRIVATE_INPUT_TOO_LARGE'); return bytes.toString('utf8');
};

export async function main(args) {
  const [action, ...rest] = args;
  check(['prepare', 'reopen', 'stable', 'status'].includes(action) && rest.length % 2 === 0, 'INVALID_RESUME_COMMAND');
  const additional = action === 'prepare' ? ['--input', '--source-url-file'] : action === 'stable' ? ['--acceptance'] : [];
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    check(['--run', '--key', ...additional].includes(rest[index]) && !(rest[index] in options), 'INVALID_RESUME_ARGUMENT');
    options[rest[index]] = rest[index + 1];
  }
  check(isAbsolute(options['--run'] ?? '') && isAbsolute(options['--key'] ?? ''), 'ABSOLUTE_RUN_AND_KEY_REQUIRED');
  const directory = resolve(options['--run']); const key = await loadKey(options['--key']);
  const planPath = resolve(directory, 'plan.json.enc'); const sourcePath = resolve(directory, 'source.json.enc');
  const statePath = resolve(directory, 'state.json.enc'); const stablePath = resolve(directory, 'stability.json.enc');
  if (action === 'prepare') await createWorkspace(directory, repository);
  return withRunLock(directory, async () => {
    if (action === 'status') {
      const plan = await readJson(planPath, key);
      const state = await absent(statePath) ? null : await readJson(statePath, key);
      console.log(JSON.stringify({ status: state?.status ?? 'prepared', step: state?.step ?? null,
        cutoverId: plan.cutoverId, stopEpoch: plan.stopEpoch, planDigest: digest(plan),
        resumeProofDigest: state?.proof ? digest(state.proof) : null })); return;
    }
    if (action === 'reopen') check(await absent(statePath), 'RESUME_ALREADY_STARTED_INSPECT_BEFORE_RETRY');
    if (action === 'stable') check(await absent(stablePath), 'STABILITY_ALREADY_SAVED_INSPECT_CONTROL_BEFORE_RETRY');
    const url = action === 'prepare' ? (await privateText(options['--source-url-file'])).trim() : (await readJson(sourcePath, key)).url;
    const dependencies = { store: createStore(), provider: await createFlyProvider(), verifyDeployment: verifyDeploymentFreeze,
      inspectDatabase: () => readConvergence(url),
      inspectConnection: async () => {
        const sql = connect(url);
        try { return await sql.begin('isolation level repeatable read read only', tx => inspectConnectionProof(tx, url)); }
        finally { await sql.end(); }
      }, save: value => writeJson(action === 'stable' ? stablePath : statePath, value, key) };
    if (action === 'prepare') {
      const plan = await prepareResume(JSON.parse(await privateText(options['--input'])), dependencies);
      await writeJson(sourcePath, { url }, key); await writeJson(planPath, plan, key);
      console.log(JSON.stringify({ status: 'prepared', cutoverId: plan.cutoverId, stopEpoch: plan.stopEpoch, planDigest: digest(plan) }));
    } else {
      const plan = await readJson(planPath, key);
      if (action === 'reopen') {
        const proof = await executeResume(plan, dependencies);
        console.log(JSON.stringify({ status: 'opened-awaiting-stability', resumeProofDigest: digest(proof) }));
      } else {
        const state = await readJson(statePath, key);
        check(state.status === 'opened-awaiting-stability' && state.proof, 'COMPLETED_RESUME_PROOF_REQUIRED');
        check(isAbsolute(options['--acceptance'] ?? ''), 'ABSOLUTE_ACCEPTANCE_REPORT_REQUIRED');
        const proof = await certifyStability(plan, state.proof, await readJson(options['--acceptance'], key), dependencies);
        console.log(JSON.stringify({ status: plan.finalPhase, stabilityDigest: digest(proof) }));
      }
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof ControlError || error instanceof RehearsalError ? error.code : 'MAINTENANCE_RESUME_FAILED');
    process.exitCode = 1;
  }
}
