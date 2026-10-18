import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createTestClient } from './notification-fixtures.mjs';
import { docker, username } from './migration-fixtures.mjs';
import { command } from '../scripts/migration/process.mjs';
import { connect, databaseLocation, inspectConnection, fingerprint } from '../scripts/migration/database.mjs';
import { inspectSchema } from '../scripts/migration/inventory.mjs';
import { schemaStructure } from '../scripts/migration/run.mjs';
import { digest as databaseDigest } from '../scripts/migration/files.mjs';
import { digest } from '../scripts/maintenance/control.mjs';
import { executeDatabase, databaseSchemaDigest } from '../scripts/maintenance/apply-database.mjs';
import { inspectConnectionProof, connectionProof } from '../scripts/maintenance/connection-proof.mjs';
import { expectedMigrationHistory, verifyMigrationHistory } from '../scripts/check-migration-history.mjs';

async function withDatabase(run) {
  const name = 'momo_db_test_maintenance_' + randomUUID().replaceAll('-', '').slice(0, 12);
  docker(['createdb', '-U', username, name]);
  const sql = createTestClient(name);
  const url = new URL(`postgresql://127.0.0.1:${process.env.MOMO_DB_TEST_PORT ?? 5432}/${name}`);
  url.username = username;
  if (process.env.MOMO_DB_TEST_PASSWORD) url.password = process.env.MOMO_DB_TEST_PASSWORD;
  try { return await run(sql, name, url.toString()); }
  finally { await sql.end(); docker(['dropdb', '-U', username, name]); }
}

async function capture(url) {
  const sql = connect(url);
  try {
    return await sql.begin('isolation level repeatable read read only', async tx => {
      const connection = await inspectConnection(tx, process.cwd());
      const schema = await inspectSchema(tx);
      const rows = await fingerprint(tx);
      return { identity: databaseLocation(url).identity, ledger: connection.ledger,
        structure: schemaStructure(schema), rows,
        schemaDigest: databaseSchemaDigest(connection, schema), dataDigest: rows.digest };
    });
  } finally { await sql.end(); }
}

test('real PostgreSQL apply rejects changed saved values and recovers a committed runner loss without replay', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'momo-maintenance-prefix-'));
  try {
    await cp('./drizzle', folder, { recursive: true });
    const journal = JSON.parse(await readFile('./drizzle/meta/_journal.json', 'utf8'));
    journal.entries = journal.entries.slice(0, -1);
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
    await withDatabase(async (source, name, url) => {
      await migrate(drizzle(source), { migrationsFolder: folder });
      await source.unsafe(`CREATE TABLE public.maintenance_fixture (
        id bigint PRIMARY KEY, payload jsonb NOT NULL, precise numeric NOT NULL, bytes bytea NOT NULL);
        INSERT INTO public.maintenance_fixture VALUES
        (9007199254740993, '{"number":9007199254740993}', 12345678901234567890.000000001, decode('00ff80','hex'));`);
      const before = await capture(url);
      const proofConnection = connect(url);
      try {
        const connection = await proofConnection.begin('isolation level repeatable read read only', tx => inspectConnectionProof(tx, url));
        assert.deepEqual(connection, connectionProof(url, name, before.ledger));
      } finally { await proofConnection.end(); }
      const archive = docker(['pg_dump', '-U', username, '--format=custom', '--no-owner', '--no-acl', name]);
      const target = await withDatabase(async (_preview, previewName, previewUrl) => {
        docker(['pg_restore', '-U', username, '--exit-on-error', '--single-transaction', '--no-owner', '--no-acl', '-d', previewName], archive);
        await command('pnpm', ['db:migrate:ci'], { env: { ...process.env, DIRECT_URL: previewUrl } });
        return capture(previewUrl);
      });
      const expected = expectedMigrationHistory();
      const hash = value => digest({ fixture: value });
      const candidates = { db: 'a'.repeat(40), summit: 'b'.repeat(40), result: 'c'.repeat(40) };
      const receipt = { formatVersion: 1, operation: 'database', scope: null, cutoverId: 'fixture', stopEpoch: 1, candidates,
        evidence: { sourceIdentity: before.identity, baselineLedger: databaseDigest(before.ledger), targetLedger: databaseDigest(expected),
          pendingTail: databaseDigest(expected.slice(before.ledger.length)), savedData: before.dataDigest, baselineSchema: before.schemaDigest,
          targetData: target.dataDigest, targetSchema: target.schemaDigest, snapshot: hash('snapshot'), finalRehearsal: hash('rehearsal'), previousStage: hash('stage') },
        producer: { runId: '100', runAttempt: 1, artifacts: [{ id: '200', digest: hash('artifact') }], configDigest: hash('config'), secretVersion: 'fixture' },
        execution: { repository: 'ponta2git/momo-db', workflow: '.github/workflows/ci.yml', ref: 'refs/heads/cutover/fixture',
          sha: candidates.db, runId: '300', runAttempt: 1 } };
      let migratorCalls = 0;
      const dependencies = { receipt, expected, capture: () => capture(url),
        guard: async () => ({ head: 'd'.repeat(40), stateVersion: 5 }),
        preflight: () => command('pnpm', ['db:preflight:ci'], { env: { ...process.env, DIRECT_URL: url } }),
        migrate: async () => {
          migratorCalls++;
          await command('pnpm', ['db:migrate:ci'], { env: { ...process.env, DIRECT_URL: url } });
          throw new Error('fixture-runner-result-lost-after-commit');
        },
        verify: () => verifyMigrationHistory(source),
      };
      await source`UPDATE public.maintenance_fixture SET precise = precise + 0.000000001`;
      await assert.rejects(executeDatabase(dependencies), error => error.code === 'BASELINE_DATABASE_PROOF_DIFFERS');
      assert.equal(migratorCalls, 0);
      await source`UPDATE public.maintenance_fixture SET precise = precise - 0.000000001`;
      await assert.rejects(executeDatabase(dependencies), /fixture-runner-result-lost-after-commit/);
      assert.equal(migratorCalls, 1);
      const observed = await capture(url);
      assert.deepEqual(observed.rows, target.rows);
      assert.deepEqual(observed.structure, target.structure);
      const proof = await executeDatabase(dependencies);
      assert.equal(proof.mode, 'verified-existing-target');
      assert.equal(migratorCalls, 1);
      assert.equal(proof.targetData, target.dataDigest);
      assert.equal(proof.targetSchema, target.schemaDigest);
      await source`UPDATE public.maintenance_fixture SET payload = '{"number":9007199254740994}'::jsonb`;
      await assert.rejects(executeDatabase(dependencies), error => error.code === 'TARGET_DATABASE_PROOF_DIFFERS');
      assert.equal(migratorCalls, 1);
    });
  } finally { await rm(folder, { recursive: true, force: true }); }
});
