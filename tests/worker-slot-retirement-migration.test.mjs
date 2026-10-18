import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { before } from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { canonicalIdentity } from '../scripts/identity/canonical.mjs';
import { inspectConnection, fingerprint, compareFingerprints } from '../scripts/migration/database.mjs';
import { inspectSchema } from '../scripts/migration/inventory.mjs';
import { schemaStructure } from '../scripts/migration/schema.mjs';
import { digest } from '../scripts/migration/files.mjs';
import { createCanonicalIdentityProfile, loadCanonicalIdentityHistory, inspectCanonicalSource,
  inspectCanonicalIdentityTransition, compareCanonicalIdentityTransition, canonicalColumnCoverage,
  WORKER_SLOT_RETIREMENT_PROFILE } from '../scripts/migration/canonical-identities.mjs';
import { createTestClient } from './notification-fixtures.mjs';
import { docker, username } from './migration-fixtures.mjs';
import { migrateThrough, withMigrationPrefix } from './migration-prefix.mjs';
import { seedCanonicalSource, legacy, validationContract } from './canonical-identity-fixtures.mjs';

const repository = resolve('.');
const latest = db => migrate(drizzle(db), { migrationsFolder: './drizzle' });
const codeIs = code => error => error.code === code && error.message === code;
const slotName = 'worker_execution_slots';
let history; let profile;

async function isolated(run) {
  const name = 'momo_db_test_slot_retirement_' + randomUUID().replaceAll('-', '').slice(0, 12);
  docker(['createdb', '-U', username, name]);
  const db = createTestClient(name);
  try { return await run(db, name); }
  finally { await db.end(); docker(['dropdb', '-U', username, name]); }
}

async function snapshot(db, currentProfile, phase) {
  return db.begin('isolation level repeatable read read only', async sql => {
    await sql.unsafe("SET LOCAL row_security = off; SET LOCAL search_path = pg_catalog, public; SET LOCAL timezone = 'UTC'");
    const audit = { connection: await inspectConnection(sql, repository), schema: await inspectSchema(sql), rows: await fingerprint(sql) };
    if (!currentProfile) return audit;
    if (phase === 'source') return { before: audit, sourceTransition: await inspectCanonicalSource(sql, currentProfile, audit) };
    return { after: audit, transition: await inspectCanonicalIdentityTransition(sql, currentProfile) };
  });
}

async function rawRows(db) {
  const rows = {};
  for (const { tablename } of await db`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`) {
    rows[tablename] = (await db`SELECT to_jsonb(record)::text AS value FROM ${db(tablename)} record
      ORDER BY to_jsonb(record)::text COLLATE "C"`).map(row => row.value);
  }
  return rows;
}

function assertRollbackAfterFirstLedgerAllocation(after, before) {
  // PostgreSQL nextval is not rolled back. 0094 allocated exactly one ID before
  // 0095 failed; every schema object, saved row, ledger row and other sequence
  // still returns to its original state. The rehearsal requires a fresh copy.
  const expected = structuredClone(before);
  const sequence = expected.rows.sequences.find(value => value.schema === 'drizzle' && value.name === '__drizzle_migrations_id_seq');
  assert.equal(sequence.is_called, true);
  sequence.last_value = (BigInt(sequence.last_value) + 1n).toString();
  expected.rows.digest = digest({ algorithm: expected.rows.algorithm, tables: expected.rows.tables, sequences: expected.rows.sequences });
  assert.deepEqual(after, expected);
}

before(async () => {
  history = await loadCanonicalIdentityHistory(repository, { profile: WORKER_SLOT_RETIREMENT_PROFILE });
  await isolated(async db => {
    await migrateThrough(db, 72);
    const referenceBefore = await snapshot(db);
    await latest(db);
    const referenceAfter = await snapshot(db);
    profile = createCanonicalIdentityProfile({ history, referenceBefore, referenceAfter });
  });
});

async function canonicalFixture(db) {
  await migrateThrough(db, 82);
  await seedCanonicalSource(db);
  await migrateThrough(db, 93);
}

