import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createTestClient, resetFixtures } from './notification-fixtures.mjs';
import { docker, username } from './migration-fixtures.mjs';

const previousIndex = 61;
const finalIndex = 64;
const journal = () => JSON.parse(readFileSync('./drizzle/meta/_journal.json', 'utf8'));

async function withDatabase(run) {
  const name = 'momo_db_test_roles_' + randomUUID().replaceAll('-', '').slice(0, 12);
  docker(['createdb', '-U', username, name]);
  const db = createTestClient(name);
  try { return await run(db, name); }
  finally { await db.end(); docker(['dropdb', '-U', username, name]); }
}

async function migratePrevious(db) {
  const folder = mkdtempSync(join(tmpdir(), 'momo-db-role-prefix-'));
  try {
    cpSync('./drizzle', folder, { recursive: true });
    const prefix = journal();
    prefix.entries = prefix.entries.filter(entry => entry.idx <= previousIndex);
    writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify(prefix));
    await migrate(drizzle(db), { migrationsFolder: folder });
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

async function seedAccounts(db) {
  await resetFixtures(db);
  for (const admin of [false, true]) {
    for (const enabled of [false, true]) {
      for (const linked of [false, true]) {
        const id = `role-${admin ? 'admin' : 'user'}-${enabled ? 'enabled' : 'disabled'}-${linked ? 'linked' : 'unlinked'}`;
        const memberId = linked ? id + '-member' : null;
        if (linked) {
          await db`INSERT INTO members(id, user_id, display_name)
            VALUES (${memberId}, ${id + '-member-user'}, 'ロール移行のプレーヤー')`;
        }
        await db`INSERT INTO momo_login_accounts(id, discord_user_id, display_name, player_member_id,
          login_enabled, is_admin, created_at, updated_at)
          VALUES (${id}, ${id + '-discord'}, ${'移行対象 ' + id}, ${memberId}, ${enabled}, ${admin},
            '2025-10-11T01:02:03.456789Z', '2026-01-02T04:05:06.987654Z')`;
        await db`INSERT INTO app_sessions(id_hash, member_id, account_id, csrf_secret_hash,
          created_at, last_seen_at, expires_at)
          VALUES (${id + '-session'}, ${memberId}, ${id}, 'role-test-csrf-hash',
            '2026-01-01T00:00:00.000001Z', '2026-01-02T00:00:00.000002Z', '2099-01-01T00:00:00Z')`;
        await db`INSERT INTO idempotency_keys(key, member_id, account_id, endpoint, request_hash,
          response_status, response_headers, response_body, expires_at)
          VALUES ('role-test-key', ${memberId}, ${id}, '/role-test', ${Buffer.from('request')},
            201, '{"content-type":"application/json"}'::jsonb, ${Buffer.from('{"accepted":true}')},
            '2099-01-01T00:00:00Z')`;
        await db`INSERT INTO match_drafts(id, created_by_account_id, status)
          VALUES (${id + '-draft'}, ${id}, 'draft_ready')`;
        await db`INSERT INTO series_analysis_operation_requests(id, scope, game_title_id,
          requested_by_account_id, idempotency_key_hash, endpoint, status, target_count)
          VALUES (${id + '-analysis'}, 'title', 'notification-title', ${id}, ${id + '-key'},
            '/role-test-analysis', ${enabled ? 'running' : 'pending'}, 1)`;
      }
    }
  }
}

async function snapshot(db) {
  const rows = {};
  const tables = await db`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
  for (const { tablename } of tables) {
    const values = tablename === 'momo_login_accounts'
      ? await db`SELECT to_jsonb(record) AS value FROM ${db(tablename)} record ORDER BY id`
      : await db`SELECT to_jsonb(record) AS value FROM ${db(tablename)} record ORDER BY to_jsonb(record)::text`;
    rows[tablename] = values.map(row => row.value);
  }
  return {
    rows,
    history: [...await db`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`]
  };
}

function mappedAccounts(accounts) {
  return accounts.map(({ is_admin, ...account }) => ({ ...account, role: is_admin ? 'admin' : 'user' }));
}

async function accountColumns(db) {
  return [...await db`SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'momo_login_accounts'
    ORDER BY column_name`];
}

test('role migration preserves restored accounts, sessions, references and history; rerun and legacy errors leave no partial writes', async () => {
  await withDatabase(async (source, name) => {
    await migratePrevious(source);
    await seedAccounts(source);
    const before = await snapshot(source);
    const backup = docker(['pg_dump', '-U', username, '--format=custom', '--no-owner', '--no-acl', name]);
    await withDatabase(async (copy, restored) => {
      docker(['pg_restore', '-U', username, '--exit-on-error', '--no-owner', '--no-acl', '-d', restored], backup);
      assert.deepEqual(await snapshot(copy), before, 'The restored fixture must match the entire original database');
      await migrate(drizzle(copy), { migrationsFolder: './drizzle' });
      const after = await snapshot(copy);
      assert.deepEqual(after.rows, {
        ...before.rows,
        momo_login_accounts: mappedAccounts(before.rows.momo_login_accounts)
      }, 'Only is_admin to role may change; account values and every session/reference must survive');
      assert.equal(after.history.length, journal().entries.length);
      assert.deepEqual(after.history.slice(0, before.history.length), before.history);
      assert.equal(after.rows.momo_login_accounts.filter(account => account.role === 'operator').length, 0);

      const [assigned] = await copy`UPDATE momo_login_accounts SET role = 'operator'
        WHERE id = 'role-user-enabled-unlinked' RETURNING role`;
      assert.equal(assigned.role, 'operator');
      const beforeRerun = await snapshot(copy);
      await migrate(drizzle(copy), { migrationsFolder: './drizzle' });
      assert.deepEqual(await snapshot(copy), beforeRerun,
        'A second migrate call must preserve a subsequent operator assignment without backfilling or appending history');
      await assert.rejects(copy`SELECT is_admin FROM momo_login_accounts`, { code: '42703' });
      await assert.rejects(copy.begin(async tx => {
        await tx`DELETE FROM app_sessions WHERE account_id = 'role-admin-enabled-linked'`;
        await tx`UPDATE momo_login_accounts SET display_name = 'must roll back'
          WHERE id = 'role-admin-enabled-linked'`;
        await tx`UPDATE momo_login_accounts SET is_admin = false WHERE id = 'role-admin-enabled-linked'`;
      }), { code: '42703' });
      assert.deepEqual(await snapshot(copy), beforeRerun, 'A rejected legacy transaction must not delete sessions or alter accounts');
    });
  });
});

test('fresh migrations expose only the three non-null roles, default to user and remove the legacy column and index', async () => {
  await withDatabase(async db => {
    await migrate(drizzle(db), { migrationsFolder: './drizzle' });
    const columns = await accountColumns(db);
    assert.equal(columns.some(column => column.column_name === 'is_admin'), false);
    const role = columns.find(column => column.column_name === 'role');
    assert.deepEqual(role, { column_name: 'role', data_type: 'text', is_nullable: 'NO', column_default: "'user'::text" });
    assert.equal((await db`SELECT to_regclass('public.momo_login_accounts_is_admin_idx') AS legacy`)[0].legacy, null);
    const indexes = await db`SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'momo_login_accounts'`;
    for (const name of ['momo_login_accounts_player_member_id_idx', 'momo_login_accounts_login_enabled_idx']) {
      assert.ok(indexes.some(index => index.indexname === name), `Existing index ${name} must remain`);
    }
    assert.equal((await db`SELECT count(*)::int AS n FROM momo_login_accounts WHERE role = 'operator'`)[0].n, 0);
    for (const value of ['user', 'operator', 'admin']) {
      const [created] = await db`INSERT INTO momo_login_accounts(id, discord_user_id, display_name, role)
        VALUES (${'fresh-' + value}, ${'fresh-' + value}, 'Fresh role', ${value}) RETURNING role`;
      assert.equal(created.role, value);
    }
    const [created] = await db`INSERT INTO momo_login_accounts(id, discord_user_id, display_name)
      VALUES ('fresh-default', 'fresh-default', 'Default role') RETURNING role`;
    assert.equal(created.role, 'user');
    for (const [value, code] of [['owner', '23514'], ['', '23514'], [null, '23502']]) {
      await assert.rejects(db`INSERT INTO momo_login_accounts(id, discord_user_id, display_name, role)
        VALUES ('fresh-invalid', 'fresh-invalid', 'Invalid role', ${value})`, { code });
      await assert.rejects(db`UPDATE momo_login_accounts SET role = ${value} WHERE id = 'fresh-default'`, { code });
    }
    assert.equal((await db`SELECT role FROM momo_login_accounts WHERE id = 'fresh-default'`)[0].role, 'user');
  });
});

async function waitForMigrationLock(db, writerPid, migrationFinished) {
  const deadline = Date.now() + 3000;
  do {
    const waiting = await db`SELECT l.pid FROM pg_locks l
      WHERE l.locktype = 'relation' AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND l.relation = 'public.momo_login_accounts'::regclass AND l.mode = 'AccessExclusiveLock'
        AND NOT l.granted AND ${writerPid} = ANY(pg_blocking_pids(l.pid))`;
    if (waiting.length) return;
    assert.equal(migrationFinished(), false, 'The migration must wait for the uncommitted legacy writer');
  } while (Date.now() < deadline);
  assert.fail('The migration did not enter the expected DDL lock wait');
}

test('the real migrator waits for a legacy transaction and maps its newly committed update and insert', async () => {
  await withDatabase(async (db, name) => {
    await migratePrevious(db);
    await seedAccounts(db);
    const writer = createTestClient(name);
    const migrationClient = createTestClient(name);
    const writerReady = Promise.withResolvers();
    const releaseWriter = Promise.withResolvers();
    const writerTask = writer.begin(async tx => {
      await tx`UPDATE momo_login_accounts SET is_admin = true, display_name = 'Committed immediately before migration'
        WHERE id = 'role-user-enabled-unlinked'`;
      await tx`INSERT INTO momo_login_accounts(id, discord_user_id, display_name, is_admin)
        VALUES ('role-late-created', 'role-late-created', 'Created by the legacy writer', true)`;
      writerReady.resolve((await tx`SELECT pg_backend_pid() AS pid`)[0].pid);
      await releaseWriter.promise;
    });
    // Report early writer errors to the handshake without leaving an unhandled rejection.
    writerTask.catch(error => writerReady.reject(error));
    let migrationTask;
    let migrationFinished = false;
    try {
      const writerPid = await writerReady.promise;
      migrationTask = migrate(drizzle(migrationClient), { migrationsFolder: './drizzle' });
      migrationTask.then(() => { migrationFinished = true; }, () => { migrationFinished = true; });
      await waitForMigrationLock(db, writerPid, () => migrationFinished);
      releaseWriter.resolve();
      await writerTask;
      await migrationTask;
      const accounts = await db`SELECT id, role, display_name FROM momo_login_accounts
        WHERE id IN ('role-user-enabled-unlinked', 'role-late-created') ORDER BY id`;
      assert.deepEqual([...accounts], [
        { id: 'role-late-created', role: 'admin', display_name: 'Created by the legacy writer' },
        { id: 'role-user-enabled-unlinked', role: 'admin', display_name: 'Committed immediately before migration' }
      ]);
      assert.equal((await db`SELECT count(*)::int AS n FROM momo_login_accounts WHERE role = 'operator'`)[0].n, 0);
    } finally {
      releaseWriter.resolve();
      await Promise.allSettled([writerTask, migrationTask]);
      await Promise.allSettled([writer.end(), migrationClient.end()]);
    }
  });
});

test('failure after backfill, two history rows and final DDL rolls back the complete role migration transaction', async () => {
  await withDatabase(async db => {
    await migratePrevious(db);
    await seedAccounts(db);
    const before = await snapshot(db);
    const columnsBefore = await accountColumns(db);
    const folder = mkdtempSync(join(tmpdir(), 'momo-db-role-failure-'));
    try {
      cpSync('./drizzle', folder, { recursive: true });
      const entries = journal().entries;
      const preceding = entries.filter(entry => entry.idx > previousIndex && entry.idx < finalIndex);
      assert.equal(preceding.length, 2);
      const final = entries.find(entry => entry.idx === finalIndex);
      assert.ok(final, 'The final role migration must exist');
      const path = join(folder, final.tag + '.sql');
      const failure = 'forced role migration failure after final DDL';
      // Only the disposable copy is instrumented. These checks prove the test
      // reached the backfill and both preceding ledger INSERTs before failing.
      const checkpoint = `DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM public.momo_login_accounts
          WHERE role IS DISTINCT FROM CASE WHEN is_admin THEN 'admin' ELSE 'user' END) THEN
          RAISE EXCEPTION 'role backfill checkpoint was not reached';
        END IF;
        IF (SELECT count(*) FROM drizzle.__drizzle_migrations
          WHERE created_at IN (${preceding.map(entry => entry.when).join(',')})) <> 2 THEN
          RAISE EXCEPTION 'role migration history checkpoint was not reached';
        END IF;
      END $$;\n--> statement-breakpoint\n`;
      writeFileSync(path, checkpoint + readFileSync(path, 'utf8') +
        `\n--> statement-breakpoint\nDO $$ BEGIN RAISE EXCEPTION '${failure}'; END $$;\n`);
      await assert.rejects(migrate(drizzle(db), { migrationsFolder: folder }), error =>
        error.cause?.code === 'P0001' && error.cause?.message === failure);
      assert.deepEqual(await snapshot(db), before, 'Rows and all new migration history entries must roll back together');
      assert.deepEqual(await accountColumns(db), columnsBefore, 'Only the original is_admin schema must remain');
      assert.equal((await db`SELECT to_regclass('public.momo_login_accounts_is_admin_idx') AS legacy`)[0].legacy,
        'momo_login_accounts_is_admin_idx');
      await db`UPDATE momo_login_accounts SET is_admin = true WHERE id = 'role-user-enabled-unlinked'`;
      assert.equal((await db`SELECT is_admin FROM momo_login_accounts WHERE id = 'role-user-enabled-unlinked'`)[0].is_admin, true);
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
});
