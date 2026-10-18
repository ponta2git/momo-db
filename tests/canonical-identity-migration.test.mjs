import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { canonicalIdentity, canonicalUuid } from '../scripts/identity/canonical.mjs';
import { createTestClient } from './notification-fixtures.mjs';
import { docker, username } from './migration-fixtures.mjs';
import { migrateThrough, migrateLegacy, withMigrationPrefix } from './migration-prefix.mjs';
import { seedCanonicalSource, legacy, validationContract, payload, checksum } from './canonical-identity-fixtures.mjs';

const contract = JSON.parse(readFileSync('./docs/contracts/canonical-identities-v1.json', 'utf8'));
const vectors = JSON.parse(readFileSync('./tests/fixtures/canonical-identities-v1.json', 'utf8'));
const sourceSchema = JSON.parse(readFileSync('./drizzle/meta/0082_snapshot.json', 'utf8'));
const targetSchema = JSON.parse(readFileSync('./drizzle/meta/0093_snapshot.json', 'utf8'));
const converted = contract.columns.filter(column => column.sourceType !== 'uuid' && column.targetType === 'uuid');
// This historical gate verifies the complete 0093 canonical contract. The
// separately tested retirement tail owns the later removal of the shared slot.
const latest = db => migrateThrough(db, 93);
const identity = (entity, value) => canonicalIdentity(entity, value);
const q = value => '"' + value.replaceAll('"', '""') + '"';

async function isolated(run) {
  const name = 'momo_db_test_canonical_' + randomUUID().replaceAll('-', '').slice(0, 12);
  docker(['createdb', '-U', username, name]);
  const db = createTestClient(name);
  try { return await run(db, name); }
  finally { await db.end(); docker(['dropdb', '-U', username, name]); }
}

async function snapshot(db) {
  const rows = {};
  for (const { tablename } of await db`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`) {
    rows[tablename] = (await db`SELECT to_jsonb(record)::text AS value FROM ${db(tablename)} record
      ORDER BY to_jsonb(record)::text COLLATE "C"`).map(row => row.value);
  }
  const sequences = {};
  for (const { sequencename } of await db`SELECT sequencename FROM pg_sequences WHERE schemaname = 'public' ORDER BY sequencename`) {
    sequences[sequencename] = [...await db`SELECT last_value::text, is_called FROM ${db(sequencename)}`];
  }
  return { rows, sequences, history: [...await db`SELECT id::text, hash, created_at::text FROM drizzle.__drizzle_migrations record ORDER BY record.id`] };
}

async function mechanisms(db) {
  const [value] = await db`SELECT
    (SELECT jsonb_agg(to_jsonb(c) - 'table_catalog' - 'udt_catalog' ORDER BY c.table_name, c.ordinal_position)::text
      FROM information_schema.columns c WHERE c.table_schema = 'public') AS columns,
    (SELECT jsonb_agg(pg_get_functiondef(p.oid) ORDER BY p.proname)::text
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public') AS functions,
    (SELECT jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY c.relname, t.tgname)::text
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal) AS triggers,
    (SELECT jsonb_agg(jsonb_build_object('table', c.relname, 'name', con.conname, 'definition', pg_get_constraintdef(con.oid))
      ORDER BY c.relname, con.conname)::text FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public') AS constraints,
    (SELECT jsonb_agg(jsonb_build_object('name', indexname, 'definition', indexdef) ORDER BY tablename, indexname)::text
      FROM pg_indexes WHERE schemaname = 'public') AS indexes`;
  return { ...value };
}