async function reseedFixture(db) {
  await canonicalFixture(db);
  await db`UPDATE worker_execution_slots SET fencing_token = 9007199254741011`;
  await db`UPDATE series_analysis_jobs SET lease_fencing_token = 9007199254741041 WHERE legacy_id = ${legacy.job}`;
  for (const [id, counter] of [
    ['retire-global-floor', '0'], ['retire-current-high', '9007199254741031'],
    ['retire-attempt-floor', '0'], ['retire-last-available', '9223372036854775806'],
  ]) {
    await db`INSERT INTO series_analysis_jobs(id, legacy_id, game_title_id, input_revision, algorithm_version,
      artifact_schema_version, validation_contract_id, trigger, status, finished_at, fencing_counter)
      VALUES (${canonicalIdentity('series_analysis_jobs', id)}, ${id}, ${canonicalIdentity('game_titles', legacy.title)},
        9007199254740993, 'series-analysis-v6', 5, ${validationContract}, 'manual', 'failed', '2026-01-02', ${counter})`;
  }
  await db`INSERT INTO series_analysis_job_attempts(id, legacy_id, job_id, attempt_no, owner, fencing_token, input_revision,
    algorithm_version, artifact_schema_version, validation_contract_id, status, outcome, finished_at,
    effective_config_version, calculation_timeout_milliseconds)
    VALUES (${canonicalIdentity('series_analysis_job_attempts', 'retire-attempt')}, 'retire-attempt',
      ${canonicalIdentity('series_analysis_jobs', 'retire-attempt-floor')}, 1, 'retained-owner', 9007199254741021,
      9007199254740993, 'series-analysis-v6', 5, ${validationContract}, 'terminal', 'failed', '2026-01-02', 'retained-config', 300000)`;
}

test('generated retirement snapshots separate reseeding from one restrictive table removal', () => {
  const read = index => JSON.parse(readFileSync(`./drizzle/meta/00${index}_snapshot.json`, 'utf8'));
  const body = ({ id, prevId, ...value }) => value;
  assert.deepEqual(body(read(94)), body(read(93)));
  const expected = body(read(94)); delete expected.tables['public.worker_execution_slots'];
  assert.deepEqual(body(read(95)), expected);
  const sql = readFileSync('./drizzle/0095_retire-worker-execution-slots.sql', 'utf8');
  assert.match(sql, /DROP TABLE "worker_execution_slots";/u);
  assert.doesNotMatch(sql.replace(/^--.*$/gmu, ''), /CASCADE/u);
});

test('fresh complete history removes the public slot export and a second ordinary migrator changes nothing', async () => isolated(async db => {
  await latest(db);
  assert.equal((await db`SELECT to_regclass('public.worker_execution_slots') AS value`)[0].value, null);
  assert.equal(Object.hasOwn(await import('../dist/schema.js'), 'workerExecutionSlots'), false);
  const before = await snapshot(db);
  await latest(db);
  assert.deepEqual(await snapshot(db), before);
}));

test('restored canonical copy reseeds every floor without lowering issued counters or changing other saved state', async () => isolated(async (source, sourceName) => {
  await reseedFixture(source);
  const before = await snapshot(source);
  const originalRows = await rawRows(source);
  const expectedRows = structuredClone(originalRows);
  delete expectedRows.worker_execution_slots;
  expectedRows.series_analysis_jobs = (await source`SELECT (to_jsonb(record) || jsonb_build_object('fencing_counter',
    greatest(0::bigint, record.fencing_counter, (SELECT max(fencing_token) FROM worker_execution_slots),
      coalesce(record.lease_fencing_token, 0), coalesce((SELECT max(fencing_token) FROM series_analysis_job_attempts WHERE job_id = record.id), 0))))::text COLLATE "C" AS value
    FROM series_analysis_jobs record ORDER BY value`).map(row => row.value);
  const backup = docker(['pg_dump', '-U', username, '--format=custom', '--no-owner', '--no-acl', sourceName]);
  await isolated(async (copy, copyName) => {
    docker(['pg_restore', '-U', username, '--exit-on-error', '--no-owner', '--no-acl', '-d', copyName], backup);
    assert.deepEqual(await rawRows(copy), originalRows);
    await latest(copy);
    assert.deepEqual(await rawRows(copy), expectedRows);
    assert.deepEqual([...await copy`SELECT legacy_id, fencing_counter::text FROM series_analysis_jobs ORDER BY legacy_id COLLATE "C"`], [
      { legacy_id: legacy.job, fencing_counter: '9007199254741041' },
      { legacy_id: 'retire-attempt-floor', fencing_counter: '9007199254741021' },
      { legacy_id: 'retire-current-high', fencing_counter: '9007199254741031' },
      { legacy_id: 'retire-global-floor', fencing_counter: '9007199254741011' },
      { legacy_id: 'retire-last-available', fencing_counter: '9223372036854775806' },
    ].sort((a, b) => Buffer.compare(Buffer.from(a.legacy_id), Buffer.from(b.legacy_id))));
    const after = await snapshot(copy);
    const expectedSchema = schemaStructure(before.schema);
    expectedSchema.tables = expectedSchema.tables.filter(table => table.name !== slotName);
    assert.deepEqual(schemaStructure(after.schema), expectedSchema);
    assert.deepEqual(after.connection.ledger.slice(0, 94), before.connection.ledger);
    assert.deepEqual(after.connection.ledger, history.entries);
    await latest(copy);
    assert.deepEqual(await snapshot(copy), after);
  });
  await isolated(async (recovery, recoveryName) => {
    docker(['pg_restore', '-U', username, '--exit-on-error', '--no-owner', '--no-acl', '-d', recoveryName], backup);
    assert.deepEqual(await rawRows(recovery), originalRows);
    const recovered = await snapshot(recovery);
    assert.deepEqual(schemaStructure(recovered.schema), schemaStructure(before.schema));
    assert.deepEqual(recovered.connection.ledger, before.connection.ledger);
    compareFingerprints(recovered.rows, before.rows);
  });
}));

