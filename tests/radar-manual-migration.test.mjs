import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createTestClient, resetFixtures } from './notification-fixtures.mjs';
import { docker, expectedJobSchedulerRows, expectedPublicIdentifierRows, snapshotDatabase, username } from './migration-fixtures.mjs';

async function isolated(run) {
  const name = 'momo_db_test_manual_' + randomUUID().replaceAll('-', '').slice(0,12);
  docker(['createdb','-U',username,name]);
  const db = createTestClient(name);
  try { await run(db,name); }
  finally { await db.end(); docker(['dropdb','-U',username,name]); }
}
async function previous(db) {
  const folder = mkdtempSync(join(tmpdir(),'radar-manual-prefix-'));
  try {
    cpSync('./drizzle',folder,{recursive:true});
    const journal = JSON.parse(readFileSync(join(folder,'meta/_journal.json'),'utf8'));
    journal.entries = journal.entries.filter(entry => entry.idx <= 64);
    writeFileSync(join(folder,'meta/_journal.json'),JSON.stringify(journal));
    await migrate(drizzle(db),{migrationsFolder:folder});
  } finally { rmSync(folder,{recursive:true,force:true}); }
}
const checksum = 'sha256:'+'a'.repeat(64);
async function seed(db) {
  await resetFixtures(db);
  const payload=Buffer.from('{}');
  const contract='series-analysis-artifact-v6-full-validation-v1';
  await db`UPDATE series_analysis_title_states SET algorithm_version='series-analysis-v7',artifact_schema_version=6,validation_contract_id=${contract} WHERE game_title_id='notification-title'`;
  await db`INSERT INTO series_analysis_artifacts(id,game_title_id,input_revision,algorithm_version,artifact_schema_version,
    source_input_checksum,root_checksum,aggregate_chunk_count,review_chunk_count,drilldown_chunk_count,match_context_chunk_count,
    outlook_summary_chunk_count,outlook_reference_chunk_count,encoded_bytes,decoded_bytes)
    SELECT 'legacy-v1','notification-title',input_revision,'series-analysis-v7',6,${checksum},${checksum},1,0,0,0,1,0,2,2 FROM series_analysis_title_states WHERE game_title_id='notification-title'`;
  await db`INSERT INTO series_analysis_outlook_summary_artifacts(artifact_id,scope_key,scope_kind,payload,encoded_bytes,decoded_bytes,item_count,nesting_depth,checksum)
    VALUES ('legacy-v1','overall','overall',${payload},2,2,0,1,${checksum})`;
  await db`UPDATE series_analysis_artifacts SET validation_contract_id=${contract} WHERE id='legacy-v1'`;
  await db`UPDATE series_analysis_artifacts SET status='published',published_at=clock_timestamp() WHERE id='legacy-v1'`;
  await db`UPDATE series_analysis_title_states SET current_artifact_id='legacy-v1' WHERE game_title_id='notification-title'`;
  await db`INSERT INTO series_radar_bases(id,game_title_id,checksum,payload,source_snapshot,source_checksum,source_input_revision)
    VALUES ('old-basis','notification-title',${checksum},'{}','{"matches":[]}',${checksum},0)`;
  await db`INSERT INTO series_radar_candidates(id,game_title_id,basis_id,status)
    VALUES ('old-candidate','notification-title','old-basis','applied')`;
  await db`INSERT INTO series_radar_previews(id,game_title_id,candidate_id,input_revision,status)
    VALUES ('old-preview','notification-title','old-candidate',0,'ready')`;
  await db`INSERT INTO series_radar_operations(id,game_title_id,kind,status,candidate_id,preview_id,basis_id,requested_by,idempotency_key_hash,request_fingerprint,finished_at)
    VALUES ('old-apply','notification-title','apply','succeeded','old-candidate','old-preview','old-basis','notification-account','old-key','old-hash','2026-01-01')`;
}
test('manual radar tail applies fresh and preserves restored rows while backfilling only successful publications', async () => {
  await isolated(async db => { await migrate(drizzle(db),{migrationsFolder:'./drizzle'}); });
  await isolated(async (source,name) => {
    await previous(source); await seed(source);
    const before = await snapshotDatabase(source);
    const dump = docker(['pg_dump','-U',username,'--format=custom','--no-owner','--no-acl',name]);
    await isolated(async (copy,restored) => {
      docker(['pg_restore','-U',username,'--exit-on-error','--no-owner','--no-acl','-d',restored],dump);
      assert.deepEqual(await snapshotDatabase(copy),before);
      await migrate(drizzle(copy),{migrationsFolder:'./drizzle'});
      const after = await snapshotDatabase(copy);
      for (const [table,rows] of Object.entries(expectedPublicIdentifierRows(expectedJobSchedulerRows(before.rows)))) {
        const expected = table === 'series_radar_candidates'
          ? rows.map(row => ({...row,origin_kind:'generated',manual_input:null,source_basis_id:null,source_candidate_id:null,saved_by:null,saved_by_display_name:null}))
          : table === 'series_radar_operations' ? rows.map(row => ({...row,requested_by_display_name:null})) : rows;
        assert.deepEqual(after.rows[table],expected,table+' must preserve every old value');
      }
      assert.deepEqual(after.history.slice(0,before.history.length),before.history);
      const [revision] = await copy`SELECT * FROM series_radar_revisions`;
      assert.equal(revision.operation_id,'old-apply');
      assert.equal(revision.before_basis_id,null);
      assert.equal(revision.after_basis_id,'old-basis');
      assert.equal(revision.requested_by_display_name,null);
      await assert.rejects(copy`UPDATE series_radar_revisions SET requested_by='changed'`,/immutable/);
      await copy`INSERT INTO series_radar_candidates(id,game_title_id,origin_kind,manual_input,source_basis_id,saved_by)
        VALUES ('manual','notification-title','manual','{"axes":[]}','old-basis','notification-account')`;
      await assert.rejects(copy`UPDATE series_radar_candidates SET manual_input='{}' WHERE id='manual'`,/immutable/);
      await copy`UPDATE series_radar_candidates SET status='failed' WHERE id='manual'`;
      const final = await snapshotDatabase(copy);
      await migrate(drizzle(copy),{migrationsFolder:'./drizzle'});
      assert.deepEqual(await snapshotDatabase(copy),final);
    });
  });
});
