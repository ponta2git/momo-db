import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createTestClient, envelope, resetFixtures } from './notification-fixtures.mjs';
import { docker, expectedFencingCounterRows, expectedJobSchedulerRows, expectedLoginAccountRoles, expectedPublicIdentifierRows, retiredQueueTables, snapshotDatabase, username } from './migration-fixtures.mjs';

test('0056 preserves every existing row and migration hash after backup/restore, including OCR v1 history', async () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const source = 'momo_db_test_ocr_before_' + suffix;
  const restored = 'momo_db_test_ocr_restore_' + suffix;
  const prefix = mkdtempSync(join(tmpdir(), 'momo-db-ocr-prefix-'));
  const created = [];
  let db; let copy;
  try {
    cpSync('./drizzle', prefix, { recursive: true });
    const journalPath = join(prefix, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    journal.entries = journal.entries.filter(entry => entry.idx <= 55);
    writeFileSync(journalPath, JSON.stringify(journal));
    docker(['createdb', '-U', username, source]); created.push(source);
    db = createTestClient(source);
    await migrate(drizzle(db), { migrationsFolder: prefix });
    await resetFixtures(db);
    await db`INSERT INTO ocr_jobs(id, draft_id, image_id, image_path, requested_screen_type, status)
      VALUES ('historical-job', 'historical-ocr', 'historical-image', '/test/historical.png', 'total_assets', 'succeeded')`;
    const payload = await envelope(db, 'ocr_completed', 'historical-job');
    await db`INSERT INTO discord_notifications(id, family, kind, dedupe_key, schema_version, payload, payload_hash, status, terminal_at)
      VALUES (${payload.notificationId}, 'result', 'ocr_completed', ${payload.notificationId}, 1, ${JSON.stringify(payload)}::text::jsonb, ${'a'.repeat(64)}, 'DELIVERED', now())`;
    await db`INSERT INTO discord_notification_results(notification_id, kind, source_job_id, occurred_at, settings_generation)
      VALUES (${payload.notificationId}, 'ocr_completed', 'historical-job', now(), 0)`;
    const tables = (await db`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`).map(row => row.tablename);
    const before = await snapshotDatabase(db, tables);
    const backup = docker(['pg_dump', '-U', username, '--format=custom', '--no-owner', '--no-acl', source]);
    docker(['createdb', '-U', username, restored]); created.push(restored);
    docker(['pg_restore', '-U', username, '--exit-on-error', '--no-owner', '--no-acl', '-d', restored], backup);
    copy = createTestClient(restored);
    assert.deepEqual(await snapshotDatabase(copy, tables), before);
    await migrate(drizzle(copy), { migrationsFolder: './drizzle' });
    const after = await snapshotDatabase(copy, tables.filter(table => !retiredQueueTables.includes(table)));
    assert.equal(after.history.length, JSON.parse(readFileSync('./drizzle/meta/_journal.json', 'utf8')).entries.length);
    assert.deepEqual(after.history.slice(0, before.history.length), before.history);
    assert.deepEqual(after.rows, {
      ...expectedFencingCounterRows(expectedPublicIdentifierRows(expectedJobSchedulerRows(before.rows))),
      momo_login_accounts: expectedLoginAccountRoles(before.rows.momo_login_accounts)
    }, 'Existing rows must change only by the documented role, scheduler and public identifier transitions');
    assert.equal((await copy`SELECT count(*)::int AS n FROM ocr_submissions`)[0].n, 0);
    assert.equal((await copy`SELECT count(*)::int AS n FROM ocr_submission_members`)[0].n, 0);
  } finally {
    await Promise.allSettled([db?.end(), copy?.end()]);
    const failures = [];
    for (const name of created.reverse()) {
      try { docker(['dropdb', '-U', username, name]); } catch (error) { failures.push(error); }
    }
    rmSync(prefix, { recursive: true, force: true });
    if (failures.length) throw new AggregateError(failures, 'Disposable database cleanup failed');
  }
});
