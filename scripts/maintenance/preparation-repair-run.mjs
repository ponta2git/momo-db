#!/usr/bin/env node
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ControlError, canonicalJson, digest } from './control.mjs';
import { createStore } from './github-store.mjs';
import { executionContext } from './run.mjs';
import { validatePreparationReceipt, grantPreparationRepair, assertPreparationRepairMutation, completePreparationRepair,
  verifyPreparationProducer, inspectPreparationBarriers, verifyPreparationGrantParent, verifyPreparationCompletion } from './preparation-repair.mjs';

const check = (condition, code) => { if (!condition) throw new ControlError(code); };
const read = async path => {
  check(typeof path === 'string', 'PREPARATION_REPAIR_JSON_FILE_REQUIRED');
  const info = await lstat(path);
  check(info.isFile() && (info.mode & 0o077) === 0 && info.size <= 65536, 'PREPARATION_REPAIR_PRIVATE_FILE_REQUIRED');
  return JSON.parse(await readFile(path, 'utf8'));
};

async function barriers(receipt, request) {
  const actual = await inspectPreparationBarriers(receipt.baselineControl.record, receipt.execution, request);
  check(actual === receipt.baseline.barrierDigest, 'PREPARATION_REPAIR_BARRIERS_CHANGED');
}

export async function guardPreparationExecution(store, receipt, grantHead, evidence, step, context, request, now) {
  validatePreparationReceipt(receipt);
  // Resolve immutable producer/parent evidence and slow remote inventories
  // first. The final mutable control read is immediately before permission.
  await verifyPreparationProducer(receipt, request);
  await verifyPreparationGrantParent(grantHead, receipt, request);
  await barriers(receipt, request);
  const current = await store.read();
  return assertPreparationRepairMutation(current, receipt, grantHead, context, evidence, step, now);
}

export async function main(args, store = createStore(), request, environment = process.env) {
  const [action, ...rest] = args;
  if (action === 'bind') {
    check(rest.length === 2, 'PREPARATION_REPAIR_INPUT_AND_OUTPUT_REQUIRED');
    const input = await read(rest[0]);
    check(!Object.hasOwn(input, 'execution'), 'PREPARATION_REPAIR_UNBOUND_INPUT_REQUIRED');
    const context = executionContext(environment);
    check(context.eventName === 'workflow_dispatch', 'PREPARATION_REPAIR_DISPATCH_REQUIRED');
    const receipt = validatePreparationReceipt({ ...input, execution: context.execution });
    await verifyPreparationProducer(receipt, request);
    await barriers(receipt, request);
    const current = await store.read();
    grantPreparationRepair(current, receipt);
    await writeFile(rest[1], canonicalJson(receipt) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ receiptDigest: digest(receipt), execution: receipt.execution }));
  } else if (action === 'grant') {
    check(rest.length === 1, 'PREPARATION_REPAIR_RECEIPT_REQUIRED');
    const receipt = validatePreparationReceipt(await read(rest[0]));
    await verifyPreparationProducer(receipt, request);
    await barriers(receipt, request);
    const current = await store.read();
    const next = grantPreparationRepair(current, receipt);
    const result = await store.compareAndSwap(current, next);
    console.log(JSON.stringify({ grantHead: result.head, stateVersion: result.record.stateVersion, stopEpoch: result.record.epoch,
      receiptDigest: digest(receipt) }));
  } else if (action === 'guard') {
    check(rest.length === 4, 'PREPARATION_REPAIR_RECEIPT_GRANT_OBSERVATION_STEP_REQUIRED');
    const receipt = await read(rest[0]);
    const evidence = await read(rest[2]);
    console.log(JSON.stringify(await guardPreparationExecution(store, receipt, rest[1], evidence, rest[3], executionContext(environment), request)));
  } else if (action === 'complete') {
    check(rest.length === 3, 'PREPARATION_REPAIR_RECEIPT_GRANT_COMPLETION_REQUIRED');
    const receipt = validatePreparationReceipt(await read(rest[0]));
    const completion = await read(rest[2]);
    await verifyPreparationProducer(receipt, request);
    await verifyPreparationGrantParent(rest[1], receipt, request);
    await verifyPreparationCompletion(receipt, completion, request);
    await barriers(receipt, request);
    const current = await store.read();
    const next = completePreparationRepair(current, receipt, rest[1], completion);
    const result = await store.compareAndSwap(current, next);
    console.log(JSON.stringify({ head: result.head, stateVersion: result.record.stateVersion, stopEpoch: result.record.epoch,
      phase: result.record.cutover.phase, preparationRepairDigest: result.record.cutover.evidence.preparationRepair }));
  } else throw new ControlError('UNKNOWN_PREPARATION_REPAIR_COMMAND');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof ControlError ? error.code : 'PREPARATION_RUNTIME_REPAIR_FAILED');
    process.exitCode = 1;
  }
}
