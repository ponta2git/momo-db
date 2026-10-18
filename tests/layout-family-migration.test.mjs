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

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/layout-families-v1.json', import.meta.url), 'utf8'));
const tables = ['game_titles', 'match_drafts', 'matches'];
const journal = () => JSON.parse(readFileSync('./drizzle/meta/_journal.json', 'utf8'));
const latest = db => prefix(db, 82);

async function isolated(run) {
  const name = 'momo_db_test_layout_' + randomUUID().replaceAll('-', '').slice(0, 12);
  docker(['createdb', '-U', username, name]);
  const db = createTestClient(name);
  try { return await run(db, name); }
  finally { await db.end(); docker(['dropdb', '-U', username, name]); }
}

async function prefix(db, lastIndex) {
  const folder = mkdtempSync(join(tmpdir(), 'momo-db-layout-prefix-'));
  try {
    cpSync('./drizzle', folder, { recursive: true });
    const history = journal();
    history.entries = history.entries.filter(entry => entry.idx <= lastIndex);
    writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify(history));
    await migrate(drizzle(db), { migrationsFolder: folder });
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

async function snapshot(db, projectLayout = false) {
  const rows = {};
  for (const { tablename } of await db`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`) {
    const projection = projectLayout && tables.includes(tablename)
      ? db.unsafe("to_jsonb(record) - 'layout_family'") : db.unsafe('to_jsonb(record)');
    rows[tablename] = (await db`SELECT (${projection})::text AS value FROM ${db(tablename)} record
      ORDER BY (${projection})::text COLLATE "C"`).map(row => row.value);
  }
  return { rows, history: [...await db`SELECT id::text, hash, created_at::text FROM drizzle.__drizzle_migrations record ORDER BY record.id`] };
}

async function schema(db) {
  const [value] = await db`SELECT
    (SELECT jsonb_agg(to_jsonb(c) - 'table_catalog' - 'udt_catalog' ORDER BY c.table_name, c.ordinal_position)
      FROM information_schema.columns c WHERE c.table_schema = 'public') AS columns,
    (SELECT jsonb_agg(pg_get_functiondef(p.oid) ORDER BY p.proname)
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public') AS functions,
    (SELECT jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY c.relname, t.tgname)
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal) AS triggers,
    (SELECT jsonb_agg(jsonb_build_object('name', con.conname, 'definition', pg_get_constraintdef(con.oid))
      ORDER BY c.relname, con.conname) FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public') AS constraints,
    (SELECT jsonb_agg(jsonb_build_object('name', indexname, 'definition', indexdef) ORDER BY tablename, indexname)
      FROM pg_indexes WHERE schemaname = 'public') AS indexes`;
  return value;
}

async function seed(db) {
  await resetFixtures(db);
  for (const [index, vector] of fixtures.accepted.entries()) {
    await db`INSERT INTO game_titles(id, name, layout_family)
      VALUES (${'layout-title-' + index}, ${'Layout fixture ' + index}, ${vector.input})`;
    await db`INSERT INTO match_drafts(id, created_by_account_id, status, layout_family)
      VALUES (${'layout-draft-' + index}, 'notification-account', 'draft_ready', ${vector.input})`;
    await db`INSERT INTO matches(id, held_event_id, match_no_in_event, game_title_id, layout_family,
      season_master_id, owner_member_id, map_master_id, played_at, created_by_account_id, analysis_revision)
      VALUES (${'layout-match-' + index}, 'notification-held', ${index + 3}, 'notification-title', ${vector.input},
        'notification-season', 'notification-member-1', 'notification-map',
        '2026-01-01T00:00:00.123456Z', 'notification-account', 9007199254740993)`;
    await db`INSERT INTO source_images(id, owner_account_id, object_key, idempotency_key_hash)
      VALUES (${'layout-source-' + index}, 'notification-account', ${'test/layout/' + index},
        ${index.toString(16).padStart(64, '0')})`;
    await db`INSERT INTO ocr_jobs(id, draft_id, image_id, source_image_id, requested_screen_type, status, input_snapshot)
      VALUES (${'layout-job-' + index}, ${'layout-ocr-draft-' + index}, ${'layout-image-' + index}, ${'layout-source-' + index},
        'total_assets', 'succeeded', ${JSON.stringify({ schemaVersion: '2', layoutFamilyHint: vector.input })}::jsonb)`;
    await db`INSERT INTO ocr_drafts(id, job_id, requested_screen_type, profile_id, payload_json)
      VALUES (${'layout-ocr-draft-' + index}, ${'layout-job-' + index}, 'total_assets', ${vector.input},
        ${JSON.stringify({ layoutFamilyHint: vector.input, profileId: vector.input })}::jsonb)`;
  }
  // The precision of unrelated stored JSON is part of the preservation oracle.
  await db`UPDATE ocr_drafts SET payload_json = payload_json || '{"precise":9007199254740993.123456789}'::jsonb`;
}

async function assertCanonical(db) {
  for (const [table, prefix] of [['game_titles', 'layout-title-'], ['match_drafts', 'layout-draft-'], ['matches', 'layout-match-']]) {
    for (const [index, vector] of fixtures.accepted.entries()) {
      assert.equal((await db`SELECT layout_family FROM ${db(table)} WHERE id = ${prefix + index}`)[0].layout_family, vector.canonical);
    }
  }
  assert.equal((await db`SELECT layout_family FROM match_drafts WHERE id = 'notification-draft'`)[0].layout_family, null);
}

test('fresh layout constraints accept only canonical families and preserve an unselected draft', async () => {
  await isolated(async db => {
    await latest(db); await resetFixtures(db);
    for (const table of tables) {
      const id = { game_titles: 'notification-title', match_drafts: 'notification-draft', matches: 'notification-match-1' }[table];
      for (const canonical of ['momotetsu_2', 'world', 'reiwa']) await db`UPDATE ${db(table)} SET layout_family = ${canonical} WHERE id = ${id}`;
      const invalid = [...fixtures.rejected, ...fixtures.accepted.filter(vector => vector.input !== vector.canonical).map(vector => vector.input)];
      for (const value of invalid) await assert.rejects(db`UPDATE ${db(table)} SET layout_family = ${value} WHERE id = ${id}`,
        { code: '23514', constraint_name: table + '_layout_family_check' });
    }
    await db`UPDATE match_drafts SET layout_family = NULL WHERE id = 'notification-draft'`;
    await assert.rejects(db`UPDATE game_titles SET layout_family = NULL`, { code: '23502' });
    await assert.rejects(db`UPDATE matches SET layout_family = NULL`, { code: '23502' });
  });
});

test('shared layout vectors normalize restored scalar columns while every other stored byte and mechanism stays exact', async () => {
  await isolated(async (source, name) => {
    await prefix(source, 80); await seed(source);
    const original = await snapshot(source); const before = await snapshot(source, true);
    const backup = docker(['pg_dump', '-U', username, '--format=custom', '--no-owner', '--no-acl', name]);
    await isolated(async (copy, restored) => {
      docker(['pg_restore', '-U', username, '--exit-on-error', '--no-owner', '--no-acl', '-d', restored], backup);
      assert.deepEqual(await snapshot(copy), original);
      const oldSchema = await schema(copy);
      await latest(copy); await assertCanonical(copy);
      const after = await snapshot(copy, true);
      assert.deepEqual(after.rows, before.rows, 'Only the three approved layout scalars may change');
      assert.deepEqual(after.history.slice(0, before.history.length), before.history);
      assert.equal(after.history.length, 83);
      const newSchema = await schema(copy);
      assert.deepEqual(newSchema.constraints.filter(constraint => !tables.some(table => constraint.name === table + '_layout_family_check')), oldSchema.constraints);
      for (const kind of ['columns', 'indexes', 'functions', 'triggers']) assert.deepEqual(newSchema[kind], oldSchema[kind]);
      const committed = await snapshot(copy); await latest(copy);
      assert.deepEqual(await snapshot(copy), committed);
    });
  });
});

test('unknown, empty, literal auto and Unicode edge whitespace stop before partial normalization or CHECK installation', async () => {
  await isolated(async db => {
    await prefix(db, 80); await seed(db);
    const oldSchema = await schema(db);
    for (const table of tables) {
      const id = { game_titles: 'layout-title-0', match_drafts: 'layout-draft-0', matches: 'layout-match-0' }[table];
      for (const value of fixtures.rejected) {
        await db`UPDATE ${db(table)} SET layout_family = ${value} WHERE id = ${id}`;
        const before = await snapshot(db);
        await assert.rejects(latest(db), error => error.cause?.code === '23514'
          && error.cause?.message === 'LAYOUT_FAMILY_UNMAPPED_SOURCE' && error.cause?.table_name === table);
        assert.deepEqual(await snapshot(db), before);
        await db`UPDATE ${db(table)} SET layout_family = 'momotetsu_2' WHERE id = ${id}`;
      }
    }
    assert.deepEqual(await schema(db), oldSchema);
  });
});

test('failure after normalization rolls back original spellings and ledger; a later normal run succeeds', async () => {
  await isolated(async db => {
    await prefix(db, 80); await seed(db);
    const before = await snapshot(db); const oldSchema = await schema(db);
    const folder = mkdtempSync(join(tmpdir(), 'momo-db-layout-failure-'));
    try {
      cpSync('./drizzle', folder, { recursive: true });
      const file = join(folder, journal().entries.find(entry => entry.idx === 81).tag + '.sql');
      writeFileSync(file, readFileSync(file, 'utf8') + `\n--> statement-breakpoint\nDO $$ BEGIN
        IF (SELECT layout_family FROM game_titles WHERE id = 'layout-title-5') <> 'world' THEN
          RAISE EXCEPTION 'layout normalization checkpoint not reached';
        END IF;
        RAISE EXCEPTION 'forced failure after layout normalization';
      END $$;\n`);
      await assert.rejects(migrate(drizzle(db), { migrationsFolder: folder }),
        error => error.cause?.message === 'forced failure after layout normalization');
    } finally { rmSync(folder, { recursive: true, force: true }); }
    assert.deepEqual(await snapshot(db), before); assert.deepEqual(await schema(db), oldSchema);
    await latest(db); await assertCanonical(db);
  });
});
