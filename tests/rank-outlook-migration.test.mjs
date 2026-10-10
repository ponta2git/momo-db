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
if (!container || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container)) throw new Error('A disposable MOMO_DB_TEST_CONTAINER is required.');
const username = process.env.MOMO_DB_TEST_USER ?? 'postgres';
const payload = Buffer.from('{}');
const checksum = 'sha256:' + createHash('sha256').update(payload).digest('hex');
const contract = 'series-analysis-artifact-v6-full-validation-v1';
function docker(args, input) {
  const run = spawnSync('docker', ['exec', ...(input ? ['-i'] : []), container, ...args], { input, maxBuffer: 32 * 1024 * 1024 });
  if (run.status !== 0) throw new Error('Disposable database operation failed.');
  return run.stdout;
}
async function isolated(run) {
  const name = 'momo_db_test_outlook_' + randomUUID().replaceAll('-', '').slice(0, 12);
  docker(['createdb', '-U', username, name]);
  const db = createTestClient(name);
  try { await run(db, name); }
  finally { await db.end(); docker(['dropdb', '-U', username, name]); }
}
async function stage(db, id, occupied = false, generation = 0) {
  const scopes = occupied ? ['overall', 'season:season-a'] : [];
  await db`INSERT INTO series_analysis_artifacts(id,game_title_id,input_revision,algorithm_version,artifact_schema_version,
    source_input_checksum,root_checksum,aggregate_chunk_count,review_chunk_count,drilldown_chunk_count,match_context_chunk_count,
    outlook_summary_chunk_count,outlook_reference_chunk_count,encoded_bytes,decoded_bytes,scope_keys,radar_generation)
    VALUES (${id},'outlook-title',0,'series-analysis-v7',6,${checksum},${checksum},1,0,0,0,${occupied ? 2 : 1},${occupied ? 4 : 0},2,2,${scopes},${generation})`;
}
async function summary(db, id, scope = 'overall') {
  await db`INSERT INTO series_analysis_outlook_summary_artifacts(artifact_id,scope_key,scope_kind,season_master_id,
    payload,encoded_bytes,decoded_bytes,item_count,nesting_depth,checksum)
    VALUES (${id},${scope},${scope === 'overall' ? 'overall' : 'season'},${scope === 'overall' ? null : 'season-a'},${payload},2,2,0,1,${checksum})`;
}
async function references(db, id) {
  for (let i = 0; i < 4; ++i) await db`INSERT INTO series_analysis_outlook_reference_artifacts(artifact_id,scope_key,scope_kind,member_id,
    payload,encoded_bytes,decoded_bytes,item_count,nesting_depth,checksum)
    VALUES (${id},'overall','overall',${'member-' + i},${payload},2,2,1,1,${checksum})`;
}
async function publish(db, id) {
  await db`UPDATE series_analysis_artifacts SET validation_contract_id=${contract} WHERE id=${id}`;
  await db`UPDATE series_analysis_artifacts SET status='published',published_at=clock_timestamp() WHERE id=${id}`;
}

test('outlook seal requires complete bounded resources, then protects headers and child rows', async () => isolated(async db => {
  await migrate(drizzle(db), { migrationsFolder: './drizzle' });
  await db`INSERT INTO game_titles(id,name,layout_family) VALUES ('outlook-title','Outlook','momotetsu_2')`;
  await stage(db,'empty');
  await assert.rejects(publish(db,'empty'), /incomplete/);
  await summary(db,'empty');
  await publish(db,'empty');
  await assert.rejects(db`UPDATE series_analysis_outlook_summary_artifacts SET item_count=4 WHERE artifact_id='empty'`, /immutable/);
  await assert.rejects(db`UPDATE series_analysis_artifacts SET outlook_summary_chunk_count=2 WHERE id='empty'`, /immutable/);
  await stage(db,'full',true);
  await summary(db,'full');
  await references(db,'full');
  await assert.rejects(publish(db,'full'), /incomplete/);
  await summary(db,'full','season:season-a');
  await db`UPDATE series_analysis_artifacts SET validation_contract_id=${contract} WHERE id='full'`;
  await assert.rejects(db`DELETE FROM series_analysis_outlook_reference_artifacts WHERE artifact_id='full'`, /immutable/);
  await db`UPDATE series_analysis_artifacts SET status='published',published_at=clock_timestamp() WHERE id='full'`;
  await assert.rejects(db`INSERT INTO series_analysis_outlook_reference_artifacts(artifact_id,scope_key,scope_kind,member_id,payload,encoded_bytes,decoded_bytes,item_count,nesting_depth,checksum)
    VALUES ('full','overall','overall','extra',${payload},2,2,1,1,${checksum})`, /immutable/);
  await stage(db,'invalid');
  await assert.rejects(db`INSERT INTO series_analysis_outlook_summary_artifacts(artifact_id,scope_key,scope_kind,map_master_id,payload,encoded_bytes,decoded_bytes,item_count,nesting_depth,checksum)
    VALUES ('invalid','map:map-a','map','map-a',${payload},2,2,0,1,${checksum})`, {code:'23514'});
  await assert.rejects(db`INSERT INTO series_analysis_outlook_reference_artifacts(artifact_id,scope_key,scope_kind,member_id,payload,encoded_bytes,decoded_bytes,item_count,nesting_depth,checksum)
    VALUES ('invalid','overall','overall','member-a',${payload},2,2,2772,1,${checksum})`, {code:'23514'});
  await db`DELETE FROM series_analysis_artifacts WHERE id IN ('empty','full','invalid')`;
  assert.equal((await db`SELECT count(*)::int AS n FROM series_analysis_outlook_summary_artifacts`)[0].n,0);
  assert.equal((await db`SELECT count(*)::int AS n FROM series_analysis_outlook_reference_artifacts`)[0].n,0);
}));

