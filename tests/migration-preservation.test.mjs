import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createTestClient } from './notification-fixtures.mjs';

// Only new, randomly named databases in an explicitly selected local test
// container are created/dropped. The notification client's host guard also applies.
const container = process.env.MOMO_DB_TEST_CONTAINER;
const username = process.env.MOMO_DB_TEST_USER ?? 'postgres';
if (!container || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container)) {
  throw new Error('Set MOMO_DB_TEST_CONTAINER to the disposable local PostgreSQL test container.');
}

function docker(args, input) {
  const result = spawnSync('docker', ['exec', ...(input ? ['-i'] : []), container, ...args], {
    input, maxBuffer: 32 * 1024 * 1024
  });
  if (result.status !== 0) throw new Error(`Disposable database command failed: ${args[0]} (${result.status})`, { cause: result.error });
  return result.stdout;
}

async function history(db) {
  const [row] = await db`SELECT
    (SELECT jsonb_agg(to_jsonb(h) - 'session_id' ORDER BY id) FROM held_events h) AS held,
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY held_event_id, member_id) FROM held_event_participants p) AS participants,
    (SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM matches m) AS matches,
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY match_id, member_id) FROM match_players p) AS players,
    (SELECT jsonb_agg(to_jsonb(i) ORDER BY match_id, member_id, incident_master_id) FROM match_incidents i) AS incidents,
    (SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM match_drafts d) AS drafts`;
  return { ...row };
}

async function seedExisting(db) {
  await db`INSERT INTO momo_login_accounts(id, discord_user_id, display_name) VALUES ('migration-account','migration-user','Migration account')`;
  for (const i of [1, 2, 3, 4]) {
    await db`INSERT INTO members(id, user_id, display_name) VALUES (${'migration-member-' + i}, ${'migration-user-' + i}, ${'Player ' + i})`;
  }
  await db`INSERT INTO game_titles(id,name,layout_family) VALUES ('migration-title','Migration title','momotetsu_2')`;
  await db`INSERT INTO season_masters(id,game_title_id,name) VALUES ('migration-season','migration-title','Season')`;
  await db`INSERT INTO map_masters(id,game_title_id,name) VALUES ('migration-map','migration-title','Map')`;
  await db`INSERT INTO incident_masters(id,key,display_name) VALUES ('migration-incident','migration-incident','Incident')`;
  const sessions = [
    ['ended-linked', 'COMPLETED', '2000-01-01'],
    ['ended-unmatched', 'COMPLETED', '2000-01-02'],
    ['postponed', 'POSTPONED', '2000-01-03'],
    ['skipped', 'SKIPPED', '2000-01-04'],
    ['active', 'ASKING', '2000-01-05'],
    ['future', 'SKIPPED', '9999-01-01'],
    ['pending', 'COMPLETED', '2000-01-06'],
    ['in-flight', 'COMPLETED', '2000-01-07'],
    ['failed', 'COMPLETED', '2000-01-08']
  ];
  for (const [id, status, date] of sessions) {
    await db`INSERT INTO sessions(id,week_key,candidate_date_iso,status,channel_id,deadline_at)
      VALUES (${id},${id},${date},${status},'migration-channel','2000-01-01T12:00:00Z')`;
    await db`INSERT INTO responses(id,session_id,member_id,choice) VALUES (${'response-' + id},${id},'migration-member-1','T2200')`;
  }
  await db`INSERT INTO held_events(id,session_id,held_date_iso,start_at)
    VALUES ('migration-held','ended-linked','2000-01-01','2000-01-01T13:30:00Z'),
      ('migration-ad-hoc',NULL,'2000-01-02','2000-01-02T13:00:00Z')`;
  for (const i of [1, 2, 3, 4]) {
    await db`INSERT INTO held_event_participants(held_event_id,member_id) VALUES ('migration-held',${'migration-member-' + i})`;
  }
  await db`INSERT INTO matches(id,held_event_id,match_no_in_event,game_title_id,layout_family,
      season_master_id,owner_member_id,map_master_id,played_at,created_by_account_id,
      note_body,note_version,note_updated_by_account_id,note_updated_at)
    VALUES ('migration-match','migration-held',1,'migration-title','momotetsu_2','migration-season',
      'migration-member-1','migration-map','2000-01-01T13:30:00Z','migration-account',
      '保存するメモ全文。',1,'migration-account','2000-01-02T13:30:00Z')`;
  for (const i of [1, 2, 3, 4]) {
    await db`INSERT INTO match_players(match_id,member_id,play_order,rank,total_assets_man_yen,revenue_man_yen)
      VALUES ('migration-match',${'migration-member-' + i},${i},${i},${10000 - i * 1000},${200 - i * 10})`;
    await db`INSERT INTO match_incidents(match_id,member_id,incident_master_id,count)
      VALUES ('migration-match',${'migration-member-' + i},'migration-incident',${i})`;
  }
  await db`INSERT INTO match_drafts(id,created_by_account_id,held_event_id,status)
    VALUES ('migration-draft','migration-account','migration-held','draft_ready')`;
  for (const [session, status] of [
    ['ended-linked', 'DELIVERED'], ['postponed', 'CANCELLED'],
    ['pending', 'PENDING'], ['in-flight', 'IN_FLIGHT'], ['failed', 'FAILED']
  ]) {
    await db`INSERT INTO discord_outbox(id,kind,session_id,payload,dedupe_key,status,attempt_count,
      claim_token,claim_expires_at,delivered_at,delivered_message_id,aggregate_revision,ordinal)
      VALUES (${'migration-notification-' + session},'send_message',${session},
        '{"kind":"send_message","renderer":"ask_body","channelId":"migration-channel"}'::jsonb,
        ${'migration-dedupe-' + session},${status},2,
        ${status === 'IN_FLIGHT' ? '11111111-1111-4111-8111-111111111111' : null}::uuid,
        ${status === 'IN_FLIGHT' ? '9999-01-01T00:00:00Z' : null}::timestamptz,
        ${status === 'DELIVERED' ? '2000-01-01T13:00:00Z' : null}::timestamptz,
        ${status === 'DELIVERED' ? 'migration-discord-message' : null},7,0)`;
  }
}

