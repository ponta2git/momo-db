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

async function stage(db, id, schema, algorithm) {
  await db`INSERT INTO series_analysis_artifacts(id, game_title_id, input_revision, algorithm_version,
    artifact_schema_version, source_input_checksum, root_checksum, aggregate_chunk_count,
    review_chunk_count, drilldown_chunk_count, match_context_chunk_count, encoded_bytes, decoded_bytes)
    VALUES (${id}, 'analysis-title', 0, ${algorithm}, ${schema}, ${checksum}, ${checksum}, 1, 0, 0, 0, 2, 2)`;
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
        assert.deepEqual(after.states, before.states);
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