// Use the independent JavaScript mapping only for changed scalar fields, and let
// PostgreSQL retain precise original JSON/numeric/timestamp representations.
async function expectedTargetRows(db) {
  const rows = {};
  for (const table of Object.values(sourceSchema.tables)) {
    const source = table.name;
    const changes = converted.filter(column => column.table === source);
    const pairs = [];
    const parameters = [];
    for (const column of changes) {
      const originals = await db.unsafe(`SELECT DISTINCT ${q(column.column)} AS value${source === 'worker_execution_slots' ? ', task_kind' : ''}
        FROM ${q(source)} WHERE ${q(column.column)} IS NOT NULL`);
      assert.ok(originals.length > 0, `${source}.${column.column} needs a non-null fixture`);
      const mapping = Object.fromEntries(originals.map(row => {
        let value;
        if (source === 'worker_execution_slots') {
          value = column.column === 'attempt_id' && row.task_kind === 'ocr' ? canonicalUuid(row.value)
            : identity(row.task_kind === 'ocr' ? 'ocr_jobs'
              : column.column === 'job_id' ? 'series_analysis_jobs' : 'series_analysis_job_attempts', row.value);
        } else value = identity(column.targetEntity ?? source, row.value);
        return [row.value, value];
      }));
      parameters.push(JSON.stringify(mapping));
      pairs.push(`'${column.column}', $${parameters.length}::text::jsonb ->> record.${q(column.column)}`);
    }
    for (const alias of contract.newLegacyColumns.filter(column => column.table === source)) {
      pairs.push(`'${alias.column}', record.${q(alias.sourceColumn)}`);
    }
    const projection = 'to_jsonb(record)' + (pairs.length ? ' || jsonb_build_object(' + pairs.join(', ') + ')' : '');
    rows[source === 'idempotency_keys' ? 'idempotency_keys_legacy' : source] =
      (await db.unsafe(`SELECT (${projection})::text AS value FROM ${q(source)} record ORDER BY (${projection})::text COLLATE "C"`, parameters)).map(row => row.value);
  }
  rows.idempotency_keys = [];
  for (const [source, target] of [['series_analysis_artifacts', 'series_analysis_artifact_identities'], ['series_radar_bases', 'series_radar_basis_identities']]) {
    const values = await db`SELECT id, game_title_id FROM ${db(source)}`;
    const expected = values.map(row => ({ id: identity(source, row.id), legacy_id: row.id,
      game_title_id: identity('game_titles', row.game_title_id), legacy_game_title_id: row.game_title_id }));
    rows[target] = (await db`SELECT value::text AS value FROM jsonb_array_elements(${JSON.stringify(expected)}::text::jsonb) value
      ORDER BY value::text COLLATE "C"`).map(row => row.value);
  }
  return rows;
}

const action = { 'no action': 'a', restrict: 'r', cascade: 'c', 'set null': 'n', 'set default': 'd' };
const signature = value => JSON.stringify(value);
async function assertTargetSchema(db) {
  const columns = [...await db`SELECT table_name, column_name, udt_name, is_nullable FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, column_name`];
  const expected = Object.values(targetSchema.tables).flatMap(table => Object.values(table.columns).map(column => ({
    table_name: table.name, column_name: column.name,
    udt_name: column.type === 'uuid' ? 'uuid' : null, is_nullable: column.notNull ? 'NO' : 'YES',
  })));
  assert.deepEqual(columns.map(({ table_name, column_name }) => `${table_name}.${column_name}`).sort(), expected.map(row => `${row.table_name}.${row.column_name}`).sort());
  for (const row of expected) {
    const actual = columns.find(column => column.table_name === row.table_name && column.column_name === row.column_name);
    assert.equal(actual.is_nullable, row.is_nullable, `${row.table_name}.${row.column_name} nullability`);
    if (row.udt_name) assert.equal(actual.udt_name, row.udt_name, `${row.table_name}.${row.column_name} native UUID`);
  }
  const foreignKeys = [...await db`SELECT source.relname AS source, target.relname AS target,
    ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY key(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = key.attnum ORDER BY key.ord) AS columns,
    ARRAY(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY key(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = key.attnum ORDER BY key.ord) AS target_columns,
    c.confdeltype AS delete, c.confupdtype AS update
    FROM pg_constraint c JOIN pg_class source ON source.oid = c.conrelid JOIN pg_class target ON target.oid = c.confrelid
    JOIN pg_namespace n ON n.oid = source.relnamespace WHERE n.nspname = 'public' AND c.contype = 'f'`];
  const expectedFks = Object.values(targetSchema.tables).flatMap(table => Object.values(table.foreignKeys).map(fk => ({
    source: table.name, target: fk.tableTo, columns: fk.columnsFrom, target_columns: fk.columnsTo,
    delete: action[fk.onDelete], update: action[fk.onUpdate],
  })));
  assert.deepEqual(foreignKeys.map(signature).sort(), expectedFks.map(signature).sort());
  // Independently retarget every source FK while retaining column order/actions.
  for (const table of Object.values(sourceSchema.tables)) for (const fk of Object.values(table.foreignKeys)) {
    const newSource = table.name === 'idempotency_keys' ? 'idempotency_keys_legacy' : table.name;
    const sourceConverted = fk.columnsFrom.map(name => converted.some(column => column.table === table.name && column.column === name));
    const anchor = contract.anchoredEntities.includes(fk.tableTo) && sourceConverted.some(Boolean);
    const target = anchor ? { series_analysis_artifacts: 'series_analysis_artifact_identities', series_radar_bases: 'series_radar_basis_identities' }[fk.tableTo] : fk.tableTo;
    const targetColumns = fk.columnsTo.map((name, index) => {
      if (anchor) return !sourceConverted[index] && name === 'id' ? 'legacy_id' : name;
      if (contract.mutableEntities.includes(fk.tableTo) && !sourceConverted[index]) return 'legacy_' + name;
      return name;
    });
    const expected = signature({ source: newSource, target, columns: fk.columnsFrom, target_columns: targetColumns,
      delete: action[fk.onDelete], update: action[fk.onUpdate] });
    assert.ok(foreignKeys.map(signature).includes(expected), `preserved source FK ${fk.name}`);
  }
  const [replay] = await db`SELECT array_agg(a.attname ORDER BY key.ord) AS columns FROM pg_constraint c
    CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY key(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = key.attnum
    WHERE c.conrelid = 'idempotency_keys'::regclass AND c.contype = 'p' GROUP BY c.oid`;
  assert.deepEqual(replay.columns, ['key', 'account_id', 'endpoint']);
  const [trigger] = await db`SELECT pg_get_triggerdef(oid) AS definition FROM pg_trigger
    WHERE tgname = 'series_analysis_title_states_artifact_pointer_guard'`;
  assert.match(trigger.definition, /UPDATE OF current_artifact_id, previous_artifact_id/u);
  assert.doesNotMatch(trigger.definition, /legacy_/u);
}