test('backup/restore plus the new migration tail preserves held history and all five delivery states', async () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const source = 'momo_db_test_before_' + suffix;
  const restored = 'momo_db_test_restore_' + suffix;
  const folder = mkdtempSync(join(tmpdir(), 'momo-db-migration-prefix-'));
  const created = [];
  let original; let copy;
  try {
    // A derived disposable migration fixture, never a rewrite of repository history.
    cpSync('./drizzle', folder, { recursive: true });
    const journalPath = join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    journal.entries = journal.entries.filter(entry => entry.idx <= 40);
    writeFileSync(journalPath, JSON.stringify(journal));
    for (const name of [source, restored]) {
      docker(['createdb', '-U', username, name]); created.push(name);
    }
    original = createTestClient(source);
    await migrate(drizzle(original), { migrationsFolder: folder });
    await seedExisting(original);
    const before = await history(original);
    const outbox = await original`SELECT id, dedupe_key, payload, status, attempt_count, claim_token, claim_expires_at,
      next_attempt_at, delivered_at, created_at, updated_at FROM discord_outbox ORDER BY id`;
    const backup = docker(['pg_dump', '-U', username, '--format=custom', '--no-owner', '--no-acl', source]);
    docker(['pg_restore', '-U', username, '--exit-on-error', '--no-owner', '--no-acl', '-d', restored], backup);
    copy = createTestClient(restored);
    assert.deepEqual(await history(copy), before, 'The backup must restore the complete original history');
    await migrate(drizzle(copy), { migrationsFolder: './drizzle' });
    assert.deepEqual(await history(copy), before, 'IDs, values and references of held/match history must remain identical');
    assert.deepEqual((await copy`SELECT id FROM sessions ORDER BY id`).map(r => r.id),
      ['active', 'failed', 'future', 'in-flight', 'pending']);
    assert.equal((await copy`SELECT count(*)::int AS n FROM responses`)[0].n, 5);
    assert.equal((await copy`SELECT session_id FROM held_events WHERE id = 'migration-held'`)[0].session_id, null);
    assert.deepEqual(await copy`SELECT id, dedupe_key, payload, status, attempt_count, claim_token, claim_expires_at,
      next_attempt_at, delivered_at, created_at, updated_at FROM discord_notifications ORDER BY id`, outbox);
    const [delivered] = await copy`SELECT delivered_message_id FROM discord_notification_parts
      WHERE notification_id = 'migration-notification-ended-linked' AND part_no = 0`;
    assert.equal(delivered.delivered_message_id, 'migration-discord-message');
    assert.equal((await copy`SELECT to_regclass('public.discord_outbox') AS old`)[0].old, null);
    assert.equal((await copy`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`)[0].n, 44);
    // Existing migration contents/hashes are not changed by the tail.
    assert.deepEqual(await copy`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id LIMIT 41`,
      await original`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`);
  } finally {
    await copy?.end(); await original?.end();
    for (const name of created.reverse()) docker(['dropdb', '-U', username, name]);
    rmSync(folder, { recursive: true, force: true });
  }
});