for (const [name, change, code] of [
  ['missing shared slot', db => db`DELETE FROM worker_execution_slots`, 'WORKER_SLOT_RETIREMENT_GLOBAL_SLOT_REQUIRED'],
  ['exhausted global fence', db => db`UPDATE worker_execution_slots SET fencing_token = 9223372036854775807`, 'WORKER_SLOT_RETIREMENT_SOURCE_EXHAUSTED'],
  ['exhausted issued counter', db => db`UPDATE series_analysis_jobs SET fencing_counter = 9223372036854775807`, 'WORKER_SLOT_RETIREMENT_SOURCE_EXHAUSTED'],
  ['exhausted active lease', db => db`UPDATE series_analysis_jobs SET lease_fencing_token = 9223372036854775807 WHERE status = 'running'`, 'WORKER_SLOT_RETIREMENT_SOURCE_EXHAUSTED'],
  ['exhausted retained attempt', db => db`UPDATE series_analysis_job_attempts SET fencing_token = 9223372036854775807`, 'WORKER_SLOT_RETIREMENT_SOURCE_EXHAUSTED'],
  ['negative active lease', db => db`UPDATE series_analysis_jobs SET lease_fencing_token = -1 WHERE status = 'running'`, 'WORKER_SLOT_RETIREMENT_NEGATIVE_SOURCE'],
]) test(`retirement rejects ${name} and rolls back all changes`, async () => isolated(async db => {
  await canonicalFixture(db); await change(db);
  const before = await snapshot(db);
  await assert.rejects(latest(db), error => error.cause?.code === '23514' && error.cause?.message === code);
  assert.deepEqual(await snapshot(db), before);
}));

test('unknown dependent objects stop restrictive retirement and roll back the reseed', async () => isolated(async db => {
  await reseedFixture(db);
  await db.unsafe('CREATE VIEW public.unreviewed_slot_reader AS SELECT slot_key FROM public.worker_execution_slots');
  const before = await snapshot(db);
  await assert.rejects(latest(db), error => error.cause?.code === '2BP01');
  assertRollbackAfterFirstLedgerAllocation(await snapshot(db), before);
}));

for (const table of ['worker_execution_slots', 'series_analysis_jobs', 'series_analysis_job_attempts']) {
  test(`retirement refuses an overlapping ${table} reader without waiting or changing state`, async () => isolated(async db => {
    await canonicalFixture(db);
    const before = await snapshot(db);
    let locked; let release;
    const ready = new Promise(resolve => { locked = resolve; });
    const hold = new Promise(resolve => { release = resolve; });
    const reader = db.begin(async tx => { await tx.unsafe(`SELECT * FROM public.${table}`); locked(); await hold; });
    await ready;
    try {
      await assert.rejects(latest(db), error => error.cause?.code === '55P03');
      assert.deepEqual(await snapshot(db), before);
    } finally { release(); await reader; }
    await latest(db);
  }));
}

test('a failure after DROP restores the slot, counters, complete schema and original ledger together', async () => isolated(async db => {
  await reseedFixture(db);
  const before = await snapshot(db);
  await withMigrationPrefix(95, async folder => {
    const file = join(folder, '0095_retire-worker-execution-slots.sql');
    writeFileSync(file, readFileSync(file, 'utf8') + `\n--> statement-breakpoint\nDO $$ BEGIN
      IF to_regclass('public.worker_execution_slots') IS NOT NULL THEN RAISE EXCEPTION 'slot drop not reached'; END IF;
      RAISE EXCEPTION 'forced failure after slot retirement'; END $$;\n`);
    await assert.rejects(migrate(drizzle(db), { migrationsFolder: folder }), error => error.cause?.message === 'forced failure after slot retirement');
  });
  assertRollbackAfterFirstLedgerAllocation(await snapshot(db), before);
}));

