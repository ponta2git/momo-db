import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createTestClient } from './notification-fixtures.mjs';
import { docker, username } from './migration-fixtures.mjs';
import { migrateThrough, withMigrationPrefix } from './migration-prefix.mjs';
import { seedCanonicalSource } from './canonical-identity-fixtures.mjs';
import { inspectSchema } from '../scripts/migration/inventory.mjs';
import { schemaStructure } from '../scripts/migration/schema.mjs';

const fullHistory = db => migrate(drizzle(db), { migrationsFolder: './drizzle' });
const failure = error => error.cause ?? error;
const at = '2040-01-01T00:00:00.123456Z';
async function isolated(run) {
  const name = 'momo_db_test_attendance_' + randomUUID().replaceAll('-', '').slice(0, 12);
  docker(['createdb', '-U', username, name]);
  const db = createTestClient(name);
  try { return await run(db, name); }
  finally { await db.end(); docker(['dropdb', '-U', username, name]); }
}
async function session(db, overrides = {}) {
  const id = randomUUID();
  const values = {
    id, legacy_id: id, week_key: '2040-W01', candidate_date_iso: '2040-01-06',
    status: 'COMPLETED', channel_id: 'channel:retained', deadline_at: at,
    created_at: at, updated_at: at, ...overrides
  };
  await db`INSERT INTO sessions ${db(values)}`;
  return values;
}
async function notice(db, owner, overrides = {}) {
  const id = randomUUID();
  const values = {
    id, dedupe_key: id, family: 'attendance', kind: 'send_message', status: 'DELIVERED',
    payload: { kind: 'send_message', extra: { invokerUserId: 'actor:retained' } },
    payload_hash: 'a'.repeat(64), created_at: at, updated_at: at, ...overrides
  };
  // A rejected link must not leave an orphan parent that contaminates later assertions.
  await db.begin(async tx => {
    await tx`INSERT INTO discord_notifications ${tx({ ...values, payload: values.payload === null ? null : JSON.stringify(values.payload) })}`;
    await tx`INSERT INTO discord_notification_attendance ${tx({ notification_id: id,
      aggregate_revision: 1, ordinal: 0, ...owner })}`;
  });
  return values;
}
async function snapshot(db, projectOldColumns = false) {
  return db.begin('isolation level repeatable read read only', async sql => {
    await sql.unsafe("SET LOCAL search_path=pg_catalog,public; SET LOCAL timezone='UTC'");
    const rows = {};
    for (const { tablename } of await sql`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`) {
      if (projectOldColumns && tablename === 'weekly_ask_schedules') continue;
      let value = sql`to_jsonb(record)`;
      if (projectOldColumns && tablename === 'sessions') value = sql`${value} - ARRAY['source','parent_session_id','request_id','occupies_date']`;
      if (projectOldColumns && tablename === 'discord_notification_attendance') value = sql`${value} - 'week_key'`;
      rows[tablename] = (await sql`SELECT (${value})::text COLLATE "C" AS value FROM ${sql(tablename)} record ORDER BY value`).map(row => row.value);
    }
    return { rows, schema: schemaStructure(await inspectSchema(sql)),
      history: [...await sql`SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id`] };
  });
}
async function representative(db) {
  await migrateThrough(db, 82);
  await seedCanonicalSource(db);
  await migrateThrough(db, 102);
  // The old application's own completed work is the pre-cutover fixture.
  await db`UPDATE sessions SET status='COMPLETED'`;
  await db`UPDATE discord_notifications SET status='DELIVERED' WHERE family='attendance'`;
  const sentinel = await session(db, { status: 'SKIPPED', cancel_reason: 'manual_skip', revision: 1 });
  await notice(db, { session_id: sentinel.legacy_id }, { dedupe_key: 'cancel-week-notice-' + sentinel.week_key });
  const realSkipped = await session(db, { week_key: '2040-W02', candidate_date_iso: '2040-01-13',
    status: 'SKIPPED', cancel_reason: 'manual_skip', revision: 9, ask_message_id: 'ask:retained' });
  await notice(db, { session_id: realSkipped.legacy_id }, { dedupe_key: 'cancel-week-notice-' + realSkipped.week_key,
    payload: null, purged_at: at });
  const postponed = await session(db, { week_key: '2040-W03', candidate_date_iso: '2040-01-20', status: 'POSTPONED' });
  await session(db, { week_key: postponed.week_key, candidate_date_iso: '2040-01-21', postpone_count: 1, status: 'SKIPPED' });
  await notice(db, { session_id: null }, { dedupe_key: 'deleted-session-notice' });
  return { sentinel, realSkipped };
}

