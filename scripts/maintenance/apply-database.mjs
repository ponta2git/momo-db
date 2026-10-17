#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expectedMigrationHistory, verifyMigrationHistory } from '../check-migration-history.mjs';
import { connect, databaseLocation, databaseLocale, inspectConnection, fingerprint, historyState } from '../migration/database.mjs';
import { inspectSchema } from '../migration/inventory.mjs';
import { schemaStructure } from '../migration/run.mjs';
import { command } from '../migration/process.mjs';
import { digest as databaseDigest, fileDigest } from '../migration/files.mjs';
import { ControlError, assertNormalMutation, validateReceipt, digest } from './control.mjs';
import { createStore } from './github-store.mjs';
import { executionContext, guardMaintenanceExecution } from './run.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const check = (condition, code) => { if (!condition) throw new ControlError(code); };

export const databaseSchemaDigest = (connection, schema) => databaseDigest({
  locale: databaseLocale(connection.server), structure: schemaStructure(schema),
});

export function classifyDatabase(receipt, snapshot, expected) {
  validateReceipt(receipt);
  check(receipt.operation === 'database', 'DATABASE_RECEIPT_REQUIRED');
  const evidence = receipt.evidence;
  check(snapshot.identity === evidence.sourceIdentity, 'DATABASE_IDENTITY_CHANGED');
  check(databaseDigest(expected) === evidence.targetLedger, 'TARGET_MIGRATION_ARTIFACT_CHANGED');
  const state = historyState(expected, snapshot.ledger);
  check(state !== 'unknown', 'UNKNOWN_DATABASE_LEDGER');
  const actualLedger = databaseDigest(snapshot.ledger);
  if (state === 'target') {
    check(snapshot.schemaDigest === evidence.targetSchema && snapshot.dataDigest === evidence.targetData, 'TARGET_DATABASE_PROOF_DIFFERS');
    return 'target';
  }
  check(actualLedger === evidence.baselineLedger, 'EXACT_BASELINE_LEDGER_REQUIRED');
  check(databaseDigest(expected.slice(snapshot.ledger.length)) === evidence.pendingTail, 'PENDING_TAIL_CHANGED');
  check(snapshot.schemaDigest === evidence.baselineSchema && snapshot.dataDigest === evidence.savedData, 'BASELINE_DATABASE_PROOF_DIFFERS');
  return 'baseline';
}

// The normal migrator is the only SQL mutation entry. A lost runner result is
// recovered by classifying the complete target, never by blindly applying again.
export async function executeDatabase({ receipt, expected, guard, capture, preflight, migrate, verify }) {
  await guard();
  await preflight();
  const before = await capture();
  const state = classifyDatabase(receipt, before, expected);
  await guard();
  if (state === 'baseline') await migrate();
  await verify();
  const after = await capture();
  check(classifyDatabase(receipt, after, expected) === 'target', 'TARGET_DATABASE_REQUIRED');
  const control = await guard();
  return { formatVersion: 1, operation: 'database', cutoverId: receipt.cutoverId, stopEpoch: receipt.stopEpoch,
    candidate: receipt.candidates.db, execution: receipt.execution, receiptDigest: digest(receipt),
    mode: state === 'target' ? 'verified-existing-target' : 'applied-and-verified',
    sourceIdentity: after.identity, targetLedger: databaseDigest(after.ledger), targetSchema: after.schemaDigest,
    targetData: after.dataDigest, control };
}

async function capture(url) {
  const sql = connect(url);
  try {
    return await sql.begin('isolation level repeatable read read only', async transaction => {
      const connection = await inspectConnection(transaction, repository);
      check(Number(connection.server.version) >= 180000 && Number(connection.server.version) < 190000, 'POSTGRES_18_REQUIRED');
      const schema = await inspectSchema(transaction);
      check(schema.tables.every(table => table.kind !== 'f'), 'FOREIGN_TABLE_REQUIRES_SNAPSHOT_DESIGN');
      const [{ objects }] = await transaction`SELECT count(*)::text AS objects FROM pg_largeobject_metadata`;
      check(objects === '0', 'LARGE_OBJECT_REQUIRES_COMPARATOR');
      const rows = await fingerprint(transaction);
      return { identity: databaseLocation(url).identity, ledger: connection.ledger,
        schemaDigest: databaseSchemaDigest(connection, schema), dataDigest: rows.digest };
    });
  } finally { await sql.end().catch(() => {}); }
}

export async function main(args) {
  check(args.length === 0 || (args.length === 2 && args[0] === '--receipt'), 'INVALID_DATABASE_EXECUTOR_ARGUMENTS');
  check(process.versions.node.split('.')[0] === '24', 'NODE_24_REQUIRED');
  const context = executionContext();
  const commit = await command('git', ['rev-parse', 'HEAD'], { cwd: repository });
  check(/^[a-f0-9]{40}$/.test(commit) && commit === context.execution.sha, 'CHECKOUT_CANDIDATE_CHANGED');
  check(typeof process.env.DIRECT_URL === 'string', 'DIRECT_DATABASE_CONFIGURATION_REQUIRED');
  const url = process.env.DIRECT_URL;
  databaseLocation(url);
  const store = createStore();
  const preflight = () => command('pnpm', ['db:preflight:ci'], { cwd: repository, failureCode: 'DATABASE_PREFLIGHT_FAILED' });
  const migrate = () => command('pnpm', ['db:migrate:ci'], { cwd: repository, failureCode: 'DATABASE_MIGRATION_RESULT_UNKNOWN' });
  const verify = async () => {
    const sql = connect(url);
    try { await verifyMigrationHistory(sql, `${repository}/drizzle`); }
    finally { await sql.end().catch(() => {}); }
  };
  if (args.length === 0) {
    check(context.eventName === 'push' && context.execution.ref === 'refs/heads/master', 'NORMAL_MASTER_PUSH_REQUIRED');
    assertNormalMutation((await store.read()).record);
    await preflight();
    assertNormalMutation((await store.read()).record);
    await migrate();
    await verify();
    console.log('NORMAL_DATABASE_MIGRATION_VERIFIED');
    return;
  }
  const bytes = await readFile(args[1]);
  check(bytes.length <= 65536, 'RECEIPT_TOO_LARGE');
  const receipt = validateReceipt(JSON.parse(bytes.toString('utf8')));
  check(receipt.candidates.db === commit && receipt.producer.configDigest === await fileDigest(`${repository}/drizzle.config.ts`), 'DATABASE_CONFIGURATION_CHANGED');
  const guard = async () => {
    const result = await guardMaintenanceExecution(store, receipt, context, 'database');
    return { head: result.controlHead, stateVersion: result.stateVersion };
  };
  const proof = await executeDatabase({ receipt, expected: expectedMigrationHistory(`${repository}/drizzle`),
    guard, capture: () => capture(url), preflight, migrate, verify });
  const output = resolve(process.env.RUNNER_TEMP ?? repository, 'database-maintenance-proof.json');
  await writeFile(output, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ mode: proof.mode, proofDigest: digest(proof) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof ControlError ? error.code : 'DATABASE_EXECUTION_FAILED_PRIVATE_DETAILS_WITHHELD');
    process.exitCode = 1;
  }
}
