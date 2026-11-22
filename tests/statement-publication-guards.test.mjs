import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { buffer } from 'node:stream/consumers';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createTestClient } from './notification-fixtures.mjs';
import { docker, username } from './migration-fixtures.mjs';

const otherResources = {
  achievement: {},
  scope_aggregate: {},
  scope_review: {},
  drilldown: { member_id: 'member-a', metric_id: 'score' },
  outlook_summary: {},
  outlook_reference: { member_id: 'member-a', item_count: 1 },
};
const context = 'series_analysis_match_context_artifacts';
const payload = Buffer.from('{}');
const checksum = 'sha256:' + createHash('sha256').update(payload).digest('hex');
const contract = 'series-analysis-artifact-v8-full-validation-v1';
const immutable = { code: 'P0001', message: 'attested series analysis artifact payloads are immutable' };

function chunk(id, fields = {}) {
  return {
    artifact_id: id, scope_key: 'overall', scope_kind: 'overall', season_master_id: null, payload,
    encoded_bytes: payload.length, decoded_bytes: payload.length, item_count: 0,
    nesting_depth: 1, checksum, ...fields,
  };
}

function contextChunk(id, match = 'match-a') {
  return chunk(id, { match_id: match, source_match_revision: 1 });
}

function stage(db, id, version = 8) {
  return db`INSERT INTO series_analysis_artifacts
    (id, game_title_id, input_revision, algorithm_version, artifact_schema_version, source_input_checksum,
     root_checksum, aggregate_chunk_count, review_chunk_count, drilldown_chunk_count, match_context_chunk_count,
     encoded_bytes, decoded_bytes)
    VALUES (${id}, 'guard-title', 0, 'guard-v1', ${version}, ${checksum}, ${checksum}, 1, 0, 0, 0, 2, 2)`;
}
function seal(db, id) {
  return db`UPDATE series_analysis_artifacts SET validation_contract_id = ${contract} WHERE id = ${id}`;
}
function publish(db, id) {
  return db`UPDATE series_analysis_artifacts SET status = 'published', published_at = now() WHERE id = ${id}`;
}
function insert(db, table, rows) {
  return db`INSERT INTO ${db(table)} ${db(rows)}`;
}
async function count(db, table, ids) {
  const [row] = await db`SELECT count(*)::int AS count FROM ${db(table)} WHERE artifact_id IN ${db(ids)}`;
  return row.count;
}

// Let PostgreSQL encode exactly the table's binary row shape, then exercise the worker's COPY protocol.
async function binaryRows(db, table, rows) {
  return db.begin(async tx => {
    await tx`CREATE TEMP TABLE chunks_to_copy (LIKE ${tx(table)}) ON COMMIT DROP`;
    await insert(tx, 'chunks_to_copy', rows);
    return buffer(await tx`COPY chunks_to_copy TO STDOUT (FORMAT binary)`.readable());
  });
}

async function waitUntilBlocked(db, waiterPid, holderPid) {
  const deadline = Date.now() + 3000;
  do {
    const [row] = await db`SELECT ${holderPid} = ANY(pg_blocking_pids(${waiterPid})) AS blocked`;
    if (row.blocked) return;
    await delay(10);
  } while (Date.now() < deadline);
  assert.fail('expected the second backend to wait on the first');
}

