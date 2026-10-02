import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createTestClient } from './notification-fixtures.mjs';

const container = process.env.MOMO_DB_TEST_CONTAINER;
if (!container || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container)) throw new Error('A disposable MOMO_DB_TEST_CONTAINER is required.');
const username = process.env.MOMO_DB_TEST_USER ?? 'postgres';
const checksum = 'sha256:' + 'a'.repeat(64);
const contract = 'series-analysis-artifact-v5-full-validation-v1';
function docker(args) {
  const run = spawnSync('docker', ['exec', container, ...args], { maxBuffer: 1024 * 1024 });
  if (run.status !== 0) throw new Error('Disposable database operation failed.');
}
async function isolated(run) {
  const name = 'momo_db_test_radar_' + randomUUID().replaceAll('-', '').slice(0, 12);
  docker(['createdb', '-U', username, name]);
  const db = createTestClient(name);
  try {
    await migrate(drizzle(db), { migrationsFolder: './drizzle' });
    await db`INSERT INTO game_titles(id,name,layout_family) VALUES ('radar-a','A','momotetsu_2'),('radar-b','B','momotetsu_2')`;
    await db`UPDATE series_analysis_title_states SET algorithm_version='series-analysis-v6',artifact_schema_version=5,validation_contract_id=${contract}`;
    await run(db);
  } finally { await db.end(); docker(['dropdb','-U',username,name]); }
}
async function basis(db, id, title = 'radar-a') {
  await db`INSERT INTO series_radar_bases(id,game_title_id,checksum,payload,source_snapshot,source_checksum,source_input_revision)
    VALUES (${id},${title},${checksum},'{}','{"matches":[]}',${checksum},0)`;
}
async function stage(db, id, generation) {
  await db`INSERT INTO series_analysis_artifacts(id,game_title_id,input_revision,algorithm_version,artifact_schema_version,
    source_input_checksum,root_checksum,aggregate_chunk_count,review_chunk_count,drilldown_chunk_count,match_context_chunk_count,
    encoded_bytes,decoded_bytes,radar_basis_id,radar_generation,scope_keys)
    VALUES (${id},'radar-a',0,'series-analysis-v6',5,${checksum},${checksum},1,0,0,0,2,2,'basis-a',${generation},ARRAY['overall'])`;
  await db`UPDATE series_analysis_artifacts SET validation_contract_id=${contract} WHERE id=${id}`;
  await db`UPDATE series_analysis_artifacts SET status='published',published_at=clock_timestamp(),radar_applied_at=clock_timestamp() WHERE id=${id}`;
}

test('radar migration starts without criteria and enforces immutable title-owned snapshots', async () => isolated(async db => {
  assert.equal((await db`SELECT count(*)::int AS n FROM series_radar_bases`)[0].n, 0);
  await basis(db, 'basis-a');
  await basis(db, 'basis-b', 'radar-b');
  await assert.rejects(db`UPDATE series_radar_bases SET payload='{"thresholds":[1]}' WHERE id='basis-a'`, /immutable/);
  await assert.rejects(db`UPDATE series_radar_bases SET source_snapshot='{"matches":[1]}' WHERE id='basis-a'`, /immutable/);
  await assert.rejects(db`INSERT INTO series_radar_candidates(id,game_title_id,basis_id) VALUES ('bad','radar-a','basis-b')`, { code:'23503' });
  await db`INSERT INTO series_radar_candidates(id,game_title_id,basis_id,status) VALUES ('candidate-a','radar-a','basis-a','ready')`;
  await assert.rejects(db`INSERT INTO series_radar_candidates(id,game_title_id) VALUES ('candidate-duplicate','radar-a')`, { code:'23505' });
  await assert.rejects(db`UPDATE series_radar_bases SET source_snapshot=NULL WHERE id='basis-a'`, /protected/);
  await db`UPDATE series_radar_candidates SET status='withdrawn' WHERE id='candidate-a'`;
  await db`UPDATE series_radar_bases SET source_snapshot=NULL WHERE id='basis-a'`;
  assert.equal((await db`SELECT source_snapshot FROM series_radar_bases WHERE id='basis-a'`)[0].source_snapshot,null);
}));

test('ordinary jobs inherit desired criteria, preparation stays separate, and publication is generation-fenced', async () => isolated(async db => {
  await basis(db,'basis-a');
  await db`INSERT INTO series_radar_title_states(game_title_id,desired_basis_id,generation) VALUES ('radar-a','basis-a',1)`;
  await db`INSERT INTO series_analysis_jobs(id,game_title_id,input_revision,algorithm_version,artifact_schema_version,validation_contract_id,trigger)
    VALUES ('ordinary','radar-a',0,'series-analysis-v6',5,${contract},'manual')`;
  const [job] = await db`SELECT radar_basis_id,radar_generation,work_kind FROM series_analysis_jobs WHERE id='ordinary'`;
  assert.deepEqual({...job},{radar_basis_id:'basis-a',radar_generation:'1',work_kind:'analysis'});
  await db`UPDATE series_radar_title_states SET generation=2 WHERE game_title_id='radar-a'`;
  await db`UPDATE series_analysis_jobs SET updated_at=clock_timestamp() WHERE id='ordinary'`;
  assert.equal((await db`SELECT radar_generation FROM series_analysis_jobs WHERE id='ordinary'`)[0].radar_generation,'2');
  await db`DELETE FROM series_analysis_jobs WHERE id='ordinary'`;
  await db`INSERT INTO series_analysis_jobs(id,game_title_id,input_revision,algorithm_version,artifact_schema_version,validation_contract_id,trigger,work_kind,radar_operation_id)
    VALUES ('prepare','radar-a',0,'series-analysis-v6',5,${contract},'manual','radar_prepare','prepare-operation')`;
  assert.equal((await db`SELECT radar_basis_id FROM series_analysis_jobs WHERE id='prepare'`)[0].radar_basis_id,null);
  await assert.rejects(db`INSERT INTO series_analysis_jobs(id,game_title_id,input_revision,algorithm_version,artifact_schema_version,trigger,work_kind)
    VALUES ('invalid-prepare','radar-b',0,'series-analysis-v6',5,'manual','radar_prepare')`, {code:'23514'});
  await stage(db,'stale-artifact',1);
  await assert.rejects(db`UPDATE series_analysis_title_states SET current_artifact_id='stale-artifact' WHERE game_title_id='radar-a'`, /generation/);
  await stage(db,'current-artifact',2);
  await db`UPDATE series_analysis_title_states SET current_artifact_id='current-artifact' WHERE game_title_id='radar-a'`;
  await assert.rejects(db`UPDATE series_analysis_artifacts SET radar_applied_at=clock_timestamp() WHERE id='current-artifact'`, /immutable/);
  await assert.rejects(db`UPDATE series_analysis_artifacts SET scope_keys=ARRAY[]::text[] WHERE id='current-artifact'`, /immutable/);
  await assert.rejects(db`UPDATE series_radar_bases SET source_snapshot=NULL WHERE id='basis-a'`, /protected/);
}));
