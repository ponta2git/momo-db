import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { buildDiscordNotificationId, isNotificationSourceJobId, parseDiscordNotificationId } from '../dist/notifications.js';
import { createTestClient, resetFixtures } from './notification-fixtures.mjs';

const db = createTestClient();
beforeEach(() => resetFixtures(db));
after(() => db.end());
const rejected = code => error => error.code === code;
const insert = (id, dedupe = id) => db`INSERT INTO discord_notifications
  (id, family, kind, dedupe_key, payload, payload_hash)
  VALUES (${id}, 'result', 'ocr_completed', ${dedupe}, '{}', ${'a'.repeat(64)})`;

test('native uniqueness retains notification, source-job and part identities', async () => {
  const id = buildDiscordNotificationId('ocr_completed', 'schema-job');
  await insert(id);
  await assert.rejects(insert(id), rejected('23505'));
  await assert.rejects(insert('second', id), rejected('23505'));
  await insert('second');
  await db`INSERT INTO discord_notification_results(notification_id, kind, source_job_id, occurred_at, settings_generation)
    VALUES (${id}, 'ocr_completed', 'schema-job', now(), 0)`;
  await assert.rejects(db`INSERT INTO discord_notification_results(notification_id, kind, source_job_id, occurred_at, settings_generation)
    VALUES ('second', 'ocr_completed', 'schema-job', now(), 0)`, rejected('23505'));
  await db`INSERT INTO discord_notification_parts(notification_id, part_no) VALUES (${id}, 0)`;
  await assert.rejects(db`INSERT INTO discord_notification_parts(notification_id, part_no) VALUES (${id}, 0)`, rejected('23505'));
});

test('native foreign keys and shape checks reject orphan or incomplete claim evidence', async () => {
  await assert.rejects(db`INSERT INTO discord_notification_parts(notification_id, part_no) VALUES ('missing', 0)`, rejected('23503'));
  await insert('shape');
  await assert.rejects(db`UPDATE discord_notifications SET status = 'IN_FLIGHT' WHERE id = 'shape'`, rejected('23514'));
  await assert.rejects(db`UPDATE discord_notifications SET payload = NULL WHERE id = 'shape'`, rejected('23514'));
  await assert.rejects(db`UPDATE discord_notifications SET family = 'attendance' WHERE id = 'shape'`, rejected('23514'));
  await assert.rejects(db`INSERT INTO discord_notification_parts(notification_id, part_no, status)
    VALUES ('shape', 0, 'IN_FLIGHT')`, rejected('23514'));
  await assert.rejects(db`UPDATE discord_notification_settings SET generation = -1`, rejected('23514'));
});

test('the schema stores application-owned delivery context and rolls back the whole write', async () => {
  await assert.rejects(db.begin(async tx => {
    await tx`INSERT INTO discord_notifications(id, family, kind, dedupe_key, payload, payload_hash, delivery_context)
      VALUES ('rollback', 'result', 'ocr_completed', 'rollback', '{}', ${'b'.repeat(64)},
        '{"webOrigin":"https://example.test","channelId":"channel"}')`;
    throw new Error('command aborted');
  }), /command aborted/);
  assert.equal((await db`SELECT count(*)::int AS n FROM discord_notifications`)[0].n, 0);
  await insert('context');
  const context = { webOrigin: 'https://example.test', channelId: 'channel' };
  await db`UPDATE discord_notifications SET delivery_context = ${JSON.stringify(context)}::text::jsonb WHERE id = 'context'`;
  assert.deepEqual((await db`SELECT delivery_context FROM discord_notifications WHERE id = 'context'`)[0].delivery_context, context);
});

test('notification transition functions and policy triggers are absent after application cutover', async () => {
  const functions = await db`SELECT proname FROM pg_proc JOIN pg_namespace ON pg_namespace.oid = pronamespace
    WHERE nspname = 'public' AND proname LIKE '%discord%notification%'`;
  const triggers = await db`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'discord_%'`;
  assert.deepEqual([...functions], []);
  assert.deepEqual([...triggers], []);
});

test('notification identities preserve job punctuation and reject trailing or embedded input', () => {
  for (const kind of ['ocr_completed', 'analysis_completed']) {
    for (const job of ['a', 'A0._:-z', 'job:attempt:logical', 'x'.repeat(200)]) {
      const id = `result:${kind}:${job}`;
      assert.equal(buildDiscordNotificationId(kind, job), id);
      assert.deepEqual(parseDiscordNotificationId(id), { kind, sourceJobId: job });
    }
    for (const job of ['', '.job', 'x'.repeat(201), 'job\n', 'job\r', 'job\r\n', 'job\u2028', 'job/1', '試験', 'job x']) {
      assert.equal(isNotificationSourceJobId(job), false);
      assert.equal(parseDiscordNotificationId(`result:${kind}:${job}`), null);
      assert.throws(() => buildDiscordNotificationId(kind, job), /Invalid notification identity/);
    }
  }
  for (const id of ['result:unknown:job', 'attendance:ocr_completed:job', 'result:ocr_completed:', 'result:ocr_completed']) {
    assert.equal(parseDiscordNotificationId(id), null);
  }
  assert.throws(() => buildDiscordNotificationId('unknown', 'job'), /Invalid notification identity/);
});