async function navigation(db, canonical = false) {
  return [...await db.unsafe(`SELECT ${canonical ? 'legacy_id' : 'id'} AS id FROM matches
    ORDER BY played_at, ${canonical ? 'legacy_held_event_id' : 'held_event_id'} COLLATE "C", match_no_in_event, ${canonical ? 'legacy_id' : 'id'} COLLATE "C"`)];
}

function mapperDefinition() {
  const sql = readFileSync('./drizzle/0085_backfill-canonical-identities.sql', 'utf8');
  return sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION pg_temp.momo_canonical_identity'), sql.indexOf('$mapping$;') + '$mapping$;'.length);
}

test('SQL typed mapping agrees with every shared vector and PostgreSQL UUID spelling without trimming', async () => isolated(async db => {
  await db.begin(async tx => {
    await tx.unsafe(mapperDefinition());
    const cases = [...vectors.cases];
    const groups = ['0011', '2233', '4455', '6677', '8899', 'aabb', 'ccdd', 'eeff'];
    for (let mask = 0; mask < 128; mask++) {
      const raw = groups.map((group, index) => (index && (mask & (1 << (index - 1))) ? '-' : '') + group).join('');
      for (const value of [raw, raw.toUpperCase(), `{${raw}}`, `{${raw.toUpperCase()}}`]) cases.push({ entity: 'members', legacy: value, canonical: '00112233-4455-6677-8899-aabbccddeeff' });
    }
    for (const value of ['', ' 00112233-4455-6677-8899-aabbccddeeff', '00112233-4455-6677-8899-aabbccddeeff\n', '00112233-4455-6677-8899-aabbccddeeff\r\n', '00112233--4455-6677-8899-aabbccddeeff']) cases.push({ entity: 'members', legacy: value, canonical: identity('members', value) });
    const rows = await tx`SELECT value->>'canonical' AS expected,
      pg_temp.momo_canonical_identity(value->>'entity', value->>'legacy')::text AS actual
      FROM jsonb_array_elements(${JSON.stringify(cases)}::text::jsonb) value`;
    for (const row of rows) assert.equal(row.actual, row.expected);
    await assert.rejects(tx.savepoint(savepoint => savepoint`SELECT pg_temp.momo_canonical_identity('member', 'synthetic')`), { code: '23514', message: 'CANONICAL_ID_UNKNOWN_ENTITY' });
  });
}));

test('fresh full migration exposes only the complete UUID shape and exact FK actions', async () => isolated(async db => {
  await latest(db); await assertTargetSchema(db);
  const before = await snapshot(db); const schema = await mechanisms(db); await latest(db);
  assert.deepEqual(await snapshot(db), before); assert.deepEqual(await mechanisms(db), schema);
}));