test('the retirement profile pins both tail files and rejects a missing, changed or additional transition', async () => {
  assert.equal(history.entries.length, 96);
  for (const change of ['reseed', 'drop', 'tag', 'timestamp', 'missing', 'extra']) {
    const directory = mkdtempSync(join(tmpdir(), 'momo-retirement-history-'));
    try {
      cpSync('./drizzle', join(directory, 'drizzle'), { recursive: true });
      cpSync('./docs/contracts', join(directory, 'docs/contracts'), { recursive: true });
      const path = join(directory, 'drizzle/meta/_journal.json');
      const journal = JSON.parse(readFileSync(path, 'utf8'));
      if (['reseed', 'drop'].includes(change)) {
        const file = join(directory, 'drizzle', journal.entries[change === 'reseed' ? 94 : 95].tag + '.sql');
        writeFileSync(file, readFileSync(file, 'utf8') + '\n-- changed retirement\n');
      } else if (change === 'tag') {
        cpSync(join(directory, 'drizzle', journal.entries[95].tag + '.sql'), join(directory, 'drizzle/0095_unreviewed.sql'));
        journal.entries[95].tag = '0095_unreviewed';
      } else if (change === 'timestamp') journal.entries[95].when += 1;
      else if (change === 'missing') journal.entries.pop();
      else {
        journal.entries.push({ ...journal.entries.at(-1), idx: 96, tag: '0096_unreviewed', when: journal.entries.at(-1).when + 1 });
        writeFileSync(join(directory, 'drizzle/0096_unreviewed.sql'), 'SELECT 1;');
      }
      writeFileSync(path, JSON.stringify(journal));
      await assert.rejects(loadCanonicalIdentityHistory(directory, { profile: WORKER_SLOT_RETIREMENT_PROFILE }), codeIs('CANONICAL_TAIL_CHANGED'));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});

test('full old-source retirement proof covers all source columns and preserves all remaining values', async t => isolated(async (source, sourceName) => {
  await migrateThrough(source, 72); await seedCanonicalSource(source, { beforeFencingExpansion: true });
  await source`UPDATE game_titles SET layout_family = ' DEFAULT ' WHERE id = ${legacy.title}`;
  const { before, sourceTransition } = await snapshot(source, profile, 'source');
  const coverage = canonicalColumnCoverage(profile.schemaBefore, profile.schemaAfter, { retireWorkerSlots: true });
  assert.equal(coverage.retiredTables.length, 1);
  assert.equal(coverage.retiredTables[0].name, slotName);
  assert.deepEqual(coverage.retiredTables[0].columns.map(column => column.name), profile.schemaBefore.tables.find(table => table.name === slotName).columns.map(column => column.name));
  assert.equal(coverage.tables.flatMap(table => table.columns).filter(column => column.mode === 'typed-uuid').length, 107);
  assert.equal(coverage.columns.filter(column => column.mode === 'exact-legacy-alias').length, 45);
  const backup = docker(['pg_dump', '-U', username, '--format=custom', '--no-owner', '--no-acl', sourceName]);
  await isolated(async (copy, name) => {
    docker(['pg_restore', '-U', username, '--exit-on-error', '--no-owner', '--no-acl', '-d', name], backup);
    await latest(copy);
    const captured = await snapshot(copy, profile);
    const result = compareCanonicalIdentityTransition({ before, sourceTransition, ...captured, profile });
    assert.equal(Object.values(result.checks).every(Boolean), true);
    assert.equal(result.checks.workerSlotRetirement, true);
    await latest(copy);
    assert.deepEqual((await snapshot(copy)).rows, captured.after.rows);
    for (const [name, change, code] of [
      ['missing retirement evidence', evidence => { evidence.retiredTables = []; }, 'CANONICAL_SOURCE_TRANSITION_INCOMPLETE'],
      ['changed complete slot fingerprint', evidence => { evidence.retiredTables[0].digest = 'changed'; }, 'CANONICAL_RETIREMENT_SOURCE_DIFFERS'],
      ['changed source fence projection', evidence => { evidence.fencingSeeds.digest = 'changed'; }, 'CANONICAL_FENCING_SEED_DIFFERS'],
    ]) await t.test(name, () => {
      const evidence = structuredClone(sourceTransition); change(evidence);
      assert.throws(() => compareCanonicalIdentityTransition({ before, sourceTransition: evidence, ...captured, profile }), codeIs(code));
    });
    await t.test('an unexpected restored slot is not accepted as the final schema', async () => {
      await copy.unsafe('CREATE TABLE public.worker_execution_slots(id text PRIMARY KEY)');
      const changed = await snapshot(copy, profile);
      assert.throws(() => compareCanonicalIdentityTransition({ before, sourceTransition, ...changed, profile }), codeIs('CANONICAL_TARGET_SCHEMA_DIFFERS'));
      await copy.unsafe('DROP TABLE public.worker_execution_slots');
    });
    await t.test('remaining job counters are bound to the original slot floor', async () => {
      await copy`UPDATE series_analysis_jobs SET fencing_counter = fencing_counter + 1`;
      const changed = await snapshot(copy, profile);
      assert.throws(() => compareCanonicalIdentityTransition({ before, sourceTransition, ...changed, profile }), codeIs('CANONICAL_FENCING_SEED_DIFFERS'));
    });
  });
}));