test('attendance tail preserves restored IDs, precise values, history and references', async () => isolated(async (source, sourceName) => {
  const { sentinel, realSkipped } = await representative(source);
  const before = await snapshot(source);
  const backup = docker(['pg_dump', '-U', username, '--format=custom', '--no-owner', '--no-acl', sourceName]);
  await isolated(async (copy, copyName) => {
    docker(['pg_restore', '-U', username, '--exit-on-error', '--no-owner', '--no-acl', '-d', copyName], backup);
    assert.deepEqual(await snapshot(copy), before, 'backup must restore every original value and schema object');
    await fullHistory(copy);
    const after = await snapshot(copy, true);
    assert.deepEqual(after.rows, before.rows, 'old columns and every unrelated row remain byte-for-byte equivalent');
    assert.deepEqual(after.history.slice(0, before.history.length), before.history);
    assert.equal(after.history.length, before.history.length + 4);
    const rows = await copy`SELECT legacy_id,source,parent_session_id,request_id,occupies_date FROM sessions ORDER BY legacy_id`;
    for (const row of rows) {
      assert.equal(row.source, 'legacy');
      assert.equal(row.parent_session_id, null);
      assert.equal(row.request_id, null);
      assert.equal(row.occupies_date, row.legacy_id !== sentinel.legacy_id);
    }
    const weeks = await copy`SELECT week_key,auto_session_id,disabled_by,disabled_at::text FROM weekly_ask_schedules ORDER BY week_key`;
    assert.deepEqual(weeks.map(row => [row.week_key, row.auto_session_id, row.disabled_by]), [
      [sentinel.week_key, null, 'actor:retained'], [realSkipped.week_key, null, null], ['2040-W03', null, null]
    ]);
    assert.ok(weeks.every(row => row.disabled_at !== null));
    assert.equal((await copy`SELECT week_key FROM discord_notification_attendance WHERE notification_id='attendance:legacy'`)[0].week_key, null);
    const final = await snapshot(copy);
    await fullHistory(copy);
    assert.deepEqual(await snapshot(copy), final, 're-running the regular migrator is a no-op');
    await isolated(async fresh => {
      await fullHistory(fresh);
      assert.deepEqual((await snapshot(fresh)).schema, final.schema, 'restored and fresh histories have identical final mechanisms');
    });
  });
}));

// Migration SQL must remain self-contained. Verify its independently evaluated
// guard/backfill predicates against observable evidence instead of sharing a
// persistent SQL function or transient state across migration boundaries.
test('only proven skip sentinels release a date across every historical evidence source', async () => isolated(async db => {
  await migrateThrough(db, 102);
  const memberId = randomUUID();
  await db`INSERT INTO members(id,legacy_id,user_id,display_name) VALUES (${memberId},${memberId},'evidence-user','Evidence member')`;
  const evidence = [
    ['ask message', { ask_message_id: 'ask:retained' }],
    ['postpone message', { postpone_message_id: 'postpone:retained' }],
    ['decided start', { decided_start_at: at }],
    ['reminder schedule', { reminder_at: at }],
    ['reminder delivery', { reminder_sent_at: at }],
    ['postponed child', { postpone_count: 1 }],
    ['response', {}], ['held event', {}], ['other attendance notice', {}],
    ['sentinel', {}, false], ['purged sentinel', {}, false]
  ];
  const expected = [];
  for (const [index, [kind, fields, occupiesDate = true]] of evidence.entries()) {
    const row = await session(db, { week_key: 'evidence-week-' + index,
      candidate_date_iso: `2040-02-${String(index + 1).padStart(2, '0')}`,
      status: 'SKIPPED', cancel_reason: 'manual_skip', revision: 1, ...fields });
    await notice(db, { session_id: row.legacy_id }, {
      dedupe_key: 'cancel-week-notice-' + row.week_key,
      ...(kind === 'purged sentinel' ? { payload: null, purged_at: at } : {})
    });
    if (kind === 'response') {
      const id = randomUUID();
      await db`INSERT INTO responses(id,legacy_id,session_id,member_id,choice)
        VALUES (${id},${id},${row.id},${memberId},'ABSENT')`;
    }
    if (kind === 'held event') {
      const id = randomUUID();
      await db`INSERT INTO held_events(id,legacy_id,session_id,held_date_iso,start_at)
        VALUES (${id},${id},${row.id},${row.candidate_date_iso},${at})`;
    }
    if (kind === 'other attendance notice') {
      await notice(db, { session_id: row.legacy_id, aggregate_revision: 0 }, { dedupe_key: 'ask-body-' + row.legacy_id });
    }
    expected.push({ id: row.id, kind, occupiesDate });
  }
  const before = await snapshot(db);
  await fullHistory(db);
  assert.deepEqual((await snapshot(db, true)).rows, before.rows);
  for (const row of expected) {
    const [actual] = await db`SELECT source,occupies_date FROM sessions WHERE id=${row.id}`;
    assert.deepEqual(actual, { source: 'legacy', occupies_date: row.occupiesDate }, row.kind);
  }
}));