test('explicit analysis transition cutover changes no saved row and removes only the three assignment hooks', async () => isolated(async db => {
  await migrateLegacy(db); await seedCanonicalSource(db);
  const before = await snapshot(db); await migrateThrough(db, 83); const after = await snapshot(db);
  assert.deepEqual(after.rows, before.rows); assert.deepEqual(after.sequences, before.sequences);
  assert.deepEqual(after.history.slice(0, before.history.length), before.history);
  assert.equal((await db`SELECT count(*)::int AS count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('ensure_series_analysis_title_state','bind_series_analysis_radar_job','clear_series_analysis_lease_validation_contract')`)[0].count, 0);
  await db`INSERT INTO game_titles(id, name, layout_family) VALUES ('explicit-title', 'Explicit title', 'world')`;
  assert.equal((await db`SELECT count(*)::int AS count FROM series_analysis_title_states WHERE game_title_id = 'explicit-title'`)[0].count, 0);
  await db`INSERT INTO series_analysis_title_states(game_title_id, algorithm_version, artifact_schema_version, validation_contract_id)
    SELECT 'explicit-title', algorithm_version, artifact_schema_version, validation_contract_id FROM series_analysis_release_state WHERE singleton_key = 'current'`;
  await assert.rejects(db`UPDATE series_analysis_jobs SET status = 'queued', lease_owner = NULL, lease_attempt_id = NULL,
    lease_fencing_token = NULL, lease_expires_at = NULL WHERE id = ${legacy.job}`, { code: '23514' });
  await db`UPDATE series_analysis_jobs SET status = 'queued', lease_owner = NULL, lease_attempt_id = NULL,
    lease_fencing_token = NULL, lease_expires_at = NULL, lease_validation_contract_id = NULL WHERE id = ${legacy.job}`;
  await assert.rejects(db`UPDATE series_analysis_artifacts SET input_revision = input_revision + 1 WHERE id = ${legacy.artifact}`, /immutable/u);
}));

