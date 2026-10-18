#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stat } from 'node:fs/promises';
import { expectedMigrationHistory } from '../check-migration-history.mjs';
import { inspectSchema, inspectIdentifierValues } from './inventory.mjs';
import { connect, databaseLocation, inspectServer, inspectConnection, fingerprint, compareFingerprints, compareDatabaseLocale, historyState } from './database.mjs';
import { command, start } from './process.mjs';
import { importSnapshot } from './snapshot.mjs';
import { createMigrationReferences } from './reference.mjs';
import { schemaStructure } from './schema.mjs';
export { schemaStructure } from './schema.mjs';
import { PUBLIC_IDENTIFIER_PROFILE, PUBLIC_IDENTIFIER_SOURCE_LENGTH, loadPublicIdentifierHistory,
  createPublicIdentifierProfile, inspectPublicIdentifierTransition, comparePublicIdentifierTransition } from './public-identifiers.mjs';
import { resolvePostgresImage, startLocal, assertOwned, restoreArchive, createDatabase, databaseState, localUrl, cleanupLocal, withLocalConnection } from './local.mjs';
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
  const allowed = new Set(['run-dir', 'key-file', 'source-config', 'postgres-image', 'manifest', 'snapshot-manifest', 'profile']);
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index].replace(/^--/, '');
    requireCondition(rest[index].startsWith('--') && allowed.has(name) && !(name in options) &&
      rest[index + 1] && !rest[index + 1].startsWith('--'), 'INVALID_ARGUMENTS');
    options[name] = rest[index + 1];
  }
  requireCondition(['prepare', 'inspect', 'snapshot', 'restore', 'rehearse', 'verify', 'recover-rehearsal', 'status', 'cleanup'].includes(action), 'UNKNOWN_COMMAND');
  requireCondition(isAbsolute(options['key-file'] ?? ''), 'ABSOLUTE_KEY_PATH_REQUIRED');
  requireCondition(!options['snapshot-manifest'] || (action === 'prepare' && !options['source-config']), 'SNAPSHOT_IMPORT_ONLY_FOR_PREPARE');
  requireCondition(!options.profile || (action === 'prepare' && ['preserve-v1', PUBLIC_IDENTIFIER_PROFILE].includes(options.profile)), 'INVALID_REHEARSAL_PROFILE');
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

async function audit(sql, { identifiers = false, sequences = true, profile } = {}) {
  const connection = await inspectConnection(sql, repository);
  requireCondition(Number(connection.server.version) >= 180000 && Number(connection.server.version) < 190000, 'POSTGRES_18_REQUIRED');
  const schema = await inspectSchema(sql);
  requireCondition(schema.tables.every(table => table.kind !== 'f'), 'FOREIGN_TABLE_REQUIRES_SNAPSHOT_DESIGN');
  const [{ objects }] = await sql`SELECT count(*)::text AS objects FROM pg_largeobject_metadata`;
  requireCondition(objects === '0', 'LARGE_OBJECT_REQUIRES_COMPARATOR');
  const result = { connection, schema, rows: await fingerprint(sql, { sequences }) };
  if (identifiers) result.identifiers = await inspectIdentifierValues(sql, schema);
  if (profile) result.transition = await inspectPublicIdentifierTransition(sql, profile);
  return result;
}

async function withDatabase(url, operation) {
  const sql = connect(url);
  try { return await sql.begin(isolation, operation); }
  finally { await sql.end().catch(() => {}); }
}

function compareRestore(before, after, { sequences = false } = {}) {
  compareDatabaseLocale(before.connection.server, after.connection.server);
  requireCondition(before.connection.ledgerDigest === after.connection.ledgerDigest, 'RESTORED_LEDGER_DIFFERS');
  requireCondition(digest(schemaStructure(before.schema)) === digest(schemaStructure(after.schema)), 'RESTORED_SCHEMA_DIFFERS');
  compareFingerprints(before.rows, after.rows, { sequences });
}

export function compareMigration(before, after) {
  // A row-only comparison cannot certify indexes, constraints, functions, or
  // empty tables. Pending tails need a reviewed expected target schema before
  // this generic preservation runner may apply them.
  requireCondition(before.connection.pending.length === 0, 'PENDING_MIGRATIONS_REQUIRE_SCHEMA_COMPARATOR');
  requireCondition(historyState(expectedMigrationHistory(`${repository}/drizzle`), after.connection.ledger) === 'target', 'TARGET_LEDGER_REQUIRED');
  compareRestore(before, after, { sequences: true });
  requireCondition(digest(before.schema) === digest(after.schema), 'MIGRATED_SCHEMA_DIFFERS');
}

async function assertCandidate(manifest) {
  requireCondition(digest(await candidate()) === digest(manifest.candidate), 'CANDIDATE_CHANGED');
}

