import { migrateLegacy, legacyIdentityMigrationCount } from './migration-prefix.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createTestClient, resetFixtures } from './notification-fixtures.mjs';
import { docker, expectedFencingCounterRows, expectedPublicIdentifierRows, snapshotDatabase, username } from './migration-fixtures.mjs';

async function withDatabase(run) {
  const name = 'momo_db_test_oauth_' + randomUUID().replaceAll('-', '').slice(0, 12);
  docker(['createdb', '-U', username, name]);
  const db = createTestClient(name);
  try { return await run(db, name); }
  finally {
    await db.end();
    docker(['dropdb', '-U', username, name]);
  }
}

async function assertOAuthSchema(db) {
  const columns = [...await db`SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'oauth_state_consumptions'
    ORDER BY column_name`];
  assert.deepEqual(columns, [
    { column_name: 'expires_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
    { column_name: 'state_hash', data_type: 'text', is_nullable: 'NO' }
  ]);
  const indexes = await db`SELECT indexname, indexdef FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'oauth_state_consumptions'`;
  assert.ok(indexes.some(row => row.indexname === 'oauth_state_consumptions_expires_at_idx'
    && row.indexdef.endsWith('(expires_at)')));
  assert.ok(indexes.some(row => row.indexdef.includes('UNIQUE') && row.indexdef.endsWith('(state_hash)')));
  await db`INSERT INTO oauth_state_consumptions VALUES (repeat('a', 64), '2099-01-01T00:00:00Z')`;
  await assert.rejects(db`INSERT INTO oauth_state_consumptions VALUES (repeat('a', 64), '2099-01-02T00:00:00Z')`, { code: '23505' });
  await assert.rejects(db`INSERT INTO oauth_state_consumptions VALUES (repeat('b', 64), NULL)`, { code: '23502' });
}

test('fresh migration creates only the hashed-state key and indexed signed expiry', async () => {
  await withDatabase(async db => {
    await migrateLegacy(db);
    await assertOAuthSchema(db);
  });
});

test('OAuth expansion preserves every restored row, active session and migration hash', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'momo-db-oauth-prefix-'));
  try {
    cpSync('./drizzle', folder, { recursive: true });
    const journal = JSON.parse(readFileSync('./drizzle/meta/_journal.json', 'utf8'));
    const expectedMigrationCount = legacyIdentityMigrationCount;
    journal.entries = journal.entries.filter(entry => entry.idx <= 70);
    writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify(journal));
    await withDatabase(async (source, name) => {
      await migrate(drizzle(source), { migrationsFolder: folder });
      await resetFixtures(source);
      await source`INSERT INTO app_sessions(id_hash, account_id, csrf_secret_hash, expires_at)
        VALUES ('preserved-session-hash', 'notification-account', 'preserved-csrf-hash', '2099-01-01T00:00:00Z')`;
      const before = await snapshotDatabase(source);
      const backup = docker(['pg_dump', '-U', username, '--format=custom', '--no-owner', '--no-acl', name]);
      await withDatabase(async (copy, restored) => {
        docker(['pg_restore', '-U', username, '--exit-on-error', '--no-owner', '--no-acl', '-d', restored], backup);
        assert.deepEqual(await snapshotDatabase(copy), before);
        await migrateLegacy(copy);
        const after = await snapshotDatabase(copy);
        assert.deepEqual(after.rows, { ...expectedFencingCounterRows(expectedPublicIdentifierRows(before.rows)), oauth_state_consumptions: [] });
        assert.deepEqual(after.history.slice(0, before.history.length), before.history);
        assert.equal(after.history.length, expectedMigrationCount);
        await assertOAuthSchema(copy);
      });
    });
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
