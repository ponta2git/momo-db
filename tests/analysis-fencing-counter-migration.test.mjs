import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createTestClient, resetFixtures } from './notification-fixtures.mjs';
import { docker, username } from './migration-fixtures.mjs';

const contract = 'series-analysis-artifact-v6-full-validation-v2';
const journal = () => JSON.parse(readFileSync('./drizzle/meta/_journal.json', 'utf8'));
// This reviewed unit ends at 0080; later independent tails have their own tests.
const latest = db => prefix(db, 80);

async function isolated(run) {
  const name = 'momo_db_test_fence_' + randomUUID().replaceAll('-', '').slice(0, 12);
  docker(['createdb', '-U', username, name]);
  const db = createTestClient(name);
  try { return await run(db, name); }
  finally { await db.end(); docker(['dropdb', '-U', username, name]); }
}

async function prefix(db, lastIndex) {
  const folder = mkdtempSync(join(tmpdir(), 'momo-db-fence-prefix-'));
  try {
    cpSync('./drizzle', folder, { recursive: true });
    const history = journal();
    history.entries = history.entries.filter(entry => entry.idx <= lastIndex);
    writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify(history));
    await migrate(drizzle(db), { migrationsFolder: folder });
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

async function snapshot(db, { projectCounter = false } = {}) {
  const rows = {};
  for (const { tablename } of await db`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`) {
    const projection = projectCounter && tablename === 'series_analysis_jobs'
      ? db.unsafe("to_jsonb(record) - 'fencing_counter'") : db.unsafe('to_jsonb(record)');
    rows[tablename] = (await db`SELECT (${projection})::text AS value FROM ${db(tablename)} record
      ORDER BY (${projection})::text COLLATE "C"`).map(row => row.value);
  }
  const history = [...await db`SELECT id::text, hash, created_at::text FROM drizzle.__drizzle_migrations record ORDER BY record.id`];
  return { rows, history };
}

async function mechanisms(db) {
  const [value] = await db`SELECT
    (SELECT jsonb_agg(to_jsonb(c) - 'table_catalog' - 'udt_catalog' ORDER BY c.table_name, c.ordinal_position)
      FROM information_schema.columns c WHERE c.table_schema = 'public') AS columns,
    (SELECT jsonb_agg(pg_get_functiondef(p.oid) ORDER BY p.proname)
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public') AS functions,
    (SELECT jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY c.relname, t.tgname)
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal) AS triggers,
    (SELECT jsonb_agg(jsonb_build_object('table', c.relname, 'name', con.conname, 'definition', pg_get_constraintdef(con.oid))
      ORDER BY c.relname, con.conname) FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public') AS constraints,
    (SELECT jsonb_agg(jsonb_build_object('name', indexname, 'definition', indexdef) ORDER BY tablename, indexname)
      FROM pg_indexes WHERE schemaname = 'public') AS indexes`;
  return value;
}

async function seed(db) {
  await resetFixtures(db);
  const values = [
    ['global-floor', 'queued', null, null],
    ['active-floor', 'running', '9007199254740997', '9007199254740994'],
    ['attempt-floor', 'succeeded', null, '9007199254741001'],
    ['failed-history', 'failed', null, '6'],
    ['last-available', 'timed_out', null, '9223372036854775806'],
  ];
  for (const [id, status, lease, attempt] of values) {
    await db`INSERT INTO game_titles(id, name, layout_family) VALUES (${id + '-title'}, ${id}, 'momotetsu_2')`;
    await db`INSERT INTO series_analysis_jobs(id, game_title_id, input_revision, algorithm_version,
      artifact_schema_version, validation_contract_id, status, trigger, lease_owner, lease_attempt_id,
      lease_fencing_token, lease_expires_at, lease_validation_contract_id, finished_at)
      VALUES (${id}, ${id + '-title'}, 9007199254740993, 'series-analysis-v8', 6, ${contract}, ${status}, 'manual',
        ${lease ? 'saved-owner' : null}, ${lease ? id + '-attempt' : null}, ${lease}::bigint,
        ${lease ? '2099-01-01' : null}::timestamptz, ${lease ? contract : null},
        ${['succeeded', 'failed', 'timed_out'].includes(status) ? '2026-01-02T00:00:00.123456Z' : null}::timestamptz)`;
    if (attempt) await db`INSERT INTO series_analysis_job_attempts(id, job_id, attempt_no, owner, fencing_token,
      input_revision, algorithm_version, artifact_schema_version, validation_contract_id, status, outcome,
      effective_config_version, calculation_timeout_milliseconds, finished_at)
      VALUES (${id + '-attempt'}, ${id}, 1, 'saved-owner', ${attempt}::bigint, 9007199254740993,
        'series-analysis-v8', 6, ${contract}, 'terminal', 'owner_lost', 'test-fence-config', 1000,
        '2026-01-02T00:00:00.123456Z')`;
  }
  await db`UPDATE worker_execution_slots SET fencing_token = 9007199254740993,
    task_kind = 'analysis', owner = 'saved-owner', job_id = 'active-floor', attempt_id = 'active-floor-attempt',
    holder_preemptible = true, lease_expires_at = '2099-01-01', preempt_requested_by = 'saved-requester',
    preempt_requested_at = '2026-01-02T00:00:00.123456Z'`;
}

test('fresh fencing counter is an exact nonnegative bigint with a zero default', async () => {
  await isolated(async db => {
    await latest(db); await resetFixtures(db);
    const [column] = await db`SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'series_analysis_jobs' AND column_name = 'fencing_counter'`;
    assert.deepEqual({ ...column }, { data_type: 'bigint', is_nullable: 'NO', column_default: '0' });
    await db`INSERT INTO series_analysis_jobs(id, game_title_id, input_revision, algorithm_version,
      artifact_schema_version, validation_contract_id, trigger)
      VALUES ('new-job', 'notification-title', 0, 'series-analysis-v8', 6, ${contract}, 'manual')`;
    assert.equal((await db`SELECT fencing_counter::text FROM series_analysis_jobs`)[0].fencing_counter, '0');
    await assert.rejects(db`UPDATE series_analysis_jobs SET fencing_counter = -1`,
      { code: '23514', constraint_name: 'series_analysis_jobs_fencing_counter_check' });
    await assert.rejects(db`UPDATE series_analysis_jobs SET fencing_counter = NULL`, { code: '23502' });
    await db`UPDATE series_analysis_jobs SET fencing_counter = 9007199254740993`;
    assert.equal((await db`SELECT fencing_counter::text FROM series_analysis_jobs`)[0].fencing_counter, '9007199254740993');
    assert.equal((await db`SELECT count(*)::text AS count FROM worker_execution_slots`)[0].count, '1');
  });
});

test('restored jobs retain all old values and mechanisms while each counter covers every old fence source', async () => {
  await isolated(async (source, name) => {
    await prefix(source, 77); await seed(source);
    const before = await snapshot(source);
    const backup = docker(['pg_dump', '-U', username, '--format=custom', '--no-owner', '--no-acl', name]);
    await isolated(async (copy, restored) => {
      docker(['pg_restore', '-U', username, '--exit-on-error', '--no-owner', '--no-acl', '-d', restored], backup);
      assert.deepEqual(await snapshot(copy), before);
      const oldMechanisms = await mechanisms(copy);
      await latest(copy);
      const after = await snapshot(copy, { projectCounter: true });
      assert.deepEqual(after.rows, before.rows, 'Only the new counter may change, including saved running leases');
      assert.deepEqual(after.history.slice(0, before.history.length), before.history);
      assert.equal(after.history.length, 81);
      assert.deepEqual([...await copy`SELECT id, fencing_counter::text FROM series_analysis_jobs ORDER BY id`], [
        { id: 'active-floor', fencing_counter: '9007199254740997' },
        { id: 'attempt-floor', fencing_counter: '9007199254741001' },
        { id: 'failed-history', fencing_counter: '9007199254740993' },
        { id: 'global-floor', fencing_counter: '9007199254740993' },
        { id: 'last-available', fencing_counter: '9223372036854775806' },
      ]);
      const newMechanisms = await mechanisms(copy);
      assert.deepEqual(newMechanisms.columns.filter(column => column.table_name !== 'series_analysis_jobs'
        || column.column_name !== 'fencing_counter'), oldMechanisms.columns);
      assert.deepEqual(newMechanisms.constraints.filter(constraint =>
        constraint.name !== 'series_analysis_jobs_fencing_counter_check'
        && !(constraint.table === 'series_analysis_jobs' && constraint.definition === 'NOT NULL fencing_counter')),
      oldMechanisms.constraints);
      for (const kind of ['indexes', 'functions', 'triggers']) assert.deepEqual(newMechanisms[kind], oldMechanisms[kind]);
      const committed = await snapshot(copy);
      await latest(copy);
      assert.deepEqual(await snapshot(copy), committed, 'A normal migrator rerun must not reset persistent counters');
    });
  });
});

const rejectedSources = [
  ['missing global slot', db => db`DELETE FROM worker_execution_slots`, 'ANALYSIS_FENCE_GLOBAL_SLOT_REQUIRED'],
  ['negative active lease', db => db`UPDATE series_analysis_jobs SET lease_fencing_token = -1 WHERE id = 'active-floor'`, 'ANALYSIS_FENCE_NEGATIVE_SOURCE'],
  ['exhausted global slot', db => db`UPDATE worker_execution_slots SET fencing_token = 9223372036854775807`, 'ANALYSIS_FENCE_SOURCE_EXHAUSTED'],
  ['exhausted active lease', db => db`UPDATE series_analysis_jobs SET lease_fencing_token = 9223372036854775807 WHERE id = 'active-floor'`, 'ANALYSIS_FENCE_SOURCE_EXHAUSTED'],
  ['exhausted retained attempt', db => db`UPDATE series_analysis_job_attempts SET fencing_token = 9223372036854775807 WHERE job_id = 'attempt-floor'`, 'ANALYSIS_FENCE_SOURCE_EXHAUSTED'],
];
for (const [name, mutate, expected] of rejectedSources) {
  test(`fencing expansion rejects ${name} before any DDL, seed or history entry`, async () => {
    await isolated(async db => {
      await prefix(db, 77); await seed(db); await mutate(db);
      const before = await snapshot(db); const schema = await mechanisms(db);
      await assert.rejects(latest(db), error => error.cause?.code === '23514' && error.cause?.message === expected);
      assert.deepEqual(await snapshot(db), before); assert.deepEqual(await mechanisms(db), schema);
    });
  });
}

test('an overlapping writer transaction fails NOWAIT before expansion and can be retried after release', async () => {
  await isolated(async db => {
    await prefix(db, 77); await seed(db);
    const before = await snapshot(db);
    let acquired; const ready = new Promise(resolve => { acquired = resolve; });
    let release; const stopped = new Promise(resolve => { release = resolve; });
    const writer = db.begin(async transaction => {
      await transaction`SELECT id FROM series_analysis_jobs WHERE id = 'active-floor' FOR UPDATE`;
      acquired(); await stopped;
    });
    await ready;
    try {
      await assert.rejects(latest(db), error => error.cause?.code === '55P03');
      assert.deepEqual(await snapshot(db), before);
    } finally { release(); await writer; }
    await latest(db);
    assert.deepEqual((await snapshot(db, { projectCounter: true })).rows, before.rows);
  });
});

test('a failure after seeding rolls back the new column, counter values and all appended ledger rows', async () => {
  await isolated(async db => {
    await prefix(db, 77); await seed(db);
    const before = await snapshot(db); const schema = await mechanisms(db);
    const folder = mkdtempSync(join(tmpdir(), 'momo-db-fence-failure-'));
    try {
      cpSync('./drizzle', folder, { recursive: true });
      const file = join(folder, journal().entries.find(entry => entry.idx === 80).tag + '.sql');
      writeFileSync(file, readFileSync(file, 'utf8') + `\n--> statement-breakpoint\nDO $$ BEGIN
        IF (SELECT fencing_counter FROM series_analysis_jobs WHERE id = 'last-available') <> 9223372036854775806 THEN
          RAISE EXCEPTION 'fence seed checkpoint was not reached';
        END IF;
        RAISE EXCEPTION 'forced failure after fencing seed';
      END $$;\n`);
      await assert.rejects(migrate(drizzle(db), { migrationsFolder: folder }),
        error => error.cause?.message === 'forced failure after fencing seed');
    } finally { rmSync(folder, { recursive: true, force: true }); }
    assert.deepEqual(await snapshot(db), before); assert.deepEqual(await mechanisms(db), schema);
    await latest(db);
  });
});

test('a prepared column prefix refuses to overwrite a counter that was already used', async () => {
  await isolated(async db => {
    await prefix(db, 77); await seed(db); await prefix(db, 79);
    await db`UPDATE series_analysis_jobs SET fencing_counter = 12 WHERE id = 'global-floor'`;
    const before = await snapshot(db);
    await assert.rejects(latest(db), error => error.cause?.message === 'ANALYSIS_FENCE_COUNTER_ALREADY_ASSIGNED');
    assert.deepEqual(await snapshot(db), before);
  });
});