test('failure after attendance backfill and constraints rolls back the entire tail and allows retry', async () => isolated(async db => {
  const { sentinel } = await representative(db);
  const before = await snapshot(db);
  await withMigrationPrefix(106, async folder => {
    const file = join(folder, '0106_constrain-attendance-multiple-sessions.sql');
    writeFileSync(file, readFileSync(file, 'utf8') + `\n--> statement-breakpoint\nDO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM public.sessions WHERE NOT occupies_date)
        OR NOT EXISTS (SELECT 1 FROM public.weekly_ask_schedules)
        OR to_regclass('public.sessions_candidate_date_unique') IS NULL
        OR to_regclass('public.sessions_week_key_postpone_count_unique') IS NOT NULL THEN
        RAISE EXCEPTION 'attendance tail checkpoint was not reached';
      END IF;
      RAISE EXCEPTION 'forced failure after attendance constraints';
    END $$;\n`);
    await assert.rejects(migrate(drizzle(db), { migrationsFolder: folder }),
      error => failure(error).message === 'forced failure after attendance constraints');
  });
  assert.deepEqual(await snapshot(db), before, 'rows, constraints and applied migration hashes roll back together');
  await fullHistory(db);
  assert.equal((await db`SELECT occupies_date FROM sessions WHERE id=${sentinel.id}`)[0].occupies_date, false);
  assert.equal((await db`SELECT count(*)::integer AS n FROM weekly_ask_schedules`)[0].n, 3);
}));

for (const status of ['ASKING', 'POSTPONE_VOTING', 'DECIDED', 'CANCELLED']) {
  test(`active legacy ${status} rejects the whole tail unchanged`, async () => isolated(async db => {
    await migrateThrough(db, 102); await session(db, { status });
    const before = await snapshot(db);
    await assert.rejects(fullHistory(db), error => failure(error).message === 'ATTENDANCE_MIGRATION_ACTIVE_SESSION');
    assert.deepEqual(await snapshot(db), before);
  }));
}
for (const status of ['PENDING', 'IN_FLIGHT', 'FAILED']) {
  test(`undelivered legacy attendance ${status} rejects the whole tail unchanged`, async () => isolated(async db => {
    await migrateThrough(db, 102);
    const row = await session(db);
    await notice(db, { session_id: row.legacy_id }, { status, ...(status === 'IN_FLIGHT' ? { claim_token: randomUUID(), claim_expires_at: at } : {}) });
    const before = await snapshot(db);
    await assert.rejects(fullHistory(db), error => failure(error).message === 'ATTENDANCE_MIGRATION_UNDELIVERED_NOTICE');
    assert.deepEqual(await snapshot(db), before);
  }));
}
for (const cancelReason of [null, 'manual_skip']) {
  test(`unproven SKIPPED with ${cancelReason} reason is not silently classified`, async () => isolated(async db => {
    await migrateThrough(db, 102); await session(db, { status: 'SKIPPED', cancel_reason: cancelReason, revision: 1 });
    const before = await snapshot(db);
    await assert.rejects(fullHistory(db), error => failure(error).message === 'ATTENDANCE_MIGRATION_AMBIGUOUS_SKIP_MARKER');
    assert.deepEqual(await snapshot(db), before);
  }));
}
test('duplicate real candidate dates fail without deleting either historical Session', async () => isolated(async db => {
  await migrateThrough(db, 102);
  await session(db); await session(db, { postpone_count: 1 });
  const before = await snapshot(db);
  await assert.rejects(fullHistory(db), error => failure(error).message === 'ATTENDANCE_MIGRATION_DUPLICATE_CANDIDATE_DATE');
  assert.deepEqual(await snapshot(db), before);
}));
for (const table of ['sessions', 'responses', 'held_events', 'discord_notifications', 'discord_notification_attendance', 'discord_notification_parts']) {
  test(`concurrent ${table} writer prevents migration before any mutation`, async () => isolated(async db => {
    await migrateThrough(db, 102);
    const before = await snapshot(db);
    await db.begin(async sql => {
      await sql`LOCK TABLE ${sql(table)} IN ROW EXCLUSIVE MODE`;
      await assert.rejects(fullHistory(db), error => failure(error).code === '55P03' && failure(error).message.includes('could not obtain lock on relation'));
    });
    assert.deepEqual(await snapshot(db), before);
  }));
}

