import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createTestClient } from './notification-fixtures.mjs';
import { docker, snapshotDatabase, username } from './migration-fixtures.mjs';
import { migrateThrough } from './migration-prefix.mjs';

async function isolated(run) {
  const name = 'momo_db_test_achievement_order_' + randomUUID().replaceAll('-', '').slice(0, 10);
  docker(['createdb', '-U', username, name]);
  const db = createTestClient(name);
  try { await run(db, name); }
  finally { await db.end(); docker(['dropdb', '-U', username, name]); }
}
// Preserve this historical transition's contract; later state cleanup has its own restore test.
const previous = db => migrateThrough(db, 97);
const achievementTail = db => migrateThrough(db, 100);

test('achievement order and lifetime tail preserves restored evidence and schedules only changed titles', async () => {
  await isolated(async db => { await migrate(drizzle(db), { migrationsFolder: './drizzle' }); });
  await isolated(async (source, name) => {
    await previous(source);
    const [title, otherTitle, map, member, account, limited, common, retired, claim] = Array.from({ length: 9 }, randomUUID);
    for (const id of [title, otherTitle]) {
      await source`INSERT INTO game_titles(id,legacy_id,name,layout_family) VALUES (${id},${id},${'Title ' + id},'momotetsu_2')`;
      await source`INSERT INTO series_analysis_title_states(game_title_id,input_revision,algorithm_version,artifact_schema_version,validation_contract_id)
        VALUES (${id},5,'series-analysis-v8',7,'series-analysis-artifact-v7-full-validation-v1')`;
    }
    await source`INSERT INTO map_masters(id,legacy_id,game_title_id,name) VALUES (${map},${map},${title},'East')`;
    await source`INSERT INTO members(id,legacy_id,user_id,display_name) VALUES (${member},${member},${member},'Player')`;
    await source`INSERT INTO momo_login_accounts(id,legacy_id,discord_user_id,display_name) VALUES (${account},${account},${account},'Account')`;
    await source`INSERT INTO achievement_items(id,game_title_id,name,stars,rule_kind,scope_kind,applies_from)
      VALUES (${limited},${title},'Map achievement',2,'manual','maps','2026-10-24'),
        (${common},${title},'Common achievement',3,'manual','common',NULL),
        (${retired},${title},'Retired achievement',4,'manual','common','2026-10-24')`;
    await source`INSERT INTO achievement_item_maps(item_id,map_master_id) VALUES (${limited},${map})`;
    await source`UPDATE achievement_items SET retired_at='2026-10-24T12:00:00Z' WHERE id=${retired}`;
    await source`INSERT INTO achievement_claims(id,item_id,member_id,source_kind,state,generation_id,updated_by_account_id)
      VALUES (${claim},${limited},${member},'import','achieved',${randomUUID()},${account})`;
    const before = await snapshotDatabase(source);
    const dump = docker(['pg_dump','-U',username,'--format=custom','--no-owner','--no-acl',name]);
    await isolated(async (copy, restored) => {
      docker(['pg_restore','-U',username,'--exit-on-error','--no-owner','--no-acl','-d',restored], dump);
      assert.deepEqual(await snapshotDatabase(copy), before);
      await achievementTail(copy);
      const after = await snapshotDatabase(copy);
      const changedTables = new Set(['achievement_items','series_analysis_title_states','series_analysis_job_requests']);
      for (const [table, rows] of Object.entries(before.rows)) {
        if (!changedTables.has(table)) assert.deepEqual(after.rows[table], rows, table + ' preserved');
      }
      const items = [...await copy`SELECT id,sort_order,applies_from::text,version::text FROM achievement_items ORDER BY sort_order`];
      assert.deepEqual(items, [
        {id:limited,sort_order:0,applies_from:null,version:'2'},
        {id:common,sort_order:1,applies_from:null,version:'1'},
        {id:retired,sort_order:2,applies_from:'2026-10-24',version:'1'},
      ]);
      for (const row of after.rows.achievement_items) {
        const old = before.rows.achievement_items.find(item => item.id === row.id);
        const { sort_order, applies_from, version, updated_at, ...preserved } = row;
        const { applies_from: oldStart, version: oldVersion, updated_at: oldUpdated, ...oldPreserved } = old;
        assert.deepEqual(preserved, oldPreserved);
      }
      assert.deepEqual([...await copy`SELECT input_revision::text,pending_work FROM series_analysis_title_states WHERE game_title_id=${title}`], [{input_revision:'6',pending_work:true}]);
      assert.deepEqual(after.rows.series_analysis_title_states.find(row => row.game_title_id === otherTitle), before.rows.series_analysis_title_states.find(row => row.game_title_id === otherTitle));
      const [request] = await copy`SELECT game_title_id,input_revision::text,trigger,status,assigned_job_id FROM series_analysis_job_requests`;
      assert.deepEqual(request, {game_title_id:title,input_revision:'6',trigger:'achievement_mutation',status:'pending',assigned_job_id:null});
      await assert.rejects(copy`UPDATE series_analysis_title_states SET validation_contract_id='series-analysis-artifact-v8-full-validation-v1' WHERE game_title_id=${otherTitle}`, {code:'23514'});
      await copy`UPDATE series_analysis_title_states SET algorithm_version='series-analysis-v9',artifact_schema_version=8,validation_contract_id='series-analysis-artifact-v8-full-validation-v1' WHERE game_title_id=${otherTitle}`;
      assert.deepEqual(after.history.slice(0,before.history.length), before.history);
      const final = await snapshotDatabase(copy);
      await achievementTail(copy);
      assert.deepEqual(await snapshotDatabase(copy), final);
    });
  });
});
