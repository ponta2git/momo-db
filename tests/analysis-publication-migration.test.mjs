import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createTestClient } from './notification-fixtures.mjs';

const container = process.env.MOMO_DB_TEST_CONTAINER;
const username = process.env.MOMO_DB_TEST_USER ?? 'postgres';
if (!container || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container)) {
  throw new Error('Set MOMO_DB_TEST_CONTAINER to the disposable local PostgreSQL test container.');
}
const oldContract = 'series-analysis-artifact-v2-full-validation-v1';
const newContract = 'series-analysis-artifact-v3-full-validation-v1';
const oldTuple = { algorithm_version: 'series-analysis-v4', artifact_schema_version: 2, validation_contract_id: oldContract };
const newTuple = { algorithm_version: 'series-analysis-v5', artifact_schema_version: 3, validation_contract_id: newContract };
const presentationContract = 'series-analysis-artifact-v4-full-validation-v1';
const presentationTuple = { ...newTuple, artifact_schema_version: 4, validation_contract_id: presentationContract };
const payload = Buffer.from('{}');
const checksum = 'sha256:' + createHash('sha256').update(payload).digest('hex');

function docker(args, input) {
  const result = spawnSync('docker', ['exec', ...(input ? ['-i'] : []), container, ...args], {
    input, maxBuffer: 32 * 1024 * 1024
  });
  if (result.status !== 0) throw new Error(`Disposable database command failed: ${args[0]} (${result.status})`, { cause: result.error });
  return result.stdout;
}

async function withDatabase(run) {
  const name = 'momo_db_test_analysis_' + randomUUID().replaceAll('-', '').slice(0, 12);
  docker(['createdb', '-U', username, name]);
  const db = createTestClient(name);
  try { return await run(db, name); }
  finally { await db.end(); docker(['dropdb', '-U', username, name]); }
}

