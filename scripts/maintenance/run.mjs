#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ControlError, initialControl, transition, assertNormalMutation, assertMaintenanceMutation, assertReceiptScope,
  validateReceipt, canonicalJson, digest } from './control.mjs';
import { createStore } from './github-store.mjs';
import { verifyProducer, captureApprovalPolicies, verifyDeploymentFreeze } from './github-evidence.mjs';

const check = (condition, code) => { if (!condition) throw new ControlError(code); };
const read = async path => {
  check(typeof path === 'string', 'JSON_FILE_REQUIRED');
  const bytes = await readFile(path);
  check(bytes.length <= 65536, 'JSON_FILE_TOO_LARGE');
  return JSON.parse(bytes.toString('utf8'));
};
export function executionContext(environment = process.env) {
  const workflow = environment.GITHUB_WORKFLOW_REF?.split('@')[0]?.split('/').slice(2).join('/');
  return { eventName: environment.GITHUB_EVENT_NAME, execution: {
    repository: environment.GITHUB_REPOSITORY, workflow, ref: environment.GITHUB_REF,
    sha: environment.GITHUB_SHA, runId: environment.GITHUB_RUN_ID,
    runAttempt: Number(environment.GITHUB_RUN_ATTEMPT),
  } };
}

export async function guardMaintenanceExecution(store, receipt, context, operation, request) {
  validateReceipt(receipt);
  check(receipt.operation === operation, 'UNEXPECTED_OPERATION');
  // Artifact lookups can take several network round trips. Read the mutable
  // stop state only after they settle, immediately before returning permission.
  await verifyProducer(receipt, request);
  const current = await store.read();
  const result = assertMaintenanceMutation(current.record, receipt, context, operation);
  return { controlHead: current.head, ...result };
}

export async function main(args, store = createStore(), request) {
  const [action, ...rest] = args;
  if (action === 'initialize') {
    check(rest.length === 1, 'OPERATOR_LOGIN_REQUIRED');
    const result = await store.initialize(initialControl(rest[0]));
    console.log(JSON.stringify({ head: result.head, stateVersion: result.record.stateVersion }));
    return;
  }
  if (action === 'bind-receipt') {
    check(rest.length === 3, 'OPERATION_RECEIPT_INPUT_AND_OUTPUT_REQUIRED');
    const input = await read(rest[1]);
    // Never trust an execution tuple supplied by an operator or an older run.
    const receipt = validateReceipt({ ...input, execution: executionContext().execution });
    await verifyProducer(receipt, request);
    const previous = await store.read();
    assertReceiptScope(previous.record, receipt, executionContext(), rest[0]);
    await writeFile(rest[2], canonicalJson(receipt) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ receiptDigest: digest(receipt), execution: receipt.execution }));
    return;
  }
  if (action === 'capture-approvals') {
    check(rest.length === 1, 'APPROVAL_OUTPUT_REQUIRED');
    const approvals = await captureApprovalPolicies(request);
    await writeFile(rest[0], canonicalJson(approvals) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ approvalPolicyDigest: digest(approvals) }));
    return;
  }
  if (action === 'maintenance-guard') {
    check(rest.length === 2, 'OPERATION_AND_RECEIPT_FILE_REQUIRED');
    const receipt = await read(rest[1]);
    console.log(JSON.stringify(await guardMaintenanceExecution(store, receipt, executionContext(), rest[0], request)));
    return;
  }
  const previous = await store.read();
  if (action === 'status') {
    check(rest.length === 0, 'INVALID_ARGUMENTS');
    console.log(JSON.stringify({ head: previous.head, stateVersion: previous.record.stateVersion,
      cutoverId: previous.record.cutover?.id ?? null, stopEpoch: previous.record.cutover?.stopEpoch ?? null,
      phase: previous.record.cutover?.phase ?? 'NORMAL' }));
  } else if (action === 'normal-guard') {
    check(rest.length === 0, 'INVALID_ARGUMENTS');
    assertNormalMutation(previous.record);
    console.log('NORMAL_MUTATION_ALLOWED');
  } else if (action === 'normal-status') {
    check(rest.length === 0, 'INVALID_ARGUMENTS');
    console.log(`allowed=${previous.record.cutover === null}`);
  } else if (action === 'verify-freeze') {
    check(rest.length === 2, 'APPROVAL_INPUT_AND_FREEZE_OUTPUT_REQUIRED');
    const proof = await verifyDeploymentFreeze(previous.record, await read(rest[0]), request);
    await writeFile(rest[1], canonicalJson(proof) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ deploymentFreezeDigest: digest(proof), incomplete: proof.incomplete }));
  } else if (action === 'transition') {
    check(rest.length === 3 && /^[1-9][0-9]*$/.test(rest[0]), 'VERSION_ACTION_AND_PAYLOAD_REQUIRED');
    const record = transition(previous.record, Number(rest[0]), rest[1], await read(rest[2]));
    const result = await store.compareAndSwap(previous, record);
    console.log(JSON.stringify({ head: result.head, stateVersion: result.record.stateVersion,
      stopEpoch: result.record.cutover?.stopEpoch ?? null, phase: result.record.cutover?.phase ?? 'NORMAL' }));
  } else throw new ControlError('UNKNOWN_CONTROL_COMMAND');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof ControlError ? error.code : 'MAINTENANCE_CONTROL_FAILED');
    process.exitCode = 1;
  }
}
