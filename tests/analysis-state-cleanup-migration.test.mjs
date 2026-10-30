import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { inspectSchema } from '../scripts/migration/inventory.mjs';
import { schemaStructure } from '../scripts/migration/schema.mjs';
import { createTestClient } from './notification-fixtures.mjs';
import { docker, username } from './migration-fixtures.mjs';
import { migrateThrough } from './migration-prefix.mjs';
import { seedCanonicalSource, legacy } from './canonical-identity-fixtures.mjs';

const fullHistory = db => migrate(drizzle(db), { migrationsFolder: './drizzle' });
const targetCheck = 'series_analysis_campaign_targets_status_check';
const removedCheck = 'series_analysis_title_states_pending_forced_run_count_check';
const removedColumns = {
  series_analysis_title_states: 'pending_forced_run_count',
  series_analysis_job_requests: 'force_run',
};
const statuses = ['pending', 'expanded', 'running', 'succeeded', 'failed', 'skipped_title_deleted'];

async function isolated(run) {
  const name = 'momo_db_test_analysis_state_' + randomUUID().replaceAll('-', '').slice(0, 12);
  docker(['createdb', '-U', username, name]);
  const db = createTestClient(name);
  try { return await run(db, name); }
  finally { await db.end(); docker(['dropdb', '-U', username, name]); }
}

// SQL text retains bigint, decimal and JSON precision in the existing cross-domain fixture.
async function snapshot(db, projectTail = false) {
  return db.begin('isolation level repeatable read read only', async sql => {
    await sql.unsafe("SET LOCAL search_path = pg_catalog, public; SET LOCAL timezone = 'UTC'");
    const rows = {};
    for (const { tablename } of await sql`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`) {
      let value = sql`to_jsonb(record)`;
      if (projectTail && removedColumns[tablename]) value = sql`${value} - ${removedColumns[tablename]}::text`;
      if (projectTail && tablename === 'series_analysis_campaign_targets') {
        value = sql`${value} || jsonb_build_object('status', CASE WHEN record.status='running' THEN 'expanded' ELSE record.status END)`;
      }
      rows[tablename] = (await sql`SELECT (${value})::text COLLATE "C" AS value FROM ${sql(tablename)} record ORDER BY value`).map(row => row.value);
    }
    return {
      rows,
      schema: schemaStructure(await inspectSchema(sql)),
      history: [...await sql`SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id`],
    };
  });
}

function expectedSchema(before) {
  const expected = structuredClone(before);
  for (const table of expected.tables) {
    if (table.schema !== 'public') continue;
    if (removedColumns[table.name]) table.columns = table.columns.filter(column => column.name !== removedColumns[table.name]);
    table.constraints = table.constraints.filter(constraint => constraint.name !== removedCheck
      && !(constraint.kind === 'n' && constraint.columns.length === 1 && constraint.columns[0] === removedColumns[table.name]));
    for (const constraint of table.constraints) {
      if (constraint.name === targetCheck) constraint.definition = constraint.definition.replace(", 'running'::text", '');
    }
    table.checks = table.constraints.filter(constraint => constraint.kind === 'c');
  }
  return expected;
}

async function representative(db) {
  await migrateThrough(db, 82);
  await seedCanonicalSource(db);
  await migrateThrough(db, 100);
  // Keep achievement definitions, ordering, evidence and retirement records in
  // the restored latest-schema fixture as well as the older cross-domain data.
  const [{ id: achievementTitle }] = await db`SELECT id FROM game_titles WHERE legacy_id=${legacy.title}`;
  const [{ id: member }] = await db`SELECT id FROM members WHERE legacy_id=${legacy.member}`;
  const [{ id: actor }] = await db`SELECT id FROM momo_login_accounts WHERE legacy_id=${legacy.account}`;
  const [{ id: map }] = await db`SELECT id FROM map_masters WHERE game_title_id=${achievementTitle} LIMIT 1`;
  const [activeItem, retiredItem, claim, generation] = Array.from({ length: 4 }, randomUUID);
  await db`INSERT INTO achievement_items(id,game_title_id,name,stars,rule_kind,scope_kind,sort_order,applies_from,version)
    VALUES (${activeItem},${achievementTitle},'Active map achievement',2,'manual','maps',3,NULL,2),
      (${retiredItem},${achievementTitle},'Retired achievement',4,'manual','common',7,'2026-10-24',1)`;
  await db`INSERT INTO achievement_item_maps(item_id,map_master_id) VALUES (${activeItem},${map})`;
  await db`UPDATE achievement_items SET retired_at='2026-10-25' WHERE id=${retiredItem}`;
  await db`INSERT INTO achievement_claims(id,item_id,member_id,source_kind,state,generation_id,updated_by_account_id)
    VALUES (${claim},${retiredItem},${member},'import','achieved',${generation},${actor})`;
  await db`INSERT INTO achievement_retired_manual_sources(item_id,claim_id,generation_id) VALUES (${retiredItem},${claim},${generation})`;
  await db`INSERT INTO achievement_retired_snapshots(item_id,format_version,source_input_revision,snapshot)
    VALUES (${retiredItem},1,7,'{"definition":{"name":"Retired achievement"},"players":[]}')`;
  await db`UPDATE series_analysis_title_states SET pending_forced_run_count=7 WHERE game_title_id=(SELECT id FROM game_titles WHERE legacy_id=${legacy.title})`;
  await db`UPDATE series_analysis_job_requests SET force_run=true WHERE legacy_id=${legacy.request}`;
  const operation = randomUUID(); const campaign = randomUUID();
  await db`INSERT INTO series_analysis_operation_requests(id,legacy_id,scope,idempotency_key_hash,endpoint,status,target_count)
    VALUES (${operation},${operation},'all_titles','state-cleanup-test','/analysis','running',6)`;
  await db`INSERT INTO series_analysis_campaigns(id,legacy_id,operation_request_id,trigger,algorithm_version,artifact_schema_version,status,target_count,expanded_count,terminal_count,failed_count,skipped_count)
    VALUES (${campaign},${campaign},${operation},'manual','test-v1',1,'running',6,5,3,1,1)`;
  for (const status of statuses) {
    const title = randomUUID(); const request = randomUUID();
    await db`INSERT INTO game_titles(id,legacy_id,name,layout_family) VALUES (${title},${title},${status},'momotetsu_2')`;
    await db`INSERT INTO series_analysis_title_states(game_title_id,input_revision,pending_forced_run_count,pending_work)
      VALUES (${title},7,0,true)`;
    await db`INSERT INTO series_analysis_job_requests(id,legacy_id,game_title_id,legacy_game_title_id,campaign_id,input_revision,algorithm_version,artifact_schema_version,trigger,force_run)
      VALUES (${request},${request},${title},${title},${campaign},7,'test-v1',1,'manual',false)`;
    await db`INSERT INTO series_analysis_campaign_targets(campaign_id,game_title_id,legacy_game_title_id,input_revision,algorithm_version,artifact_schema_version,status,job_request_id,legacy_job_request_id,accepted_at,updated_at)
      VALUES (${campaign},${title},${title},7,'test-v1',1,${status},${request},${request},'2026-01-01','2026-01-02')`;
  }
}