test('restored complete source retains every unconverted byte and maps every ID, reference, anchor and replay exactly', async () => isolated(async (source, name) => {
  await migrateLegacy(source); await seedCanonicalSource(source);
  const before = await snapshot(source); const expected = await expectedTargetRows(source); const order = await navigation(source);
  const originalMechanisms = await mechanisms(source);
  assert.ok(Object.values(before.rows).every(rows => rows.length > 0), 'Every source table has a representative row');
  const backup = docker(['pg_dump', '-U', username, '--format=custom', '--no-owner', '--no-acl', name]);
  await isolated(async (copy, restored) => {
    docker(['pg_restore', '-U', username, '--exit-on-error', '--no-owner', '--no-acl', '-d', restored], backup);
    assert.deepEqual(await snapshot(copy), before);
    await latest(copy); const after = await snapshot(copy);
    assert.deepEqual(after.rows, expected); assert.deepEqual(after.sequences, before.sequences);
    assert.deepEqual(after.history.slice(0, before.history.length), before.history);
    await assertTargetSchema(copy); assert.deepEqual(await navigation(copy, true), order);
    const schema = await mechanisms(copy);
    const changedFunctions = /(?:ensure_series_analysis_title_state|bind_series_analysis_radar_job|clear_series_analysis_lease_validation_contract|validate_series_analysis_artifact_pointers|guard_series_analysis_artifact_publication|guard_series_radar_basis)\(/u;
    assert.deepEqual(JSON.parse(schema.functions).filter(definition => !changedFunctions.test(definition)),
      JSON.parse(originalMechanisms.functions).filter(definition => !changedFunctions.test(definition)));
    const removedTriggers = /(?:game_titles_series_analysis_state_insert|series_analysis_jobs_radar_binding|series_analysis_jobs_lease_validation_cleanup)/u;
    assert.deepEqual(JSON.parse(schema.triggers), JSON.parse(originalMechanisms.triggers).filter(definition => !removedTriggers.test(definition)));
    await latest(copy);
    assert.deepEqual(await snapshot(copy), after); assert.deepEqual(await mechanisms(copy), schema);
  });
}));

for (const [name, values] of [
  ['alternate UUID spellings', ['00112233-4455-6677-8899-aabbccddeeff', '{00112233445566778899AABBCCDDEEFF}']],
  ['assignment versus existing UUID', ['fixture-member', '4f6d54e9-7de8-873c-a464-b510c2945ef0']],
]) test(`canonical collision (${name}) rolls back the entire cutover without merging rows`, async () => isolated(async db => {
  await migrateLegacy(db);
  for (const [index, id] of values.entries()) await db`INSERT INTO members(id, user_id, display_name) VALUES (${id}, ${'collision-' + index}, 'Synthetic collision')`;
  const before = await snapshot(db); const schema = await mechanisms(db);
  await assert.rejects(latest(db), error => error.cause?.code === '23514' && error.cause?.message === 'CANONICAL_ID_COLLISION');
  assert.deepEqual(await snapshot(db), before); assert.deepEqual(await mechanisms(db), schema);
}));

test('a prepared expansion refuses canonical columns already used by an unexpected writer', async () => isolated(async db => {
  await migrateLegacy(db); await seedCanonicalSource(db); await migrateThrough(db, 84);
  await db`UPDATE members SET canonical_id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' WHERE id = ${legacy.member}`;
  const before = await snapshot(db); const schema = await mechanisms(db);
  await assert.rejects(latest(db), error => error.cause?.message === 'CANONICAL_ID_EXPANSION_ALREADY_USED');
  assert.deepEqual(await snapshot(db), before); assert.deepEqual(await mechanisms(db), schema);
}));

test('failure after the final guard restores all legacy columns, functions, sequences and migration hashes', async () => isolated(async db => {
  await migrateLegacy(db); await seedCanonicalSource(db); const before = await snapshot(db); const schema = await mechanisms(db);
  await withMigrationPrefix(93, async folder => {
    const file = join(folder, '0093_canonical-publication-guards.sql');
    writeFileSync(file, readFileSync(file, 'utf8') + `\n--> statement-breakpoint\nDO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM members WHERE legacy_id = 'notification-member-1') THEN
        RAISE EXCEPTION 'canonical checkpoint was not reached';
      END IF;
      RAISE EXCEPTION 'forced failure after canonical guards';
    END $$;\n`);
    await assert.rejects(migrate(drizzle(db), { migrationsFolder: folder }), error => error.cause?.message === 'forced failure after canonical guards');
  });
  assert.deepEqual(await snapshot(db), before); assert.deepEqual(await mechanisms(db), schema);
  await latest(db); await assertTargetSchema(db);
}));

test('an active writer fails the maintenance lock immediately before expansion and can be retried', async () => isolated(async db => {
  await migrateLegacy(db); await seedCanonicalSource(db); const before = await snapshot(db);
  let acquired, release; const ready = new Promise(resolve => { acquired = resolve; }); const done = new Promise(resolve => { release = resolve; });
  const writer = db.begin(async tx => { await tx`SELECT id FROM members WHERE id = ${legacy.member} FOR UPDATE`; acquired(); await done; });
  await ready;
  try { await assert.rejects(latest(db), error => error.cause?.code === '55P03'); assert.deepEqual(await snapshot(db), before); }
  finally { release(); await writer; }
  await latest(db);
}));

test('retained nullable references, composite title/event pairs, native keys and original delete actions remain enforced', async () => isolated(async db => {
  await migrateLegacy(db); await seedCanonicalSource(db); await latest(db);
  await assert.rejects(db`UPDATE app_sessions SET member_id = NULL`, { code: '23514' });
  await db`UPDATE app_sessions SET member_id = NULL, legacy_member_id = NULL`;
  await assert.rejects(db`UPDATE matches SET legacy_held_event_id = 'wrong-event-alias' WHERE legacy_id = ${legacy.match}`, { code: '23503' });
  await assert.rejects(db`UPDATE series_radar_candidates SET legacy_game_title_id = 'wrong-title-alias'`, { code: '23503' });
  await assert.rejects(db`UPDATE series_radar_operations SET legacy_game_title_id = 'wrong-title-alias'`, { code: '23503' });
  await assert.rejects(db`INSERT INTO members(id, legacy_id, user_id, display_name)
    VALUES (${randomUUID()}, ${legacy.member}, 'duplicate-legacy', 'Duplicate')`, { code: '23505' });
  await assert.rejects(db`INSERT INTO members(id, legacy_id, user_id, display_name)
    VALUES ('not-a-uuid', 'new-legacy', 'new-user', 'Invalid UUID')`, { code: '22P02' });
  await assert.rejects(db`DELETE FROM series_analysis_artifact_identities WHERE legacy_id = ${legacy.artifact}`, { code: '23001' });
  await assert.rejects(db`DELETE FROM series_analysis_artifacts WHERE id = ${legacy.artifact}`, { code: '23001' });
  await assert.rejects(db`DELETE FROM series_radar_bases WHERE id = ${legacy.basis}`, error => ['23503', '23001'].includes(error.code));
  await db`DELETE FROM match_drafts WHERE legacy_id = ${legacy.draft}`;
  const [submission] = await db`SELECT match_draft_id::text, legacy_match_draft_id FROM ocr_submissions WHERE legacy_id = ${legacy.submission}`;
  assert.deepEqual({ ...submission }, { match_draft_id: identity('match_drafts', legacy.draft), legacy_match_draft_id: legacy.draft });
  await db`DELETE FROM sessions WHERE legacy_id = ${legacy.session}`;
  assert.equal((await db`SELECT session_id FROM held_events WHERE legacy_id = ${legacy.event}`)[0].session_id, null);
  assert.equal((await db`SELECT session_id FROM discord_notification_attendance WHERE notification_id = 'attendance:legacy'`)[0].session_id, null);
  assert.equal((await db`SELECT count(*)::int AS count FROM responses`)[0].count, 0);
  assert.equal((await db`SELECT count(*)::int AS count FROM held_event_participants`)[0].count, 1);
  const headers = () => db`SELECT (to_jsonb(a) - 'attempt_id')::text AS value FROM series_analysis_artifacts a ORDER BY a.id COLLATE "C"`;
  const before = [...await headers()];
  await db`DELETE FROM series_analysis_job_attempts WHERE legacy_id = ${legacy.attempt}`;
  assert.deepEqual([...await headers()], before);
  assert.equal((await db`SELECT count(*)::int AS count FROM series_analysis_artifacts WHERE attempt_id IS NOT NULL`)[0].count, 0);
  const [request] = await db`SELECT assigned_attempt_id::text, legacy_assigned_attempt_id FROM series_analysis_job_requests WHERE legacy_id = ${legacy.request}`;
  assert.deepEqual({ ...request }, { assigned_attempt_id: identity('series_analysis_job_attempts', legacy.attempt), legacy_assigned_attempt_id: legacy.attempt });
}));

test('frozen guards use canonical anchors while preserving exact headers, payloads and old-basis protections', async () => isolated(async db => {
  await migrateLegacy(db); await seedCanonicalSource(db); await latest(db);
  const old = await snapshot(db);
  await assert.rejects(db`UPDATE series_analysis_artifacts SET root_checksum = ${'sha256:' + 'b'.repeat(64)} WHERE id = ${legacy.artifact}`, /immutable/u);
  await assert.rejects(db`UPDATE series_analysis_artifacts SET validation_contract_id = NULL WHERE id = 'artifact:sealed-staging'`, /immutable/u);
  await assert.rejects(db`UPDATE series_analysis_scope_aggregate_artifacts SET payload = ${Buffer.from('{}')} WHERE artifact_id = ${legacy.artifact}`, /immutable/u);
  await assert.rejects(db`UPDATE series_radar_revisions SET requested_by = 'changed'`, /immutable/u);
  await assert.rejects(db`UPDATE series_radar_candidates SET manual_input = '{}'`, /immutable/u);
  await assert.rejects(db`UPDATE series_radar_bases SET payload = '{}' WHERE id = ${legacy.basis}`, /immutable/u);
  await assert.rejects(db`UPDATE series_radar_bases SET source_snapshot = NULL WHERE id = ${legacy.basis}`, /protected/u);
  await db`UPDATE series_radar_bases SET source_snapshot = NULL WHERE id = 'radar:unreferenced'`;
  await db`UPDATE series_analysis_title_states SET current_artifact_id = current_artifact_id,
    previous_artifact_id = previous_artifact_id WHERE game_title_id = ${identity('game_titles', legacy.title)}`;
  await assert.rejects(db`UPDATE series_analysis_title_states SET input_revision = input_revision + 1,
    current_artifact_id = current_artifact_id WHERE game_title_id = ${identity('game_titles', legacy.title)}`, /desired-version/u);
  await assert.rejects(db`UPDATE series_analysis_title_states SET current_artifact_id = ${identity('series_analysis_artifacts', 'artifact:sealed-staging')}
    WHERE game_title_id = ${identity('game_titles', legacy.title)}`, /desired-version/u);
  await db`UPDATE series_radar_title_states SET generation = 3 WHERE game_title_id = ${identity('game_titles', legacy.title)}`;
  await assert.rejects(db`UPDATE series_analysis_title_states SET current_artifact_id = current_artifact_id
    WHERE game_title_id = ${identity('game_titles', legacy.title)}`, /generation/u);
  await db`UPDATE series_radar_title_states SET generation = 2 WHERE game_title_id = ${identity('game_titles', legacy.title)}`;
  const after = await snapshot(db);
  for (const table of Object.keys(old.rows).filter(name => name.startsWith('series_analysis_') && name.includes('artifact'))) {
    assert.deepEqual(after.rows[table], old.rows[table], `${table} remains frozen`);
  }
}));

test('new canonical artifact/basis identities publish through the same desired generation without rewriting old snapshots', async () => isolated(async db => {
  await migrateLegacy(db); await seedCanonicalSource(db); await latest(db);
  const title = identity('game_titles', legacy.title); const nextBasis = randomUUID(); const nextArtifact = randomUUID();
  const before = await snapshot(db);
  await db.begin(async tx => {
    await tx`INSERT INTO series_radar_bases(id, game_title_id, checksum, payload, source_snapshot, source_checksum, source_input_revision)
      VALUES (${nextBasis}, ${legacy.title}, ${checksum}, '{"axes":[1,2,3]}', '{"matches":[]}', ${checksum}, 9007199254740993)`;
    await tx`INSERT INTO series_radar_basis_identities(id, legacy_id, game_title_id, legacy_game_title_id)
      VALUES (${nextBasis}, ${nextBasis}, ${title}, ${legacy.title})`;
    await tx`UPDATE series_radar_title_states SET desired_basis_id = ${nextBasis}, generation = 3 WHERE game_title_id = ${title}`;
    await tx`INSERT INTO series_analysis_artifacts(id, game_title_id, input_revision, algorithm_version, artifact_schema_version,
      source_input_checksum, root_checksum, aggregate_chunk_count, review_chunk_count, drilldown_chunk_count, match_context_chunk_count,
      encoded_bytes, decoded_bytes, radar_basis_id, radar_generation, scope_keys)
      VALUES (${nextArtifact}, ${legacy.title}, 9007199254740993, 'series-analysis-v6', 5, ${checksum}, ${checksum},
        1, 0, 0, 0, ${payload.length}, ${payload.length}, ${nextBasis}, 3, ARRAY['overall'])`;
    await tx`INSERT INTO series_analysis_scope_aggregate_artifacts(artifact_id, scope_key, scope_kind, payload,
      encoded_bytes, decoded_bytes, item_count, nesting_depth, checksum)
      VALUES (${nextArtifact}, 'overall', 'overall', ${payload}, ${payload.length}, ${payload.length}, 0, 2, ${checksum})`;
    await tx`INSERT INTO series_analysis_artifact_identities(id, legacy_id, game_title_id, legacy_game_title_id)
      VALUES (${nextArtifact}, ${nextArtifact}, ${title}, ${legacy.title})`;
    await tx`UPDATE series_analysis_artifacts SET validation_contract_id = ${validationContract} WHERE id = ${nextArtifact}`;
    await tx`UPDATE series_analysis_artifacts SET status = 'published', published_at = clock_timestamp(), radar_applied_at = clock_timestamp()
      WHERE id = ${nextArtifact}`;
    await tx`UPDATE series_analysis_title_states SET current_artifact_id = ${nextArtifact}, previous_artifact_id = ${identity('series_analysis_artifacts', legacy.artifact)}
      WHERE game_title_id = ${title}`;
  });
  const [state] = await db`SELECT current_artifact_id::text, previous_artifact_id::text, notification_baseline_artifact_id::text
    FROM series_analysis_title_states WHERE game_title_id = ${title}`;
  assert.deepEqual({ ...state }, { current_artifact_id: nextArtifact,
    previous_artifact_id: identity('series_analysis_artifacts', legacy.artifact), notification_baseline_artifact_id: identity('series_analysis_artifacts', legacy.artifact) });
  for (const table of ['series_analysis_artifacts', 'series_radar_bases']) {
    const rows = (await db`SELECT to_jsonb(record)::text AS value FROM ${db(table)} record
      WHERE id <> ${table === 'series_analysis_artifacts' ? nextArtifact : nextBasis} ORDER BY to_jsonb(record)::text COLLATE "C"`).map(row => row.value);
    assert.deepEqual(rows, before.rows[table]);
  }
  await assert.rejects(db`UPDATE series_radar_bases SET source_snapshot = NULL WHERE id = ${nextBasis}`, /protected/u);
}));

test('OCR slot identity keeps its existing UUID attempt bits and a separate OCR job namespace', async () => isolated(async db => {
  await migrateLegacy(db); await seedCanonicalSource(db);
  const attempt = '{01234567-89AB-CDEF-0123-456789ABCDEF}';
  await db`UPDATE worker_execution_slots SET task_kind = 'ocr', job_id = ${legacy.ocrJob}, attempt_id = ${attempt}`;
  await latest(db);
  const [slot] = await db`SELECT job_id::text, attempt_id::text, legacy_job_id, legacy_attempt_id FROM worker_execution_slots`;
  assert.deepEqual({ ...slot }, { job_id: identity('ocr_jobs', legacy.ocrJob), attempt_id: canonicalUuid(attempt),
    legacy_job_id: legacy.ocrJob, legacy_attempt_id: attempt });
}));

test('a non-UUID retained OCR attempt is rejected before any canonical assignment', async () => isolated(async db => {
  await migrateLegacy(db); await seedCanonicalSource(db);
  await db`UPDATE worker_execution_slots SET task_kind = 'ocr', job_id = ${legacy.ocrJob}, attempt_id = 'invalid-ocr-attempt'`;
  const before = await snapshot(db); const schema = await mechanisms(db);
  await assert.rejects(latest(db), error => error.cause?.message === 'CANONICAL_ID_OCR_ATTEMPT_INVALID');
  assert.deepEqual(await snapshot(db), before); assert.deepEqual(await mechanisms(db), schema);
}));

test('typed anchors and publication guard reject a basis outside the artifact title scope', async () => isolated(async db => {
  await migrateLegacy(db); await seedCanonicalSource(db); await latest(db);
  const title = identity('game_titles', legacy.title); const otherTitle = randomUUID(); const otherBasis = randomUUID(); const artifact = randomUUID();
  await db`INSERT INTO game_titles(id, legacy_id, name, layout_family) VALUES (${otherTitle}, ${otherTitle}, 'Other title', 'world')`;
  await db`INSERT INTO series_radar_bases(id, game_title_id, checksum, payload, source_checksum, source_input_revision)
    VALUES (${otherBasis}, ${otherTitle}, ${checksum}, '{}', ${checksum}, 0)`;
  await assert.rejects(db`INSERT INTO series_radar_basis_identities(id, legacy_id, game_title_id, legacy_game_title_id)
    VALUES (${otherBasis}, ${otherBasis}, ${title}, ${otherTitle})`, { code: '23503' });
  await db`INSERT INTO series_radar_basis_identities(id, legacy_id, game_title_id, legacy_game_title_id)
    VALUES (${otherBasis}, ${otherBasis}, ${otherTitle}, ${otherTitle})`;
  await assert.rejects(db`UPDATE series_radar_candidates SET basis_id = ${otherBasis} WHERE legacy_id = ${legacy.candidate}`, { code: '23503' });
  await db`INSERT INTO series_analysis_artifacts(id, game_title_id, input_revision, algorithm_version, artifact_schema_version,
    source_input_checksum, root_checksum, aggregate_chunk_count, review_chunk_count, drilldown_chunk_count, match_context_chunk_count,
    encoded_bytes, decoded_bytes, radar_basis_id, radar_generation)
    VALUES (${artifact}, ${legacy.title}, 9007199254740993, 'series-analysis-v6', 5, ${checksum}, ${checksum}, 1, 0, 0, 0, 2, 2, ${otherBasis}, 2)`;
  await db`INSERT INTO series_analysis_artifact_identities(id, legacy_id, game_title_id, legacy_game_title_id)
    VALUES (${artifact}, ${artifact}, ${title}, ${legacy.title})`;
  await db`UPDATE series_analysis_artifacts SET validation_contract_id = ${validationContract} WHERE id = ${artifact}`;
  await db`UPDATE series_analysis_artifacts SET status = 'published', published_at = clock_timestamp(), radar_applied_at = clock_timestamp() WHERE id = ${artifact}`;
  await assert.rejects(db`UPDATE series_analysis_title_states SET current_artifact_id = ${artifact} WHERE game_title_id = ${title}`, /outside the title scope/u);
}));