test('outlook generation retains the radar fence and previous-artifact compatibility boundary', async () => isolated(async db => {
  await migrate(drizzle(db), { migrationsFolder: './drizzle' });
  await db`INSERT INTO game_titles(id,name,layout_family) VALUES ('outlook-title','Outlook','momotetsu_2')`;
  await db`UPDATE series_analysis_title_states SET algorithm_version='series-analysis-v7',artifact_schema_version=6,validation_contract_id=${contract}`;
  await db`INSERT INTO series_radar_title_states(game_title_id,generation) VALUES ('outlook-title',1)`;
  await stage(db,'stale'); await summary(db,'stale'); await publish(db,'stale');
  await assert.rejects(db`UPDATE series_analysis_title_states SET current_artifact_id='stale'`, /generation/);
  await stage(db,'current',false,1); await summary(db,'current'); await publish(db,'current');
  await db`UPDATE series_analysis_title_states SET current_artifact_id='current'`;
  await assert.rejects(db`DELETE FROM series_analysis_artifacts WHERE id='current'`, {code:'23001'});
  await assert.rejects(db`UPDATE series_analysis_release_state SET artifact_schema_version=5,validation_contract_id=${contract}`, {code:'23514'});
}));

test('restored v5 publications and migration hashes survive the new tables and guards', async () => isolated(async (source,name) => {
  const folder = mkdtempSync(join(tmpdir(),'momo-db-outlook-prefix-'));
  try {
    cpSync('./drizzle',folder,{recursive:true});
    const journalPath=join(folder,'meta','_journal.json');
    const journal=JSON.parse(readFileSync(journalPath,'utf8')); journal.entries=journal.entries.filter(entry=>entry.idx<=59);
    writeFileSync(journalPath,JSON.stringify(journal));
    await migrate(drizzle(source),{migrationsFolder:folder});
  } finally { rmSync(folder,{recursive:true,force:true}); }
  await source`INSERT INTO game_titles(id,name,layout_family) VALUES ('outlook-title','Outlook','momotetsu_2')`;
  const oldContract='series-analysis-artifact-v5-full-validation-v1';
  await source`UPDATE series_analysis_title_states SET algorithm_version='series-analysis-v6',artifact_schema_version=5,validation_contract_id=${oldContract}`;
  await source`INSERT INTO series_analysis_artifacts(id,game_title_id,input_revision,algorithm_version,artifact_schema_version,source_input_checksum,root_checksum,
    aggregate_chunk_count,review_chunk_count,drilldown_chunk_count,match_context_chunk_count,encoded_bytes,decoded_bytes)
    VALUES ('legacy','outlook-title',0,'series-analysis-v6',5,${checksum},${checksum},1,0,0,0,2,2)`;
  await source`UPDATE series_analysis_artifacts SET validation_contract_id=${oldContract} WHERE id='legacy'`;
  await source`UPDATE series_analysis_artifacts SET status='published',published_at=clock_timestamp() WHERE id='legacy'`;
  await source`UPDATE series_analysis_title_states SET current_artifact_id='legacy',notification_baseline_state='artifact',notification_baseline_artifact_id='legacy'`;
  const beforeHeaders=await source`SELECT to_jsonb(a) AS value FROM series_analysis_artifacts a ORDER BY id`;
  const beforeStates=await source`SELECT to_jsonb(s) AS value FROM series_analysis_title_states s ORDER BY game_title_id`;
  const beforeHashes=await source`SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id`;
  const backup=docker(['pg_dump','-U',username,'--format=custom','--no-owner','--no-acl',name]);
  await isolated(async (copy,restored) => {
    docker(['pg_restore','-U',username,'--exit-on-error','--no-owner','--no-acl','-d',restored],backup);
    await migrate(drizzle(copy),{migrationsFolder:'./drizzle'});
    assert.deepEqual(await copy`SELECT to_jsonb(a)-'outlook_summary_chunk_count'-'outlook_reference_chunk_count' AS value FROM series_analysis_artifacts a ORDER BY id`,beforeHeaders);
    assert.deepEqual(await copy`SELECT to_jsonb(s) AS value FROM series_analysis_title_states s ORDER BY game_title_id`,beforeStates);
    assert.deepEqual((await copy`SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id`).slice(0,beforeHashes.length),Array.from(beforeHashes));
    assert.equal((await copy`SELECT outlook_summary_chunk_count,outlook_reference_chunk_count FROM series_analysis_artifacts WHERE id='legacy'`)[0].outlook_reference_chunk_count,0);
    await copy`UPDATE series_analysis_title_states SET current_artifact_id=NULL,algorithm_version='series-analysis-v7',artifact_schema_version=6,validation_contract_id=${contract}`;
    await assert.rejects(copy`UPDATE series_analysis_title_states SET previous_artifact_id='legacy'`, /attested publication/);
    assert.equal((await copy`SELECT notification_baseline_artifact_id FROM series_analysis_title_states`)[0].notification_baseline_artifact_id,'legacy');
  });
}));