test('analysis state tail preserves restored rows and every unrelated schema object', async () => isolated(async (source, sourceName) => {
  await representative(source);
  const before = await snapshot(source);
  const expected = await snapshot(source, true);
  const backup = docker(['pg_dump','-U',username,'--format=custom','--no-owner','--no-acl',sourceName]);
  await isolated(async (copy, copyName) => {
    docker(['pg_restore','-U',username,'--exit-on-error','--no-owner','--no-acl','-d',copyName], backup);
    assert.deepEqual(await snapshot(copy), before, 'backup restores all original values and mechanisms');
    await fullHistory(copy);
    const after = await snapshot(copy);
    assert.deepEqual(after.rows, expected.rows, 'only running targets and the two retired fields change');
    assert.deepEqual(after.schema, expectedSchema(before.schema), 'constraints, indexes, functions, triggers and other schema are preserved');
    assert.deepEqual(after.history.slice(0, before.history.length), before.history);
    assert.equal(after.history.length, before.history.length + 2);
    const [target] = await copy`SELECT campaign_id,game_title_id FROM series_analysis_campaign_targets LIMIT 1`;
    await assert.rejects(copy`UPDATE series_analysis_campaign_targets SET status='running' WHERE campaign_id=${target.campaign_id} AND game_title_id=${target.game_title_id}`, {code:'23514'});
    for (const status of statuses.filter(status => status !== 'running')) {
      await copy.begin(async sql => {
        await sql`UPDATE series_analysis_campaign_targets SET status=${status} WHERE campaign_id=${target.campaign_id} AND game_title_id=${target.game_title_id}`;
      });
    }
    const final = await snapshot(copy);
    await fullHistory(copy);
    assert.deepEqual(await snapshot(copy), final, 'ordinary migrator is a no-op on second execution');
  });
}));

test('fresh history applies the cleanup and removes the public fields', async () => isolated(async db => {
  await fullHistory(db);
  const { seriesAnalysisJobRequests, seriesAnalysisTitleStates } = await import('../dist/schema.js');
  assert.equal(Object.hasOwn(seriesAnalysisJobRequests, 'forceRun'), false);
  assert.equal(Object.hasOwn(seriesAnalysisTitleStates, 'pendingForcedRunCount'), false);
  const schema = (await snapshot(db)).schema;
  for (const [name, removed] of Object.entries(removedColumns)) {
    assert.equal(schema.tables.find(table => table.name === name).columns.some(column => column.name === removed), false);
  }
}));

for (const table of ['series_analysis_title_states', 'series_analysis_job_requests', 'series_analysis_campaign_targets']) {
  test(`a concurrent ${table} writer rejects the tail before changing data, schema or history`, async () => isolated(async db => {
    await representative(db);
    const before = await snapshot(db);
    await db.begin(async sql => {
      await sql`LOCK TABLE ${sql(table)} IN ROW EXCLUSIVE MODE`;
      await assert.rejects(fullHistory(db), error => {
        const failure = error.cause ?? error;
        // Distinguish NOWAIT from waiting until the connection's lock timeout.
        return failure.code === '55P03' && failure.message.includes('could not obtain lock on relation');
      });
    });
    assert.deepEqual(await snapshot(db), before);
  }));
}

test('an unknown column dependency rejects the contract and rolls back running normalization', async () => isolated(async db => {
  await representative(db);
  await db`CREATE VIEW retained_analysis_force_run AS SELECT force_run FROM series_analysis_job_requests`;
  const before = await snapshot(db);
  await assert.rejects(fullHistory(db), error => (error.code ?? error.cause?.code) === '2BP01');
  assert.deepEqual(await snapshot(db), before, 'data, schema and ledger rows roll back together');
}));