async function migratePrevious(db, lastIndex = 45) {
  const folder = mkdtempSync(join(tmpdir(), 'momo-db-analysis-prefix-'));
  try {
    cpSync('./drizzle', folder, { recursive: true });
    const path = join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(path, 'utf8'));
    journal.entries = journal.entries.filter(entry => entry.idx <= lastIndex);
    writeFileSync(path, JSON.stringify(journal));
    await migrate(drizzle(db), { migrationsFolder: folder });
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

async function tuple(db) {
  const [row] = await db`SELECT algorithm_version, artifact_schema_version, validation_contract_id
    FROM series_analysis_release_state WHERE singleton_key = 'current'`;
  return { ...row };
}

async function stage(db, id, schema, algorithm, title = 'analysis-title') {
  await db`INSERT INTO series_analysis_artifacts(id, game_title_id, input_revision, algorithm_version,
    artifact_schema_version, source_input_checksum, root_checksum, aggregate_chunk_count,
    review_chunk_count, drilldown_chunk_count, match_context_chunk_count, encoded_bytes, decoded_bytes)
    VALUES (${id}, ${title}, 0, ${algorithm}, ${schema}, ${checksum}, ${checksum}, 1, 0, 0, 0, 2, 2)`;
  await db`INSERT INTO series_analysis_scope_aggregate_artifacts(artifact_id, scope_key, scope_kind,
    payload, encoded_bytes, decoded_bytes, item_count, nesting_depth, checksum)
    VALUES (${id}, 'overall', 'overall', ${payload}, 2, 2, 0, 1, ${checksum})`;
}
async function publish(db, id, contract) {
  await db`UPDATE series_analysis_artifacts SET validation_contract_id = ${contract} WHERE id = ${id}`;
  await db`UPDATE series_analysis_artifacts SET status = 'published', published_at = clock_timestamp() WHERE id = ${id}`;
}
async function stored(db) {
  const [rows] = await db`SELECT
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM series_analysis_artifacts a) AS headers,
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY artifact_id, scope_key) FROM series_analysis_scope_aggregate_artifacts c) AS chunks,
    (SELECT jsonb_agg(to_jsonb(s) ORDER BY game_title_id) FROM series_analysis_title_states s) AS states,
    (SELECT jsonb_agg(jsonb_build_object('hash', hash, 'created_at', created_at) ORDER BY id) FROM drizzle.__drizzle_migrations) AS history`;
  return { ...rows };
}

test('fresh migrations preserve the baseline while allowing all supported publication contracts', async () => {
  await withDatabase(async db => {
    await migrate(drizzle(db), { migrationsFolder: './drizzle' });
    assert.deepEqual(await tuple(db), newTuple);
    await db`INSERT INTO game_titles(id, name, layout_family) VALUES ('analysis-title', 'Analysis title', 'momotetsu_2')`;
    const [state] = await db`SELECT algorithm_version, artifact_schema_version, validation_contract_id FROM series_analysis_title_states`;
    assert.deepEqual({ ...state }, newTuple);
    for (const [schema, contract] of [[2, newContract], [3, oldContract], [2, presentationContract], [3, presentationContract], [4, oldContract], [4, newContract]]) {
      await assert.rejects(db`UPDATE series_analysis_release_state SET artifact_schema_version = ${schema}, validation_contract_id = ${contract}`,
        { code: '23514' });
    }
    for (const [id, schema, algorithm, contract] of [
      ['old', 2, oldTuple.algorithm_version, oldContract], ['new', 3, newTuple.algorithm_version, newContract],
      ['presentation', 4, presentationTuple.algorithm_version, presentationContract]
    ]) {
      await stage(db, id, schema, algorithm);
      // Staging resources remain editable before attestation.
      await db`UPDATE series_analysis_scope_aggregate_artifacts SET item_count = 1 WHERE artifact_id = ${id}`;
      await publish(db, id, contract);
      await assert.rejects(db`UPDATE series_analysis_artifacts SET input_revision = 1 WHERE id = ${id}`, /immutable/);
      await assert.rejects(db`DELETE FROM series_analysis_scope_aggregate_artifacts WHERE artifact_id = ${id}`, /immutable/);
      await assert.rejects(db`UPDATE series_analysis_scope_aggregate_artifacts SET item_count = 2 WHERE artifact_id = ${id}`, /immutable/);
      await db`UPDATE series_analysis_title_states SET algorithm_version = ${algorithm}, artifact_schema_version = ${schema}, validation_contract_id = ${contract} WHERE game_title_id = 'analysis-title'`;
      await db`UPDATE series_analysis_title_states SET current_artifact_id = ${id}, previous_artifact_id = NULL WHERE game_title_id = 'analysis-title'`;
      await assert.rejects(db`DELETE FROM series_analysis_artifacts WHERE id = ${id}`, { code: '23001' });
    }
    await assert.rejects(db`UPDATE series_analysis_title_states SET previous_artifact_id = 'old'`, /attested publication/);
    for (const schema of [3, 4, 5]) {
      const id = `unsealed-${schema}`;
      await stage(db, id, schema, newTuple.algorithm_version);
      await assert.rejects(db`UPDATE series_analysis_artifacts SET status = 'published', published_at = clock_timestamp() WHERE id = ${id}`, /publication/);
      await assert.rejects(db`UPDATE series_analysis_artifacts SET validation_contract_id = ${oldContract} WHERE id = ${id}`, /seal-only/);
      await assert.rejects(db`UPDATE series_analysis_title_states SET current_artifact_id = ${id}`, /attested published/);
    }
    const constraints = await db`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conname LIKE 'series_analysis_%_validation_schema_check'`;
    assert.equal(constraints.length, 8);
    assert.ok(constraints.every(row => row.definition.includes(presentationContract)));
    await db`UPDATE series_analysis_title_states SET current_artifact_id = NULL`;
    await db`DELETE FROM series_analysis_artifacts WHERE id IN ('old', 'new', 'presentation')`;
    assert.equal((await db`SELECT count(*)::int AS n FROM series_analysis_scope_aggregate_artifacts WHERE artifact_id IN ('old', 'new', 'presentation')`)[0].n, 0);
  });
});

for (const [lastIndex, baseline] of [[45, oldTuple], [51, newTuple]]) {
  test(`upgrade of a restored schema ${baseline.artifact_schema_version} publication preserves rows, pointers and applied hashes`, async () => {
    await withDatabase(async (source, name) => {
      await migratePrevious(source, lastIndex);
      assert.deepEqual(await tuple(source), baseline);
      await source`INSERT INTO game_titles(id, name, layout_family) VALUES ('analysis-title', 'Analysis title', 'momotetsu_2')`;
      await stage(source, 'old', baseline.artifact_schema_version, baseline.algorithm_version);
      await publish(source, 'old', baseline.validation_contract_id);
      await source`UPDATE series_analysis_title_states SET current_artifact_id = 'old'`;
      const before = await stored(source);
      const backup = docker(['pg_dump', '-U', username, '--format=custom', '--no-owner', '--no-acl', name]);
      await withDatabase(async (copy, restored) => {
        docker(['pg_restore', '-U', username, '--exit-on-error', '--no-owner', '--no-acl', '-d', restored], backup);
        assert.deepEqual(await stored(copy), before);
        await migrate(drizzle(copy), { migrationsFolder: './drizzle' });
        assert.deepEqual(await tuple(copy), baseline);
        const after = await stored(copy);
        assert.deepEqual(after.headers, before.headers);
        assert.deepEqual(after.chunks, before.chunks);
        assert.deepEqual(after.states.map(({ notification_baseline_state, notification_baseline_artifact_id, ...state }) => state), before.states);
        assert.equal(after.states[0].notification_baseline_state, 'artifact');
        assert.equal(after.states[0].notification_baseline_artifact_id, 'old');
        assert.deepEqual(after.history.slice(0, before.history.length), before.history);
        await stage(copy, 'new', 4, presentationTuple.algorithm_version);
        await publish(copy, 'new', presentationContract);
        await copy`UPDATE series_analysis_title_states SET algorithm_version = ${presentationTuple.algorithm_version},
          artifact_schema_version = 4, validation_contract_id = ${presentationContract}, current_artifact_id = 'new'
          WHERE game_title_id = 'analysis-title'`;
        await assert.rejects(copy`UPDATE series_analysis_title_states SET previous_artifact_id = 'old'`, /attested publication/);
      });
    });
  });
}

for (const registry of ['reader', 'worker']) {
  test(`empty operated database with stale draining ${registry} keeps its active tuple`, async () => {
    await withDatabase(async db => {
      await migratePrevious(db);
      if (registry === 'reader') {
        await db`INSERT INTO series_analysis_reader_capabilities(reader_id, artifact_schema_versions, validation_contract_ids, draining, heartbeat_at)
          VALUES ('old-reader', '[2]', ${JSON.stringify([oldContract])}::jsonb, true, '2000-01-01')`;
      } else {
        await db`INSERT INTO series_analysis_worker_capabilities(worker_id, algorithm_versions, artifact_schema_versions, validation_contract_ids, draining, heartbeat_at)
          VALUES ('old-worker', '["series-analysis-v4"]', '[2]', ${JSON.stringify([oldContract])}::jsonb, true, '2000-01-01')`;
      }
      await migrate(drizzle(db), { migrationsFolder: './drizzle' });
      assert.deepEqual(await tuple(db), oldTuple);
    });
  });
}

async function schemaMechanisms(db) {
  const [row] = await db`SELECT
    (SELECT jsonb_agg(pg_get_functiondef(p.oid) ORDER BY p.proname)
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND NOT EXISTS
       (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.classid = 'pg_proc'::regclass AND d.deptype = 'e')) AS functions,
    (SELECT jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY c.relname, t.tgname)
     FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND NOT t.tgisinternal) AS triggers,
    (SELECT jsonb_agg(indexdef ORDER BY tablename, indexname) FROM pg_indexes WHERE schemaname = 'public') AS indexes`;
  return { ...row };
}

test('notification baseline seeds only attested current publications and preserves restored history', async () => {
  await withDatabase(async (source, name) => {
    await migratePrevious(source, 53);
    for (const title of ['analysis-title', 'empty-title', 'detached-title', 'previous-only-title', 'unattested-title']) {
      await source`INSERT INTO game_titles(id, name, layout_family) VALUES (${title}, ${title}, 'momotetsu_2')`;
    }
    await source`UPDATE series_analysis_title_states SET artifact_schema_version = 4, validation_contract_id = ${presentationContract}`;
    for (const title of ['analysis-title', 'detached-title', 'previous-only-title']) {
      await stage(source, title + '-artifact', 4, presentationTuple.algorithm_version, title);
      await publish(source, title + '-artifact', presentationContract);
    }
    await source`UPDATE series_analysis_title_states SET current_artifact_id = 'analysis-title-artifact' WHERE game_title_id = 'analysis-title'`;
    // A queued mutation must retain the last published input, not appear initial.
    await source`UPDATE series_analysis_title_states SET input_revision = 1, pending_work = true WHERE game_title_id = 'analysis-title'`;
    await source`UPDATE series_analysis_title_states SET previous_artifact_id = 'previous-only-title-artifact' WHERE game_title_id = 'previous-only-title'`;
    await stage(source, 'unattested-artifact', 2, oldTuple.algorithm_version, 'unattested-title');
    await publish(source, 'unattested-artifact', null);
    await source`UPDATE series_analysis_title_states SET algorithm_version = ${oldTuple.algorithm_version},
      artifact_schema_version = 2, validation_contract_id = NULL, current_artifact_id = 'unattested-artifact'
      WHERE game_title_id = 'unattested-title'`;
    const before = await stored(source);
    const mechanisms = await schemaMechanisms(source);
    const backup = docker(['pg_dump', '-U', username, '--format=custom', '--no-owner', '--no-acl', name]);
    await withDatabase(async (copy, restored) => {
      docker(['pg_restore', '-U', username, '--exit-on-error', '--no-owner', '--no-acl', '-d', restored], backup);
      assert.deepEqual(await stored(copy), before);
      // This assertion is specific to 0054/0055; later independent migrations
      // may legitimately add their own structural indexes.
      await migratePrevious(copy, 55);
      const after = await stored(copy);
      assert.deepEqual(after.headers, before.headers);
      assert.deepEqual(after.chunks, before.chunks);
      assert.deepEqual(after.states.map(({ notification_baseline_state, notification_baseline_artifact_id, ...state }) => state), before.states);
      assert.deepEqual(after.history.slice(0, before.history.length), before.history);
      assert.deepEqual(await schemaMechanisms(copy), mechanisms, 'No notification function, trigger or index is introduced');
      for (const state of after.states) {
        const known = state.game_title_id === 'analysis-title';
        assert.equal(state.notification_baseline_state, known ? 'artifact' : 'unknown');
        assert.equal(state.notification_baseline_artifact_id, known ? 'analysis-title-artifact' : null);
      }
      const constraints = await copy`SELECT conname FROM pg_constraint
        WHERE conrelid = 'series_analysis_title_states'::regclass AND contype IN ('c', 'f')
          AND conname LIKE '%notification_baseline%' ORDER BY conname`;
      assert.deepEqual(constraints.map(c => c.conname), [
        'series_analysis_title_states_notification_baseline_artifact_fk',
        'series_analysis_title_states_notification_baseline_check'
      ]);
    });
  });
});

test('notification baseline shape and same-title reference survive UI pointer changes and protect retained input', async () => {
  await withDatabase(async db => {
    await migrate(drizzle(db), { migrationsFolder: './drizzle' });
    await db`INSERT INTO game_titles(id, name, layout_family) VALUES ('analysis-title', 'Analysis title', 'momotetsu_2'), ('other-title', 'Other title', 'momotetsu_2')`;
    const [initial] = await db`SELECT notification_baseline_state, notification_baseline_artifact_id FROM series_analysis_title_states WHERE game_title_id = 'analysis-title'`;
    assert.deepEqual({ ...initial }, { notification_baseline_state: 'unknown', notification_baseline_artifact_id: null });
    await assert.rejects(db`UPDATE series_analysis_title_states SET notification_baseline_state = NULL WHERE game_title_id = 'analysis-title'`, { code: '23502' });
    await db`UPDATE series_analysis_title_states SET notification_baseline_state = 'initial' WHERE game_title_id = 'analysis-title'`;
    await stage(db, 'baseline', 3, newTuple.algorithm_version);
    await publish(db, 'baseline', newContract);
    for (const [state, id] of [['artifact', null], ['initial', 'baseline'], ['unknown', 'baseline'], ['invalid', null]]) {
      await assert.rejects(db`UPDATE series_analysis_title_states SET notification_baseline_state = ${state}, notification_baseline_artifact_id = ${id}
        WHERE game_title_id = 'analysis-title'`, { code: '23514' });
    }
    await assert.rejects(db`UPDATE series_analysis_title_states SET notification_baseline_state = 'artifact', notification_baseline_artifact_id = 'baseline'
      WHERE game_title_id = 'other-title'`, { code: '23503' });
    await db`UPDATE series_analysis_title_states SET notification_baseline_state = 'artifact', notification_baseline_artifact_id = 'baseline', current_artifact_id = 'baseline'
      WHERE game_title_id = 'analysis-title'`;
    await db`UPDATE series_analysis_title_states SET current_artifact_id = NULL, previous_artifact_id = NULL, artifact_schema_version = 4,
      validation_contract_id = ${presentationContract} WHERE game_title_id = 'analysis-title'`;
    const [retained] = await db`SELECT notification_baseline_state, notification_baseline_artifact_id FROM series_analysis_title_states WHERE game_title_id = 'analysis-title'`;
    assert.deepEqual({ ...retained }, { notification_baseline_state: 'artifact', notification_baseline_artifact_id: 'baseline' });
    await assert.rejects(db`DELETE FROM series_analysis_artifacts WHERE id = 'baseline'`, { code: '23001' });
    await assert.rejects(db`UPDATE series_analysis_title_states SET notification_baseline_artifact_id = NULL WHERE game_title_id = 'analysis-title'`, { code: '23514' });
    await db`UPDATE series_analysis_title_states SET notification_baseline_state = 'unknown', notification_baseline_artifact_id = NULL WHERE game_title_id = 'analysis-title'`;
    await db`DELETE FROM series_analysis_artifacts WHERE id = 'baseline'`;
    assert.equal((await db`SELECT count(*)::int AS n FROM series_analysis_scope_aggregate_artifacts WHERE artifact_id = 'baseline'`)[0].n, 0);
  });
});
