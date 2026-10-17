#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stat } from 'node:fs/promises';
import { expectedMigrationHistory } from '../check-migration-history.mjs';
import { inspectSchema, inspectIdentifierValues } from './inventory.mjs';
import { connect, databaseLocation, inspectConnection, fingerprint, compareFingerprints, historyState } from './database.mjs';
import { command, start } from './process.mjs';
import { resolvePostgresImage, startLocal, assertOwned, restoreArchive, createDatabase, localUrl, cleanupLocal } from './local.mjs';
import { RehearsalError, requireCondition, createWorkspace, loadKey, digest, fileDigest, privateDirectory,
  writeJson, readJson, encryptStream, withRunLock } from './files.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const isolation = 'isolation level repeatable read read only';
const baselineName = 'momo_rehearsal_baseline';
const migrationName = 'momo_rehearsal_migration';
const recoveryName = 'momo_rehearsal_recovery';

export function parseArguments(args) {
  const [action, ...rest] = args;
  const options = {};
  const allowed = new Set(['run-dir', 'key-file', 'source-config', 'postgres-image', 'manifest']);
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index].replace(/^--/, '');
    requireCondition(rest[index].startsWith('--') && allowed.has(name) && !(name in options) &&
      rest[index + 1] && !rest[index + 1].startsWith('--'), 'INVALID_ARGUMENTS');
    options[name] = rest[index + 1];
  }
  requireCondition(['prepare', 'inspect', 'snapshot', 'restore', 'rehearse', 'verify', 'recover-rehearsal', 'status', 'cleanup'].includes(action), 'UNKNOWN_COMMAND');
  requireCondition(isAbsolute(options['key-file'] ?? ''), 'ABSOLUTE_KEY_PATH_REQUIRED');
  return { action, options };
}

async function candidate() {
  requireCondition(process.versions.node.split('.')[0] === '24', 'NODE_24_REQUIRED');
  requireCondition(await command('git', ['status', '--porcelain'], { cwd: repository }) === '', 'CLEAN_COMMITTED_CANDIDATE_REQUIRED');
  const sha = await command('git', ['rev-parse', 'HEAD'], { cwd: repository });
  requireCondition(/^[a-f0-9]{40}$/.test(sha), 'FIXED_CANDIDATE_REQUIRED');
  return { sha, migrationDigest: digest(expectedMigrationHistory(`${repository}/drizzle`)),
    lockDigest: await fileDigest(`${repository}/pnpm-lock.yaml`) };
}

async function sourceUrl(manifest, key) {
  const value = await readJson(manifest.source.configuration, key);
  const location = databaseLocation(value.sourceUrl);
  requireCondition(location.identity === manifest.source.identity, 'SOURCE_IDENTITY_CHANGED');
  return value.sourceUrl;
}

// pg_restore maps owners and omits ACLs locally. Keep the complete original
// inventory encrypted, and compare the structural projection separately.
// This never certifies application-role/SECURITY DEFINER behavior.
export function schemaStructure(schema) {
  const visit = value => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).filter(([name]) => !['owner', 'privileges', 'position'].includes(name))
      .map(([name, child]) => [name, visit(child)]));
  };
  return visit(schema);
}

function applicationRows(value) {
  return { ...value, tables: value.tables.filter(table => table.schema !== 'drizzle'),
    sequences: value.sequences.filter(sequence => sequence.schema !== 'drizzle') };
}

async function audit(sql, { identifiers = false, sequences = true } = {}) {
  const connection = await inspectConnection(sql, repository);
  requireCondition(Number(connection.server.version) >= 180000 && Number(connection.server.version) < 190000, 'POSTGRES_18_REQUIRED');
  const schema = await inspectSchema(sql);
  requireCondition(schema.tables.every(table => table.kind !== 'f'), 'FOREIGN_TABLE_REQUIRES_SNAPSHOT_DESIGN');
  const [{ objects }] = await sql`SELECT count(*)::text AS objects FROM pg_largeobject_metadata`;
  requireCondition(objects === '0', 'LARGE_OBJECT_REQUIRES_COMPARATOR');
  const result = { connection, schema, rows: await fingerprint(sql, { sequences }) };
  if (identifiers) result.identifiers = await inspectIdentifierValues(sql, schema);
  return result;
}

async function withDatabase(url, operation) {
  const sql = connect(url);
  try { return await sql.begin(isolation, operation); }
  finally { await sql.end().catch(() => {}); }
}

