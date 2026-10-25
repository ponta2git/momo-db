import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { test } from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createTestClient } from './notification-fixtures.mjs';
import { docker, username } from './migration-fixtures.mjs';

// Exercise real PostgreSQL constraints and ownership; derived scoring is a consumer contract.
test('achievement roots retain corrections and retirement survives artifact cleanup', async () => {
  const name = 'momo_db_test_achievements_' + randomUUID().replaceAll('-', '').slice(0, 10);
  docker(['createdb', '-U', username, name]);
  const db = createTestClient(name);
  try {
    await migrate(drizzle(db), { migrationsFolder: './drizzle' });
    const [title, member, actor, item, claim, generation] = Array.from({length:6}, randomUUID);
    await db`INSERT INTO game_titles(id,legacy_id,name,layout_family) VALUES (${title},'achievement-title','Achievement title','momotetsu_2')`;
    await db`INSERT INTO members(id,legacy_id,user_id,display_name) VALUES (${member},'achievement-member','achievement-user','Player')`;
    await db`INSERT INTO momo_login_accounts(id,legacy_id,discord_user_id,display_name) VALUES (${actor},'achievement-account','achievement-account','Actor')`;
    await db`INSERT INTO achievement_items(id,game_title_id,name,stars,rule_kind,scope_kind) VALUES (${item},${title},'Manual',3,'manual','common')`;
    await assert.rejects(db`INSERT INTO achievement_items(id,game_title_id,name,stars,rule_kind,scope_kind) VALUES (${randomUUID()},${title},'Invalid automatic',3,'total_assets','common')`, {code:'23514'});
    await assert.rejects(db`DELETE FROM game_titles WHERE id=${title}`, {code:'23001'});
    await db`INSERT INTO achievement_claims(id,item_id,member_id,source_kind,state,generation_id,updated_by_account_id) VALUES (${claim},${item},${member},'import','achieved',${generation},${actor})`;
    await assert.rejects(db`INSERT INTO achievement_claims(id,item_id,member_id,source_kind,state,generation_id,updated_by_account_id) VALUES (${randomUUID()},${item},${member},'import','achieved',${randomUUID()},${actor})`,{code:'23505'});
    await db`INSERT INTO achievement_retired_manual_sources(item_id,claim_id,generation_id) VALUES (${item},${claim},${generation})`;
    await db`UPDATE achievement_claims SET state='cancelled',version=version+1 WHERE id=${claim}`;
    assert.deepEqual([...await db`SELECT state, version::text, generation_id FROM achievement_claims WHERE id=${claim}`], [{state:'cancelled',version:'2',generation_id:generation}]);
    await assert.rejects(db`DELETE FROM achievement_retired_manual_sources WHERE item_id=${item}`, {code:'23514'});
    await db`INSERT INTO achievement_retired_snapshots(item_id,format_version,source_input_revision,snapshot) VALUES (${item},1,0,${JSON.stringify({definition:{achievementId:item},players:[]})}::jsonb)`;
    await assert.rejects(db`UPDATE achievement_retired_snapshots SET snapshot='{}'::jsonb WHERE item_id=${item}`, {code:'23514'});
    await assert.rejects(db`DELETE FROM achievement_retired_snapshots WHERE item_id=${item}`, {code:'23514'});
    const payload=Buffer.from('{}');
    const checksum='sha256:'+createHash('sha256').update(payload).digest('hex');
    await db`INSERT INTO series_analysis_artifacts(id,game_title_id,input_revision,algorithm_version,artifact_schema_version,source_input_checksum,root_checksum,aggregate_chunk_count,review_chunk_count,drilldown_chunk_count,match_context_chunk_count,achievement_chunk_count,encoded_bytes,decoded_bytes) VALUES ('achievement-artifact','achievement-title',0,'series-analysis-v8',7,${checksum},${checksum},1,0,0,0,1,2,2)`;
    await db`INSERT INTO series_analysis_achievement_artifacts(artifact_id,scope_key,scope_kind,payload,encoded_bytes,decoded_bytes,item_count,nesting_depth,checksum) VALUES ('achievement-artifact','overall','overall',${payload},2,2,0,1,${checksum})`;
    await db`UPDATE series_analysis_artifacts SET validation_contract_id='series-analysis-artifact-v7-full-validation-v1' WHERE id='achievement-artifact'`;
    await assert.rejects(db`UPDATE series_analysis_achievement_artifacts SET item_count=1 WHERE artifact_id='achievement-artifact'`, /immutable/);
    await db`UPDATE series_analysis_artifacts SET status='published',published_at=now() WHERE id='achievement-artifact'`;
    await assert.rejects(db`DELETE FROM series_analysis_achievement_artifacts WHERE artifact_id='achievement-artifact'`, /immutable/);
    await db`DELETE FROM series_analysis_artifacts WHERE id='achievement-artifact'`;
    assert.equal((await db`SELECT count(*)::int n FROM series_analysis_achievement_artifacts`)[0].n,0);
    assert.equal((await db`SELECT count(*)::int n FROM achievement_retired_snapshots`)[0].n,1);
  } finally {
    await db.end();
    docker(['dropdb','-U',username,name]);
  }
});
