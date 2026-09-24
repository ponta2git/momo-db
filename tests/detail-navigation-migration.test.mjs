import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createTestClient, resetFixtures } from './notification-fixtures.mjs';

const container = process.env.MOMO_DB_TEST_CONTAINER;
const username = process.env.MOMO_DB_TEST_USER ?? 'postgres';
if (!container || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container)) {
  throw new Error('Set MOMO_DB_TEST_CONTAINER to the disposable local PostgreSQL test container.');
}
function docker(args, input) {
  const result = spawnSync('docker', ['exec', ...(input ? ['-i'] : []), container, ...args], { input, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Disposable database command failed: ${args[0]} (${result.status})`);
  return result.stdout;
}
async function snapshot(db, tables) {
  const result = {};
  for (const table of tables) {
    result[table] = [...await db`SELECT to_jsonb(row) AS row FROM ${db(table)} row ORDER BY to_jsonb(row)::text`];
  }
  result.history = [...await db`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`];
  return result;
}

test('0057 preserves the complete restored database and adds valid bytewise navigation indexes', async () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const source = 'momo_db_test_navigation_before_' + suffix;
  const restored = 'momo_db_test_navigation_restore_' + suffix;
  const prefix = mkdtempSync(join(tmpdir(), 'momo-db-navigation-prefix-'));
  const created = [];
  let db; let copy;
  try {
    cpSync('./drizzle', prefix, { recursive: true });
    const journalPath = join(prefix, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    journal.entries = journal.entries.filter(entry => entry.idx <= 56);
    writeFileSync(journalPath, JSON.stringify(journal));
    docker(['createdb', '-U', username, source]); created.push(source);
    db = createTestClient(source);
    await migrate(drizzle(db), { migrationsFolder: prefix });
    await resetFixtures(db);
    for (const id of ['navigation_\uE000', 'navigation_\u{10000}']) {
      await db`INSERT INTO held_events(id,held_date_iso,start_at)
        VALUES (${id},'2026-01-01','2026-01-01T00:00:00.000001Z')`;
    }
    await db`UPDATE matches SET note_body = '移行しても保持するメモ', note_version = 1,
      note_updated_by_account_id = 'notification-account', note_updated_at = now(),
      played_at = '2026-01-01T00:00:00.000001Z' WHERE id = 'notification-match-1'`;
    await db`INSERT INTO match_players(match_id,member_id,play_order,rank,total_assets_man_yen,revenue_man_yen)
      SELECT m.id,'notification-member-' || p,p,p,10000 - p,1000 - p
      FROM matches m CROSS JOIN generate_series(1,4) p`;
    await db`INSERT INTO match_incidents(match_id,member_id,incident_master_id,count)
      SELECT p.match_id,p.member_id,i.id,1 FROM match_players p CROSS JOIN incident_masters i`;
    const tables = (await db`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`).map(row => row.tablename);
    const before = await snapshot(db, tables);
    const backup = docker(['pg_dump', '-U', username, '--format=custom', '--no-owner', '--no-acl', source]);
    docker(['createdb', '-U', username, restored]); created.push(restored);
    docker(['pg_restore', '-U', username, '--exit-on-error', '--no-owner', '--no-acl', '-d', restored], backup);
    copy = createTestClient(restored);
    assert.deepEqual(await snapshot(copy, tables), before);
    await migrate(drizzle(copy), { migrationsFolder: './drizzle' });
    const after = await snapshot(copy, tables);
    assert.equal(after.history.length, JSON.parse(readFileSync('./drizzle/meta/_journal.json', 'utf8')).entries.length);
    assert.deepEqual(after.history.slice(0, before.history.length), before.history);
    after.history = before.history;
    assert.deepEqual(after, before, 'Index creation must preserve every existing value and reference');
    const indexes = await copy`SELECT c.relname, i.indisvalid, i.indisunique, am.amname, pg_get_indexdef(i.indexrelid) AS definition
      FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam
      WHERE c.relname IN ('held_events_navigation_idx','matches_navigation_idx') ORDER BY c.relname`;
    assert.equal(indexes.length, 2);
    for (const index of indexes) {
      assert.equal(index.indisvalid, true);
      assert.equal(index.indisunique, false);
      assert.equal(index.amname, 'btree');
    }
    assert.match(indexes[0].definition, /\(start_at, id COLLATE "C"\)$/);
    assert.match(indexes[1].definition, /\(played_at, held_event_id COLLATE "C", match_no_in_event, id COLLATE "C"\)$/);
    const sameTime = await copy`SELECT id FROM held_events WHERE id LIKE 'navigation_%' ORDER BY start_at, id COLLATE "C"`;
    assert.deepEqual(sameTime.map(row => row.id), ['navigation_\uE000', 'navigation_\u{10000}']);
    assert.equal((await copy`SELECT to_char(played_at AT TIME ZONE 'UTC','US') AS micros FROM matches WHERE id='notification-match-1'`)[0].micros, '000001');
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