function compareRestore(before, after, { sequences = false } = {}) {
  for (const key of ['encoding', 'collation', 'ctype']) {
    requireCondition(before.connection.server[key] === after.connection.server[key], 'DATABASE_LOCALE_DIFFERS');
  }
  requireCondition(before.connection.ledgerDigest === after.connection.ledgerDigest, 'RESTORED_LEDGER_DIFFERS');
  requireCondition(digest(schemaStructure(before.schema)) === digest(schemaStructure(after.schema)), 'RESTORED_SCHEMA_DIFFERS');
  compareFingerprints(before.rows, after.rows, { sequences });
}

function summary(manifest) {
  return { formatVersion: 1, runId: manifest.runId, candidate: manifest.candidate.sha, state: manifest.state,
    snapshot: manifest.snapshot ? { mode: manifest.snapshot.mode, archiveDigest: manifest.snapshot.archiveDigest,
      tables: manifest.snapshot.tableCount, ledgerEntries: manifest.snapshot.ledgerCount } : null,
    checks: manifest.checks, incomplete: manifest.incomplete,
    durationsMs: manifest.durationsMs };
}

async function runAction(action, manifest, directory, key, save) {
  const report = name => resolve(directory, `${name}.json.enc`);
  const archive = resolve(directory, 'source.dump.enc');
  if (action === 'status') return;
  if (action === 'cleanup') { await cleanupLocal(manifest, save); manifest.state = 'cleaned'; return; }
  requireCondition(digest(await candidate()) === digest(manifest.candidate), 'CANDIDATE_CHANGED');

  if (action === 'inspect') {
    const inspection = await withDatabase(await sourceUrl(manifest, key), sql => audit(sql, { identifiers: true, sequences: false }));
    await writeJson(report('inspection'), inspection, key);
    manifest.checks.sourceInventory = true;
    manifest.inspection = { digest: digest(inspection), blockers: inspection.identifiers.blockers.length,
      unresolvedColumns: inspection.identifiers.unresolved.length };
    return;
  }
  if (action === 'snapshot') {
    requireCondition(manifest.state === 'prepared', 'SNAPSHOT_ALREADY_STARTED');
    const url = await sourceUrl(manifest, key);
    const sql = connect(url);
    try {
      const before = await inspectConnection(sql, repository);
      await sql.begin(isolation, async transaction => {
        const [{ snapshot }] = await transaction`SELECT pg_export_snapshot() AS snapshot`;
        requireCondition(/^[0-9A-Fa-f-]+$/.test(snapshot), 'INVALID_EXPORTED_SNAPSHOT');
        // Audit before applying any migration, in the exact dump snapshot.
        const baseline = await audit(transaction, { identifiers: true, sequences: false });
        requireCondition(before.ledgerDigest === baseline.connection.ledgerDigest, 'SOURCE_LEDGER_CHANGED');
        const configuration = databaseLocation(url).configuration;
        const environment = { ...process.env, ...configuration,
          PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=300000 -c lock_timeout=10000', PGAPPNAME: 'momo-db-rehearsal-dump' };
        const names = [...Object.keys(configuration), 'PGOPTIONS', 'PGAPPNAME'];
        const args = ['run', '--rm', '--interactive', ...names.flatMap(name => ['--env', name]),
          manifest.postgres.id, 'pg_dump', '--format=custom', '--no-password', `--snapshot=${snapshot}`];
        const { child, completed } = start('docker', args, { env: environment, failureCode: 'SOURCE_DUMP_FAILED' });
        child.stdin.end();
        try { await Promise.all([encryptStream(child.stdout, archive, key), completed]); }
        catch (error) { child.kill('SIGKILL'); await completed.catch(() => {}); throw error; }
        await writeJson(report('source'), baseline, key);
        manifest.snapshot = { mode: 'online-consistent-snapshot', capturedAt: new Date().toISOString(),
          archiveDigest: await fileDigest(archive), auditDigest: digest(baseline),
          bytes: (await stat(archive)).size, tableCount: baseline.rows.tables.length,
          ledgerCount: baseline.connection.ledger.length, pendingDigest: digest(baseline.connection.pending) };
      });
      const after = await inspectConnection(sql, repository);
      requireCondition(after.ledgerDigest === before.ledgerDigest, 'SOURCE_LEDGER_CHANGED');
      manifest.state = 'snapshotted';
      manifest.checks.sourceSnapshot = true;
    } finally { await sql.end().catch(() => {}); }
    return;
  }
  if (action === 'restore') {
    requireCondition(manifest.state === 'snapshotted', 'SNAPSHOT_REQUIRED');
    await startLocal(manifest, save);
    await restoreArchive(manifest, archive, baselineName, key);
    const before = await readJson(report('source'), key);
    const after = await withDatabase(localUrl(manifest, baselineName), sql => audit(sql));
    compareRestore(before, after);
    await writeJson(report('baseline'), after, key);
    manifest.state = 'restored';
    manifest.checks.restore = true;
    return;
  }
  await assertOwned(manifest);
  if (action === 'rehearse') {
    requireCondition(manifest.state === 'restored', 'RESTORED_BASELINE_REQUIRED');
    await createDatabase(manifest, migrationName, baselineName);
    manifest.state = 'migration-started';
    await save();
    const target = localUrl(manifest, migrationName);
    databaseLocation(target, { local: true });
    await command('pnpm', ['db:migrate:ci'], { cwd: repository, env: { ...process.env, DIRECT_URL: target }, failureCode: 'LOCAL_MIGRATION_FAILED' });
    manifest.state = 'migrated';
  }
  if (action === 'rehearse' || action === 'verify') {
    requireCondition(['migration-started', 'migrated', 'verified', 'recovery-verified'].includes(manifest.state), 'MIGRATION_REQUIRED');
    const before = await readJson(report('baseline'), key);
    const after = await withDatabase(localUrl(manifest, migrationName), sql => audit(sql));
    requireCondition(historyState(expectedMigrationHistory(`${repository}/drizzle`), after.connection.ledger) === 'target', 'TARGET_LEDGER_REQUIRED');
    // The initial command permits no application data differences. Future
    // transformations need a reviewed, column-specific comparator before use.
    compareFingerprints(applicationRows(before.rows), applicationRows(after.rows));
    await writeJson(report('migrated'), after, key);
    manifest.state = 'verified';
    manifest.checks.migration = true;
    manifest.checks.savedRows = true;
    return;
  }
  if (action === 'recover-rehearsal') {
    requireCondition(manifest.state === 'verified', 'VERIFIED_MIGRATION_REQUIRED');
    await restoreArchive(manifest, archive, recoveryName, key);
    const before = await readJson(report('source'), key);
    const after = await withDatabase(localUrl(manifest, recoveryName), sql => audit(sql));
    compareRestore(before, after);
    // Compare sequences to the baseline restore of the same archive, because
    // sequence state is not MVCC and cannot be certified by a hot snapshot.
    const baseline = await readJson(report('baseline'), key);
    compareRestore(baseline, after, { sequences: true });
    await writeJson(report('recovered'), after, key);
    manifest.state = 'recovery-verified';
    manifest.checks.databaseRecovery = true;
    return;
  }
  throw new RehearsalError('UNKNOWN_COMMAND');
}

export async function main(args) {
  const { action, options } = parseArguments(args);
  const key = await loadKey(options['key-file']);
  let directory, path, manifest;
  if (action === 'prepare') {
    const fixed = await candidate();
    requireCondition(isAbsolute(options['source-config'] ?? ''), 'EXPLICIT_SOURCE_CONFIGURATION_REQUIRED');
    const source = await readJson(options['source-config'], key);
    const identity = databaseLocation(source.sourceUrl).identity;
    const postgres = await resolvePostgresImage(options['postgres-image'] ?? 'postgres:18-alpine');
    directory = await createWorkspace(options['run-dir'], repository);
    path = resolve(directory, 'manifest.json.enc');
    manifest = { formatVersion: 1, runId: randomUUID(), candidate: fixed, postgres,
      createdAt: new Date().toISOString(), state: 'prepared',
      source: { configuration: options['source-config'], identity }, local: null, checks: {}, durationsMs: {},
      incomplete: ['column-mapping-and-consumer-contracts', 'application-role-behavior', 'consumer-smoke-and-connection-switch',
        'final-continuous-freeze-snapshot', 'production-approval-and-cutover'] };
    await writeJson(path, manifest, key);
  } else {
    requireCondition(isAbsolute(options.manifest ?? ''), 'ABSOLUTE_MANIFEST_PATH_REQUIRED');
    path = options.manifest;
    directory = dirname(path);
    await privateDirectory(directory);
    manifest = await readJson(path, key);
    requireCondition(manifest.formatVersion === 1, 'UNSUPPORTED_MANIFEST_VERSION');
    await withRunLock(directory, async () => {
      const started = performance.now();
      const save = () => writeJson(path, manifest, key);
      await runAction(action, manifest, directory, key, save);
      manifest.durationsMs[action] = Math.round(performance.now() - started);
      await save();
    });
  }
  console.log(JSON.stringify(summary(manifest), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(process.argv.slice(2)); }
  catch (error) {
    // Drivers, pg_dump and pg_restore can echo credentials or saved row values.
    console.error(error instanceof RehearsalError ? error.code : 'REHEARSAL_FAILED_PRIVATE_DETAILS_WITHHELD');
    process.exitCode = 1;
  }
}