test('publication batches match-context inserts and preserves child immutability', async t => {
  const name = 'momo_db_test_publication_guard_' + randomUUID().replaceAll('-', '').slice(0, 12);
  docker(['createdb', '-U', username, name]);
  const db = createTestClient(name);
  try {
    await migrate(drizzle(db), { migrationsFolder: './drizzle' });
    const title = randomUUID();
    await db`INSERT INTO game_titles(id, legacy_id, name, layout_family)
      VALUES (${title}, 'guard-title', 'Publication guard', 'momotetsu_2')`;
    await stage(db, 'sealed-empty');
    await seal(db, 'sealed-empty');
    await stage(db, 'published-empty', 2);
    await publish(db, 'published-empty'); // Legacy publication without a validation contract is also immutable.

    await t.test('other six resources keep rejecting even duplicate inserts into a sealed artifact', async () => {
      await stage(db, 'retained');
      for (const [resource, fields] of Object.entries(otherResources)) {
        await insert(db, 'series_analysis_' + resource + '_artifacts', [chunk('retained', fields)]);
      }
      await seal(db, 'retained');
      for (const [resource, fields] of Object.entries(otherResources)) {
        const table = 'series_analysis_' + resource + '_artifacts';
        await assert.rejects(db`INSERT INTO ${db(table)} ${db(chunk('retained', fields))} ON CONFLICT DO NOTHING`, immutable, resource);
        await assert.rejects(insert(db, table, [chunk('published-empty', fields)]), immutable, resource);
        await assert.rejects(db`DELETE FROM ${db(table)} WHERE artifact_id = 'retained'`, immutable, resource);
        assert.equal(await count(db, table, ['retained']), 1, resource);
      }
    });

    await t.test('multi-parent INSERT and binary COPY protect match contexts atomically', async () => {
      for (const id of ['open', 'copied', 'other']) await stage(db, id);
      const copy = bytes => docker(['psql', '-XqAt', '-U', username, '-d', name,
        '-c', 'COPY public.series_analysis_match_context_artifacts FROM STDIN (FORMAT binary)',
        '-c', '\\echo :SQLSTATE'], bytes).toString().trim();

      await db.begin(async tx => {
        assert.equal((await tx`INSERT INTO ${tx(context)} SELECT * FROM ${tx(context)} WHERE false`).count, 0);
        const locks = await tx`SELECT 1 FROM pg_locks WHERE pid = pg_backend_pid()
          AND relation = 'public.series_analysis_artifacts'::regclass`;
        assert.equal(locks.length, 0);
      });
      const batch = [contextChunk('copied'), contextChunk('open'), contextChunk('copied', 'match-b')];
      assert.equal(copy(await binaryRows(db, context, batch)), '00000');
      assert.equal(await count(db, context, ['copied', 'open']), batch.length);
      await assert.rejects(insert(db, context, [contextChunk('other'), contextChunk('sealed-empty')]), immutable);
      await assert.rejects(insert(db, context, [contextChunk('published-empty'), contextChunk('other')]), immutable);
      const mixed = await binaryRows(db, context, [contextChunk('other'), contextChunk('sealed-empty')]);
      assert.equal(copy(mixed), immutable.code);
      assert.equal(await count(db, context, ['other', 'sealed-empty', 'published-empty']), 0);
      await assert.rejects(insert(db, context, [contextChunk('missing-parent')]), { code: '23503' });

      await seal(db, 'copied');
      assert.equal((await db`INSERT INTO ${db(context)} ${db([contextChunk('copied'), contextChunk('other')])}
        ON CONFLICT DO NOTHING`).count, 1);
      await assert.rejects(db`UPDATE ${db(context)} SET artifact_id = 'sealed-empty' WHERE artifact_id = 'open'`, immutable);
      await assert.rejects(db`UPDATE ${db(context)} SET artifact_id = 'other' WHERE artifact_id = 'copied'`, immutable);
      await assert.rejects(db`DELETE FROM ${db(context)} WHERE artifact_id IN ('other', 'copied')`, immutable);
      assert.equal(await count(db, context, ['other', 'copied', 'open']), batch.length + 1);

      await db`DELETE FROM ${db(context)} WHERE artifact_id = 'other'`;
      await db`UPDATE ${db(context)} SET artifact_id = 'other' WHERE artifact_id = 'open'`;
      await db`DELETE FROM series_analysis_artifacts WHERE id = 'copied'`;
      assert.equal(await count(db, context, ['copied']), 0);
    });

    await t.test('conflict updates and data-modifying CTEs use both guards', async () => {
      for (const id of ['conflict', 'accepted', 'cte']) await stage(db, id);
      const first = contextChunk('conflict');
      await insert(db, context, [first]);
      await seal(db, 'conflict');
      await assert.rejects(insert(db, context, [first]), { code: '23505' });
      assert.equal((await db`INSERT INTO ${db(context)} ${db(first)} ON CONFLICT DO NOTHING`).count, 0);
      assert.equal((await db`INSERT INTO ${db(context)} ${db(first)}
        ON CONFLICT (artifact_id, scope_key, match_id) DO UPDATE SET nesting_depth = 2 WHERE false`).count, 0);
      await assert.rejects(db`INSERT INTO ${db(context)} ${db([contextChunk('accepted'), first])}
        ON CONFLICT (artifact_id, scope_key, match_id) DO UPDATE SET nesting_depth = 2`, immutable);
      assert.equal(await count(db, context, ['accepted']), 0);
      const [original] = await db`SELECT nesting_depth FROM ${db(context)} WHERE artifact_id='conflict'`;
      assert.equal(original.nesting_depth, 1);

      await db.begin(async tx => {
        await insert(tx, context, [contextChunk('accepted')]);
        await seal(tx, 'accepted');
      });
      await assert.rejects(db.begin(async tx => {
        await seal(tx, 'cte');
        await insert(tx, context, [contextChunk('cte')]);
      }), immutable);
      // At the end of a single statement both sibling writes are visible to the INSERT guard.
      await assert.rejects(db`WITH child AS (
          INSERT INTO ${db(context)} ${db(contextChunk('cte'))} RETURNING artifact_id
        ) UPDATE series_analysis_artifacts SET validation_contract_id = ${contract}
          WHERE id IN (SELECT artifact_id FROM child)`, immutable);
      await assert.rejects(db`WITH sealed AS (
          UPDATE series_analysis_artifacts SET validation_contract_id = ${contract}
          WHERE id = 'cte' RETURNING id
        ) INSERT INTO ${db(context)} SELECT sealed.id, a.scope_key, a.scope_kind,
          a.season_master_id, a.map_master_id, a.match_id, a.source_match_revision, a.payload, a.encoded_bytes, a.decoded_bytes,
          a.item_count, a.nesting_depth, a.checksum FROM sealed, ${db(context)} a
          WHERE a.artifact_id = 'accepted'`, immutable);
      const [parent] = await db`SELECT validation_contract_id FROM series_analysis_artifacts WHERE id = 'cte'`;
      assert.equal(parent.validation_contract_id, null);
      assert.equal(await count(db, context, ['cte']), 0);
    });

    await t.test('two backends serialize sealing and actual inserts in either order', async () => {
      const [holder, waiter] = await Promise.all([db.reserve(), db.reserve()]);
      try {
        const [{ pid: holderPid }] = await holder`SELECT pg_backend_pid() AS pid`;
        const [{ pid: waiterPid }] = await waiter`SELECT pg_backend_pid() AS pid`;
        for (const sealFirst of [true, false]) {
          const id = sealFirst ? 'seal-first' : 'insert-first';
          await stage(db, id);
          await holder`BEGIN`;
          if (sealFirst) await seal(holder, id);
          else await insert(holder, context, [contextChunk(id)]);
          const blocked = sealFirst ? insert(waiter, context, [contextChunk(id)]) : seal(waiter, id);
          const outcome = blocked.then(rows => rows.count, error => ({ code: error.code, message: error.message }));
          await waitUntilBlocked(db, waiterPid, holderPid);
          await holder`COMMIT`;
          assert.deepEqual(await outcome, sealFirst ? immutable : 1);
          assert.equal(await count(db, context, [id]), sealFirst ? 0 : 1);
          const [header] = await db`SELECT validation_contract_id FROM series_analysis_artifacts WHERE id = ${id}`;
          assert.equal(header.validation_contract_id, contract);
        }
        // Reverse the input order and block the first sorted parent. The later parent
        // may have an FK KEY SHARE lock, but must not yet have the guard's SHARE lock.
        for (const id of ['a-first', 'z-last']) await stage(db, id);
        await holder`BEGIN`;
        await holder`SELECT id FROM series_analysis_artifacts WHERE id = 'a-first' FOR NO KEY UPDATE`;
        const batch = insert(waiter, context, [contextChunk('z-last'), contextChunk('a-first')])
          .then(rows => rows.count, error => error.code);
        await waitUntilBlocked(db, waiterPid, holderPid);
        await db`SELECT id FROM series_analysis_artifacts WHERE id = 'z-last' FOR NO KEY UPDATE NOWAIT`;
        await holder`COMMIT`;
        assert.equal(await batch, 2);
      } finally {
        await holder`ROLLBACK`;
        holder.release();
        waiter.release();
      }
    });

    await t.test('current and previous pointers prevent cleanup until both references are released', async () => {
      const pointers = [];
      for (const id of ['current', 'previous']) {
        await stage(db, id);
        await insert(db, context, [contextChunk(id)]);
        await seal(db, id);
        await publish(db, id);
        const pointer = randomUUID();
        pointers.push(pointer);
        await db`INSERT INTO series_analysis_artifact_identities(id, legacy_id, game_title_id, legacy_game_title_id)
          VALUES (${pointer}, ${id}, ${title}, 'guard-title')`;
      }
      await db`INSERT INTO series_analysis_title_states
        (game_title_id, input_revision, algorithm_version, artifact_schema_version, validation_contract_id, current_artifact_id, previous_artifact_id)
        VALUES (${title}, 0, 'guard-v1', 8, ${contract}, ${pointers[0]}, ${pointers[1]})`;
      for (const id of ['current', 'previous']) {
        await assert.rejects(db`DELETE FROM series_analysis_artifacts WHERE id = ${id}`,
          { constraint_name: 'series_analysis_title_states_' + id + '_artifact_fk' });
        assert.equal(await count(db, context, [id]), 1);
      }
      await db`UPDATE series_analysis_title_states SET current_artifact_id = NULL, previous_artifact_id = NULL WHERE game_title_id = ${title}`;
      await db`DELETE FROM series_analysis_artifacts WHERE id IN ('current', 'previous')`;
      assert.equal(await count(db, context, ['current', 'previous']), 0);
    });
  } finally {
    await db.end();
    docker(['dropdb', '-U', username, name]);
  }
});
