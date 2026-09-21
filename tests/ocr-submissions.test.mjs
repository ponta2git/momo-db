import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { createTestClient, resetFixtures } from './notification-fixtures.mjs';

const db = createTestClient();
const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const rejected = code => error => error.code === code;
beforeEach(async () => {
  await db`TRUNCATE ocr_submissions CASCADE`;
  await resetFixtures(db);
});
after(() => db.end());
const header = (key = id) => db`INSERT INTO ocr_submissions
  (id, owner_account_id, match_draft_id, admission_deadline)
  VALUES (${key}, 'notification-account', 'notification-draft', now() + interval '10 minutes')`;
const member = (key = id, screen = 'total_assets', hash = 'a'.repeat(64)) => db`INSERT INTO ocr_submission_members
  (submission_id, screen_type, upload_idempotency_key_hash, image_sha256_hex, image_byte_length)
  VALUES (${key}, ${screen}, ${hash}, ${'b'.repeat(64)}, 100)`;

test('submission identity survives source deletion and is retained with its owner', async () => {
  await header();
  await member();
  await assert.rejects(header(), rejected('23505'));
  await db`INSERT INTO momo_login_accounts(id, discord_user_id, display_name)
    VALUES ('submission-owner', 'submission-owner-user', 'Submission owner') ON CONFLICT DO NOTHING`;
  await db`UPDATE ocr_submissions SET owner_account_id = 'submission-owner' WHERE id = ${id}`;
  await db`DELETE FROM match_drafts WHERE id = 'notification-draft'`;
  assert.equal((await db`SELECT match_draft_id FROM ocr_submissions WHERE id = ${id}`)[0].match_draft_id, 'notification-draft');
  await assert.rejects(db`DELETE FROM momo_login_accounts WHERE id = 'submission-owner'`, error => error.code === '23001' && error.constraint_name.includes('ocr_submissions'));
  await assert.rejects(member(id, 'revenue'), rejected('23505'));
  await assert.rejects(member(other), rejected('23503'));
});

test('native shape checks reject malformed identities, states, time and image membership', async () => {
  for (const key of ['not-a-uuid', id + '\n', id.toUpperCase().replace('11111111', 'AAAAAAAA')]) {
    await assert.rejects(header(key), rejected('23514'));
  }
  await header();
  await member();
  for (const update of [
    db`UPDATE ocr_submissions SET status = 'settled' WHERE id = ${id}`,
    db`UPDATE ocr_submissions SET status = 'unknown' WHERE id = ${id}`,
    db`UPDATE ocr_submissions SET ocr_hints_json = '[]' WHERE id = ${id}`,
    db`UPDATE ocr_submissions SET admission_deadline = created_at WHERE id = ${id}`,
    db`UPDATE ocr_submission_members SET screen_type = 'unknown' WHERE submission_id = ${id}`,
    db`UPDATE ocr_submission_members SET status = 'failed' WHERE submission_id = ${id}`,
    db`UPDATE ocr_submission_members SET image_byte_length = 3145729 WHERE submission_id = ${id}`,
    db`UPDATE ocr_submission_members SET image_sha256_hex = ${'b'.repeat(64) + '\n'} WHERE submission_id = ${id}`,
  ]) await assert.rejects(update, rejected('23514'));
  await db`UPDATE ocr_submission_members SET status = 'failed', failure_code = 'admission_timeout' WHERE submission_id = ${id}`;
  await db`UPDATE ocr_submissions SET status = 'settled', finished_at = now() WHERE id = ${id}`;
});

test('registered members have one retained job and no admission failure', async () => {
  await header();
  await header(other);
  await member();
  await member(other);
  await db`INSERT INTO ocr_jobs (id, draft_id, image_id, image_path, status, requested_screen_type) VALUES ('submission-job', 'ocr-draft', 'image', '/test/image.png', 'failed', 'total_assets')`;
  await db`UPDATE ocr_submission_members SET status = 'registered', job_id = 'submission-job' WHERE submission_id = ${id}`;
  await assert.rejects(db`UPDATE ocr_submission_members SET status = 'registered', job_id = 'submission-job' WHERE submission_id = ${other}`, rejected('23505'));
  await assert.rejects(db`UPDATE ocr_submission_members SET failure_code = 'admission_failed' WHERE submission_id = ${id}`, rejected('23514'));
  await assert.rejects(db`DELETE FROM ocr_jobs WHERE id = 'submission-job'`, rejected('23001'));
});

test('submission schema adds no application policy functions or triggers', async () => {
  const functions = await db`SELECT proname FROM pg_proc JOIN pg_namespace ON pg_namespace.oid = pronamespace
    WHERE nspname = 'public' AND proname LIKE '%ocr_submission%'`;
  const triggers = await db`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal
    AND tgrelid IN ('ocr_submissions'::regclass, 'ocr_submission_members'::regclass)`;
  assert.deepEqual([...functions], []);
  assert.deepEqual([...triggers], []);
});
