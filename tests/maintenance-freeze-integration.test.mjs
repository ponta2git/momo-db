import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createTestClient } from './notification-fixtures.mjs';
import { migrateThrough } from './migration-prefix.mjs';
import { docker, username } from './migration-fixtures.mjs';
import { connect, fingerprint } from '../scripts/migration/database.mjs';
import { inspectConvergence, isConverged, readConvergence } from '../scripts/maintenance/freeze-database.mjs';

test('real old-schema stop inspection is read-only, retains future attendance, and detects unresolved sends/transactions', async () => {
  const name = 'momo_db_test_freeze_' + randomUUID().replaceAll('-', '').slice(0, 12);
  const role = 'freeze_reader_' + randomUUID().replaceAll('-', '').slice(0, 12);
  docker(['createdb', '-U', username, name]);
  const sql = createTestClient(name);
  const url = new URL(`postgresql://127.0.0.1:${process.env.MOMO_DB_TEST_PORT ?? 5432}/${name}`);
  url.username = username;
  if (process.env.MOMO_DB_TEST_PASSWORD) url.password = process.env.MOMO_DB_TEST_PASSWORD;
  let roleCreated = false;
  const saved = async () => {
    const client = connect(url.toString());
    try { return await client.begin('isolation level repeatable read read only', fingerprint); }
    finally { await client.end(); }
  };
  try {
    await migrateThrough(sql, 93);
    await sql`INSERT INTO discord_notifications(id, family, kind, dedupe_key, payload, payload_hash, next_attempt_at)
      VALUES ('future', 'attendance', 'send_message', 'future', '{}'::jsonb, ${'a'.repeat(64)}, now() + interval '1 year')`;
    const baseline = await saved();
    let report = await readConvergence(url.toString());
    assert.equal(isConverged(report, true), true);
    assert.equal(report.retainedPendingAttendance, '1');
    assert.deepEqual(await saved(), baseline);
    await sql`UPDATE worker_execution_slots SET preempt_requested_by = 'fixture', preempt_requested_at = now()`;
    report = await readConvergence(url.toString());
    assert.equal(report.pending.executionSlot, '1');
    assert.equal(isConverged(report), false);
    await sql`UPDATE worker_execution_slots SET preempt_requested_by = NULL, preempt_requested_at = NULL`;
    await sql`INSERT INTO discord_notification_parts(notification_id, part_no, status, claim_token, send_started_at)
      VALUES ('future', 0, 'IN_FLIGHT', ${randomUUID()}, now())`;
    report = await readConvergence(url.toString());
    assert.equal(report.pending.notificationSends, '1');
    assert.equal(isConverged(report), false);
    await sql`UPDATE discord_notification_parts SET status = 'DELIVERED', delivered_at = now(), delivered_message_id = 'fixture'`;
    assert.equal(isConverged(await readConvergence(url.toString())), true);
    await sql`INSERT INTO discord_notifications(id, family, kind, dedupe_key, payload, payload_hash)
      VALUES ('result', 'result', 'ocr_completed', 'result', '{}'::jsonb, ${'b'.repeat(64)})`;
    report = await readConvergence(url.toString());
    assert.equal(report.pending.resultNotifications, '1');
    await sql`UPDATE discord_notifications SET status = 'FAILED', terminal_at = now() WHERE id = 'result'`;
    await sql.begin(async tx => {
      await tx`SELECT 1`;
      report = await readConvergence(url.toString());
      assert.equal(isConverged(report), true);
      assert.equal(isConverged(report, true), false);
      assert.ok(BigInt(report.activeTransactions) > 0n);
    });
    assert.equal(isConverged(await readConvergence(url.toString()), true), true);
    await sql.unsafe(`CREATE ROLE "${role}" NOLOGIN`); roleCreated = true;
    await sql.unsafe(`GRANT USAGE ON SCHEMA public, drizzle TO "${role}";
      GRANT SELECT ON ALL TABLES IN SCHEMA public, drizzle TO "${role}"`);
    const asRole = () => sql.begin('isolation level repeatable read read only', async tx => {
      await tx.unsafe(`SET LOCAL ROLE "${role}"`);
      return inspectConvergence(tx, url.toString());
    });
    await assert.rejects(asRole(), { code: 'ALL_DATABASE_SESSIONS_MUST_BE_VISIBLE' });
    await sql.unsafe(`GRANT pg_read_all_stats TO "${role}"`);
    // The caller's read-only transaction is intentionally visible in this test.
    assert.equal(isConverged(await asRole()), true);
    await sql`ALTER TABLE ocr_submissions ENABLE ROW LEVEL SECURITY`;
    await assert.rejects(asRole(), { code: 'UNFILTERED_WRITER_TABLE_REQUIRED' });
    await sql`ALTER TABLE ocr_submissions DISABLE ROW LEVEL SECURITY`;
    await sql.unsafe(`REVOKE SELECT ON ocr_submissions FROM "${role}"`);
    await assert.rejects(asRole(), error => error.code === '42501');
  } finally {
    if (roleCreated) {
      await sql.unsafe(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`);
    }
    await sql.end(); docker(['dropdb', '-U', username, name]);
  }
});

test('an absent global slot is accepted only with the exact complete retirement ledger', async () => {
  const name = 'momo_db_test_freeze_retired_' + randomUUID().replaceAll('-', '').slice(0, 12);
  docker(['createdb', '-U', username, name]);
  const sql = createTestClient(name);
  const url = new URL(`postgresql://127.0.0.1:${process.env.MOMO_DB_TEST_PORT ?? 5432}/${name}`);
  url.username = username;
  if (process.env.MOMO_DB_TEST_PASSWORD) url.password = process.env.MOMO_DB_TEST_PASSWORD;
  try {
    await migrate(drizzle(sql), { migrationsFolder: './drizzle' });
    const [slot] = await sql`SELECT to_regclass('public.worker_execution_slots') AS name`;
    assert.equal(slot.name, null);
    const before = await sql.begin('isolation level repeatable read read only', fingerprint);
    const report = await readConvergence(url.toString());
    assert.equal(report.pending.executionSlot, '0');
    assert.equal(isConverged(report, true), true);
    assert.deepEqual(await sql.begin('isolation level repeatable read read only', fingerprint), before);
    const [last] = await sql`SELECT id, hash, created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 1`;
    await sql`UPDATE drizzle.__drizzle_migrations SET hash = ${'f'.repeat(64)} WHERE id = ${last.id}`;
    await assert.rejects(readConvergence(url.toString()), { code: 'RETIRED_SLOT_HISTORY_REQUIRED' });
    await sql`UPDATE drizzle.__drizzle_migrations SET hash = ${last.hash}, created_at = ${String(BigInt(last.created_at) + 1n)} WHERE id = ${last.id}`;
    await assert.rejects(readConvergence(url.toString()), { code: 'RETIRED_SLOT_HISTORY_REQUIRED' });
    await sql`UPDATE drizzle.__drizzle_migrations SET created_at = ${last.created_at} WHERE id = ${last.id}`;
    await sql`DELETE FROM drizzle.__drizzle_migrations WHERE id = ${last.id}`;
    await assert.rejects(readConvergence(url.toString()), { code: 'RETIRED_SLOT_HISTORY_REQUIRED' });
    await sql`DELETE FROM drizzle.__drizzle_migrations WHERE id = (SELECT max(id) FROM drizzle.__drizzle_migrations)`;
    await assert.rejects(readConvergence(url.toString()), { code: 'RETIRED_SLOT_HISTORY_REQUIRED' });
  } finally { await sql.end(); docker(['dropdb', '-U', username, name]); }
});