test('new candidate and active constraints arbitrate concurrent independent writers', async () => isolated(async db => {
  await fullHistory(db);
  const attempts = await Promise.allSettled([
    session(db, { source: 'manual', request_id: 'interaction:1' }),
    session(db, { source: 'manual', request_id: 'interaction:2' })
  ]);
  assert.equal(attempts.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(attempts.find(value => value.status === 'rejected').reason.code, '23505');
  await session(db, { source: 'manual', candidate_date_iso: '2040-01-07' });
  assert.equal((await db`SELECT count(*)::integer AS n FROM sessions`)[0].n, 2, 'same ISO week admits different closed candidate dates');
  for (const [index, status] of ['ASKING', 'POSTPONE_VOTING', 'DECIDED', 'CANCELLED'].entries()) {
    const active = await session(db, { source: 'manual', week_key: '2040-W02', candidate_date_iso: `2040-02-${String(index * 2 + 1).padStart(2, '0')}`, status });
    await assert.rejects(session(db, { source: 'manual', week_key: '2040-W03', candidate_date_iso: `2040-02-${String(index * 2 + 2).padStart(2, '0')}`, status: 'ASKING' }), { code: '23505', constraint_name: 'sessions_active_unique' });
    await db`UPDATE sessions SET status='COMPLETED' WHERE id=${active.id}`;
  }
  const racing = await Promise.allSettled([
    session(db, { source: 'manual', candidate_date_iso: '2040-03-01', status: 'ASKING' }),
    session(db, { source: 'manual', candidate_date_iso: '2040-03-02', status: 'DECIDED' })
  ]);
  assert.equal(racing.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(racing.find(value => value.status === 'rejected').reason.constraint_name, 'sessions_active_unique');
}));

test('creation origin, request, parent and weekly owner identities are independently constrained', async () => isolated(async db => {
  await fullHistory(db);
  const parent = await session(db, { source: 'weekly_auto', request_id: 'interaction:original', status: 'POSTPONED' });
  const child = await session(db, { source: 'postponed', parent_session_id: parent.id, postpone_count: 1, candidate_date_iso: '2040-01-07' });
  await assert.rejects(session(db, { source: 'weekly_auto', candidate_date_iso: '2040-01-08' }), { code: '23505', constraint_name: 'sessions_weekly_auto_unique' });
  await assert.rejects(session(db, { source: 'manual', request_id: 'interaction:original', candidate_date_iso: '2040-01-08' }), { code: '23505', constraint_name: 'sessions_request_id_unique' });
  await assert.rejects(session(db, { source: 'postponed', parent_session_id: parent.id, postpone_count: 1, candidate_date_iso: '2040-01-08' }), { code: '23505', constraint_name: 'sessions_parent_session_id_unique' });
  for (const invalid of [{ source: 'manual', postpone_count: 1 }, { source: 'postponed' }, { source: 'manual', parent_session_id: child.id }, { source: 'manual', occupies_date: false }]) {
    await assert.rejects(session(db, { candidate_date_iso: '2040-01-08', ...invalid }), { code: '23514' });
  }
  await db`INSERT INTO weekly_ask_schedules(week_key,auto_session_id) VALUES (${parent.week_key},${parent.id})`;
  await assert.rejects(db`UPDATE weekly_ask_schedules SET disabled_at=${at} WHERE week_key=${parent.week_key}`, { code: '23514' });
  await db`INSERT INTO weekly_ask_schedules(week_key,disabled_at,disabled_by) VALUES ('2040-W02',${at},'actor:1')`;
  await notice(db, { week_key: '2040-W02' });
  await assert.rejects(notice(db, { week_key: '2040-W02' }), { code: '23505', constraint_name: 'discord_attendance_week_order_unique' });
  await assert.rejects(notice(db, { week_key: '2040-W02', session_id: parent.legacy_id, ordinal: 1 }), { code: '23514' });
  await assert.rejects(notice(db, { week_key: 'missing-week' }), { code: '23503' });
  await assert.rejects(db`DELETE FROM weekly_ask_schedules WHERE week_key='2040-W02'`, { code: '23001' });
  const orphan = await notice(db, { session_id: child.legacy_id });
  await db`DELETE FROM sessions WHERE id=${child.id}`;
  assert.equal((await db`SELECT session_id FROM discord_notification_attendance WHERE notification_id=${orphan.id}`)[0].session_id, null, 'old notice history still survives Session deletion');
}));