function summary(manifest) {
  return { formatVersion: 1, runId: manifest.runId, candidate: manifest.candidate.sha, state: manifest.state,
    snapshot: manifest.snapshot ? { mode: manifest.snapshot.mode, archiveDigest: manifest.snapshot.archiveDigest,
      tables: manifest.snapshot.tableCount, ledgerEntries: manifest.snapshot.ledgerCount } : null,
    checks: manifest.checks, incomplete: manifest.incomplete,
    durationsMs: manifest.durationsMs };
}

export async function runAction(action, manifest, directory, key, save, { signal } = {}) {
  const report = name => resolve(directory, `${name}.json.enc`);
  const archive = resolve(directory, 'source.dump.enc');
  const beforeMutation = async () => {
    requireCondition(!signal?.aborted, 'REHEARSAL_INTERRUPTED');
    await assertCandidate(manifest);
  };
  const readReport = async (name, expectedDigest) => {
    const value = await readJson(report(name), key);
    requireCondition(typeof expectedDigest === 'string' && digest(value) === expectedDigest, 'REPORT_DIGEST_MISMATCH');
    return value;
  };
  const writeReport = async (name, value) => {
    await beforeMutation();
    await writeJson(report(name), value, key);
    return digest(value);
  };
  const migrate = async target => {
    await assertOwned(manifest);
    await beforeMutation();
    databaseLocation(target, { local: true });
    await command('pnpm', ['db:migrate:ci'], { cwd: repository, env: { ...process.env, DIRECT_URL: target }, failureCode: 'LOCAL_MIGRATION_FAILED', signal });
  };
  const migrationProfile = async before => {
    const selected = manifest.profile ?? 'preserve-v1';
    requireCondition(['preserve-v1', PUBLIC_IDENTIFIER_PROFILE].includes(selected), 'INVALID_REHEARSAL_PROFILE');
    if (selected === 'preserve-v1') {
      requireCondition(before.connection.pending.length === 0, 'PENDING_MIGRATIONS_REQUIRE_SCHEMA_COMPARATOR');
      return null;
    }
    const history = await loadPublicIdentifierHistory(repository);
    requireCondition(digest(before.connection.ledger) === digest(history.entries.slice(0, PUBLIC_IDENTIFIER_SOURCE_LENGTH)),
      'PUBLIC_IDENTIFIER_SOURCE_LEDGER_DIFFERS');
    if (manifest.profileDigest) {
      const profile = await readReport('profile', manifest.profileDigest);
      requireCondition(profile.history?.migrationDigest === history.migrationDigest, 'REHEARSAL_PROFILE_CANDIDATE_CHANGED');
      requireCondition(digest(schemaStructure(before.schema)) === digest(profile.schemaBefore), 'PUBLIC_IDENTIFIER_SOURCE_SCHEMA_DIFFERS');
      return profile;
    }
    requireCondition(action === 'rehearse', 'VERIFIED_REFERENCE_PROFILE_REQUIRED');
    const references = await createMigrationReferences({ manifest, directory, repository,
      prefixLength: PUBLIC_IDENTIFIER_SOURCE_LENGTH, beforeMutation,
      capture: database => withDatabase(localUrl(manifest, database), sql => audit(sql)), migrateTarget: migrate });
    const profile = createPublicIdentifierProfile({ history, ...references });
    requireCondition(digest(schemaStructure(before.schema)) === digest(profile.schemaBefore), 'PUBLIC_IDENTIFIER_SOURCE_SCHEMA_DIFFERS');
    manifest.profileDigest = await writeReport('profile', profile);
    manifest.checks.freshReference = true;
    await save();
    return profile;
  };
  const compareTransition = (before, after, profile) => profile
    ? comparePublicIdentifierTransition({ before, after, transition: after.transition, profile })
    : compareMigration(before, after);
  if (action === 'status') return;
  if (action === 'cleanup') { await cleanupLocal(manifest, save); manifest.state = 'cleaned'; return; }
  await beforeMutation();

  if (action === 'inspect') {
    const inspection = await withDatabase(await sourceUrl(manifest, key), sql => audit(sql, { identifiers: true, sequences: false }));
    await writeReport('inspection', inspection);
    manifest.checks.sourceInventory = true;
    manifest.inspection = { digest: digest(inspection), blockers: inspection.identifiers.blockers.length,
      unresolvedColumns: inspection.identifiers.unresolved.length };
    return;
  }
  if (action === 'snapshot') {
    requireCondition(['prepared', 'snapshot-started'].includes(manifest.state), 'SNAPSHOT_ALREADY_STARTED');
    manifest.state = 'snapshot-started';
    await save();
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
        // Keep the completed inventory even if the subsequent dump fails. It
        // remains provisional until the archive and both ledger checks pass.
        manifest.sourceAuditDigest = await writeReport('source', baseline);
        await save();
        const configuration = databaseLocation(url).configuration;
        const environment = { ...process.env, ...configuration,
          PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=300000 -c lock_timeout=10000', PGAPPNAME: 'momo-db-rehearsal-dump' };
        const names = [...Object.keys(configuration), 'PGOPTIONS', 'PGAPPNAME'];
        const args = ['run', '--rm', '--interactive', ...names.flatMap(name => ['--env', name]),
          manifest.postgres.id, 'pg_dump', '--format=custom', '--no-password', `--snapshot=${snapshot}`];
        await beforeMutation();
        const { child, completed } = start('docker', args, { env: environment, failureCode: 'SOURCE_DUMP_FAILED' });
        child.stdin.end();
        try { await Promise.all([encryptStream(child.stdout, archive, key), completed]); }
        catch (error) { child.kill('SIGKILL'); await completed.catch(() => {}); throw error; }
        await beforeMutation();
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
    requireCondition(['snapshotted', 'restore-started', 'restored'].includes(manifest.state), 'SNAPSHOT_REQUIRED');
    const before = await readReport('source', manifest.snapshot?.auditDigest);
    const previous = manifest.baselineDigest ? await readReport('baseline', manifest.baselineDigest) : null;
    manifest.state = 'restore-started';
    await save();
    await startLocal(manifest, save, { beforeMutation, signal, server: before.connection.server });
    return withLocalConnection(manifest, async () => {
        // Check provider, rules and actual collation version before loading
        // saved rows. Equal locale names alone do not imply equal behavior.
        const server = await withDatabase(localUrl(manifest, baselineName), inspectServer);
        compareDatabaseLocale(before.connection.server, server);
        const existing = await databaseState(manifest, baselineName);
        if (existing !== 'populated') await restoreArchive(manifest, archive, baselineName, key, { beforeMutation, signal });
        const after = await withDatabase(localUrl(manifest, baselineName), sql => audit(sql));
        compareRestore(before, after);
        if (previous) compareRestore(previous, after, { sequences: true });
        manifest.baselineDigest = await writeReport('baseline', after);
        manifest.state = 'restored';
        manifest.checks.restore = true;
      }, { signal });
    }
    return withLocalConnection(manifest, async () => {
    if (action === 'rehearse') {
      requireCondition(['restored', 'migration-started', 'migrated', 'verified'].includes(manifest.state), 'RESTORED_BASELINE_REQUIRED');
      const before = await readReport('baseline', manifest.baselineDigest);
      const profile = await migrationProfile(before);
      const baseline = await withDatabase(localUrl(manifest, baselineName), sql => audit(sql));
      compareRestore(before, baseline, { sequences: true });
      manifest.state = 'migration-started';
      await save();
      const existing = await databaseState(manifest, migrationName);
      if (existing === 'missing') {
        await createDatabase(manifest, migrationName, baselineName, { beforeMutation });
        const target = localUrl(manifest, migrationName);
        await migrate(target);
        const first = await withDatabase(target, sql => audit(sql, { profile }));
        compareTransition(before, first, profile);
        manifest.firstMigrationDigest = await writeReport('migrated-first', first);
        manifest.checks.migratorFirstRun = true;
        manifest.state = 'migrated';
        await save();
        // The second normal migrator invocation must preserve the full local
        // schema, ledger, saved values and sequence state from the first pass.
        await migrate(target);
        const second = await withDatabase(target, sql => audit(sql, { profile }));
        compareMigration(first, second);
        manifest.migratedDigest = await writeReport('migrated', second);
        manifest.checks.migratorNoop = true;
        await save();
      } else {
        // A previous command may have committed before its process or manifest
        // write was interrupted. Existing databases are only inspected; an
        // unknown/partial state never triggers a blind CREATE or migrator replay.
        requireCondition(existing === 'populated', 'EXISTING_MIGRATION_DATABASE_REQUIRES_INSPECTION');
      }
    }
    if (action === 'rehearse' || action === 'verify') {
      requireCondition(['migration-started', 'migrated', 'verified', 'recovery-verified'].includes(manifest.state), 'MIGRATION_REQUIRED');
      const before = await readReport('baseline', manifest.baselineDigest);
      const profile = await migrationProfile(before);
      const after = await withDatabase(localUrl(manifest, migrationName), sql => audit(sql, { profile }));
      compareTransition(before, after, profile);
      if (manifest.migratedDigest) compareMigration(await readReport('migrated', manifest.migratedDigest), after);
      manifest.migratedDigest = await writeReport('migrated', after);
      if (!manifest.checks.migratorNoop) {
        manifest.checks.migratorNoop = false;
        const incomplete = 'interrupted-migrator-execution-requires-fresh-run';
        if (!manifest.incomplete.includes(incomplete)) manifest.incomplete.push(incomplete);
      }
      manifest.state = 'verified';
      manifest.checks.migration = true;
      manifest.checks.migrationSchema = true;
      manifest.checks.savedRows = true;
      return;
    }
    if (action === 'recover-rehearsal') {
      requireCondition(['verified', 'recovery-started', 'recovery-verified'].includes(manifest.state), 'VERIFIED_MIGRATION_REQUIRED');
      const before = await readReport('source', manifest.snapshot?.auditDigest);
      const baseline = await readReport('baseline', manifest.baselineDigest);
      manifest.state = 'recovery-started';
      await save();
      const existing = await databaseState(manifest, recoveryName);
      if (existing !== 'populated') await restoreArchive(manifest, archive, recoveryName, key, { beforeMutation, signal });
      const after = await withDatabase(localUrl(manifest, recoveryName), sql => audit(sql));
      compareRestore(before, after);
      // Compare sequences to the baseline restore of the same archive, because
      // sequence state is not MVCC and cannot be certified by a hot snapshot.
      compareRestore(baseline, after, { sequences: true });
      manifest.recoveredDigest = await writeReport('recovered', after);
      manifest.state = 'recovery-verified';
      manifest.checks.databaseRecovery = true;
      return;
    }
    throw new RehearsalError('UNKNOWN_COMMAND');
  }, { signal });
}

export async function main(args) {
  const { action, options } = parseArguments(args);
  const key = await loadKey(options['key-file']);
  let directory, path, manifest;
  if (action === 'prepare') {
    const fixed = await candidate();
    let source;
    if (!options['snapshot-manifest']) {
      requireCondition(isAbsolute(options['source-config'] ?? ''), 'EXPLICIT_SOURCE_CONFIGURATION_REQUIRED');
      source = { configuration: options['source-config'],
        identity: databaseLocation((await readJson(options['source-config'], key)).sourceUrl).identity };
    }
    const postgres = await resolvePostgresImage(options['postgres-image'] ?? 'postgres:18-alpine');
    requireCondition(digest(await candidate()) === digest(fixed), 'CANDIDATE_CHANGED');
    directory = await createWorkspace(options['run-dir'], repository);
    path = resolve(directory, 'manifest.json.enc');
    manifest = { formatVersion: 1, runId: randomUUID(), candidate: fixed, postgres, profile: options.profile ?? 'preserve-v1',
      createdAt: new Date().toISOString(), state: 'prepared',
      source, local: null, checks: {}, durationsMs: {},
      incomplete: ['column-mapping-and-consumer-contracts', 'application-role-behavior', 'consumer-smoke-and-connection-switch',
        'final-continuous-freeze-snapshot', 'production-approval-and-cutover'] };
    if (options['snapshot-manifest']) {
      Object.assign(manifest, await importSnapshot(options['snapshot-manifest'], directory, key,
        expectedMigrationHistory(`${repository}/drizzle`)));
      manifest.state = 'snapshotted';
      manifest.checks.sourceSnapshot = true;
    }
    await assertCandidate(manifest);
    await writeJson(path, manifest, key);
  } else {
    requireCondition(isAbsolute(options.manifest ?? ''), 'ABSOLUTE_MANIFEST_PATH_REQUIRED');
    path = options.manifest;
    directory = dirname(path);
    await privateDirectory(directory);
    await withRunLock(directory, async () => {
      // Reading before the lock permits a completed operation to be overwritten
      // by a contender holding an older manifest after it acquires the lock.
      manifest = await readJson(path, key);
      requireCondition(manifest.formatVersion === 1, 'UNSUPPORTED_MANIFEST_VERSION');
      const started = performance.now();
      const controller = ['restore', 'rehearse', 'verify', 'recover-rehearsal'].includes(action) ? new AbortController() : null;
      const interrupt = () => controller.abort();
      if (controller) {
        process.once('SIGINT', interrupt);
        process.once('SIGTERM', interrupt);
      }
      const save = async () => {
        requireCondition(!controller?.signal.aborted, 'REHEARSAL_INTERRUPTED');
        if (!['status', 'cleanup'].includes(action)) await assertCandidate(manifest);
        await writeJson(path, manifest, key);
      };
      try {
        await runAction(action, manifest, directory, key, save, { signal: controller?.signal });
        manifest.durationsMs[action] = Math.round(performance.now() - started);
        await save();
      } catch (error) {
        if (controller?.signal.aborted) throw new RehearsalError('REHEARSAL_INTERRUPTED');
        throw error;
      } finally {
        if (controller) {
          process.removeListener('SIGINT', interrupt);
          process.removeListener('SIGTERM', interrupt);
        }
      }
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
