import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { before } from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { inspectConnection, fingerprint, compareFingerprints } from '../scripts/migration/database.mjs';
import { inspectSchema } from '../scripts/migration/inventory.mjs';
import { createCanonicalIdentityProfile, inspectCanonicalSource, inspectCanonicalIdentityTransition,
  compareCanonicalIdentityTransition, loadCanonicalIdentityHistory, canonicalColumnCoverage,
  canonicalLayout, CANONICAL_IDENTITY_PROFILE } from '../scripts/migration/canonical-identities.mjs';
import { schemaStructure } from '../scripts/migration/schema.mjs';
import { canonicalIdentity } from '../scripts/identity/canonical.mjs';
import { createTestClient } from './notification-fixtures.mjs';
import { docker, username } from './migration-fixtures.mjs';
import { migrateThrough } from './migration-prefix.mjs';
import { seedCanonicalSource, legacy } from './canonical-identity-fixtures.mjs';

const repository = resolve('.');
const codeIs = code => error => error.code === code && error.message === code;
const latest = db => migrateThrough(db, 93);
let history; let profile; let references;

async function isolated(run) {
  const name = 'momo_db_test_identity_profile_' + randomUUID().replaceAll('-', '').slice(0, 12);
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

before(async () => {
  const directory = mkdtempSync(join(tmpdir(), 'momo-canonical-reviewed-history-'));
  try {
    cpSync('./drizzle', join(directory, 'drizzle'), { recursive: true });
    cpSync('./docs/contracts', join(directory, 'docs/contracts'), { recursive: true });
    const path = join(directory, 'drizzle/meta/_journal.json');
    const journal = JSON.parse(readFileSync(path, 'utf8'));
    journal.entries = journal.entries.slice(0, 94);
    writeFileSync(path, JSON.stringify(journal));
    history = await loadCanonicalIdentityHistory(directory);
  } finally { rmSync(directory, { recursive: true, force: true }); }
  await isolated(async db => {
    await migrateThrough(db, 72);
    const referenceBefore = await snapshot(db);
    await latest(db);
    const referenceAfter = await snapshot(db);
    references = { referenceBefore, referenceAfter };
    profile = createCanonicalIdentityProfile({ history, ...references });
  });
});

async function sourceFixture(db) {
  await migrateThrough(db, 72);
  await seedCanonicalSource(db, { beforeFencingExpansion: true });
  await db`UPDATE game_titles SET layout_family = ' DEFAULT ' WHERE id = ${legacy.title}`;
  await db`UPDATE match_drafts SET layout_family = E'\tMoMoTeTsU_ReIwA\r\n' WHERE id = ${legacy.draft}`;
  await db`UPDATE matches SET layout_family = ' 2 ' WHERE id = ${legacy.match}`;
  for (const id of ['10', '2', 'A', 'a', '\uE000', '\u{10000}']) {
    await db`INSERT INTO held_events(id, held_date_iso, start_at) VALUES (${id}, '2026-01-02', '2026-01-02T00:00:00.123456Z')`;
    await db`INSERT INTO matches(id, held_event_id, match_no_in_event, game_title_id, layout_family,
      season_master_id, owner_member_id, map_master_id, played_at, created_by_account_id)
      VALUES (${id}, ${id}, 1, ${legacy.title}, 'momotetsu_world', 'notification-season', ${legacy.member},
        'notification-map', '2026-01-02T00:00:00.123456Z', ${legacy.account})`;
  }
}

test('canonical profile pins every reviewed tail file and the complete public column contract', async () => {
  assert.equal(history.profile, CANONICAL_IDENTITY_PROFILE);
  assert.equal(history.entries.length, 94);
  await assert.rejects(loadCanonicalIdentityHistory(repository), codeIs('CANONICAL_TAIL_CHANGED'), 'the historical profile rejects slot retirement');
  for (const change of ['hash', 'tag', 'timestamp', 'extra', 'contract']) {
    const directory = mkdtempSync(join(tmpdir(), 'momo-canonical-profile-history-'));
    try {
      cpSync('./drizzle', join(directory, 'drizzle'), { recursive: true });
      cpSync('./docs/contracts', join(directory, 'docs/contracts'), { recursive: true });
      const path = join(directory, 'drizzle/meta/_journal.json');
      const journal = JSON.parse(readFileSync(path, 'utf8'));
      journal.entries = journal.entries.slice(0, 94);
      if (change === 'hash') {
        const sql = join(directory, 'drizzle', `${journal.entries[85].tag}.sql`);
        writeFileSync(sql, readFileSync(sql, 'utf8') + '\n-- changed backfill\n');
      } else if (change === 'tag') {
        const previous = journal.entries[85].tag;
        journal.entries[85].tag = '0085_unreviewed';
        cpSync(join(directory, 'drizzle', `${previous}.sql`), join(directory, 'drizzle', `${journal.entries[85].tag}.sql`));
      } else if (change === 'timestamp') journal.entries[85].when += 1;
      else if (change === 'extra') {
        journal.entries.push({ ...journal.entries.at(-1), idx: 94, tag: '0094_unreviewed', when: journal.entries.at(-1).when + 1 });
        writeFileSync(join(directory, 'drizzle/0094_unreviewed.sql'), 'SELECT 1;');
      } else writeFileSync(join(directory, 'docs/contracts/canonical-identities-v1.json'), '{}');
      writeFileSync(path, JSON.stringify(journal));
      await assert.rejects(loadCanonicalIdentityHistory(directory), codeIs(change === 'contract' ? 'CANONICAL_CONTRACT_CHANGED' : 'CANONICAL_TAIL_CHANGED'));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});

test('coverage accounts for every original and final column including the empty new replay table', () => {
  const coverage = canonicalColumnCoverage(profile.schemaBefore, profile.schemaAfter);
  assert.equal(coverage.tables.flatMap(table => table.columns).filter(column => column.mode === 'typed-uuid').length, 109);
  assert.equal(coverage.columns.filter(column => column.mode === 'exact-legacy-alias').length, 47);
  assert.equal(coverage.columns.length, profile.schemaAfter.tables.reduce((total, table) => total + table.columns.length, 0));
  for (const mutate of [
    schema => schema.tables.find(table => table.name === 'app_sessions').columns.push({ name: 'unreviewed', type: 'text' }),
    schema => schema.tables.find(table => table.name === 'idempotency_keys').columns.push({ name: 'unreviewed', type: 'text' }),
    schema => { const table = schema.tables.find(table => table.name === 'app_sessions'); table.columns = table.columns.filter(column => column.name !== 'legacy_member_id'); },
  ]) {
    const changed = structuredClone(profile.schemaAfter); mutate(changed);
    assert.throws(() => canonicalColumnCoverage(profile.schemaBefore, changed), codeIs('CANONICAL_TARGET_COLUMN_COVERAGE_DIFFERS'));
  }
});

test('profile accepts the shared ASCII layout contract and rejects broad Unicode trimming', () => {
  const fixture = JSON.parse(readFileSync('tests/fixtures/layout-families-v1.json', 'utf8'));
  for (const value of fixture.accepted) assert.equal(canonicalLayout(value.input), value.canonical);
  for (const value of fixture.rejected) assert.throws(() => canonicalLayout(value), codeIs('CANONICAL_SOURCE_LAYOUT_UNMAPPED'));
  assert.equal(canonicalLayout(null), null);
});

test('canonical profile inspection requires an unfiltered read-only repeatable-read snapshot', async () => isolated(async db => {
  await latest(db);
  await assert.rejects(inspectCanonicalIdentityTransition(db, profile), codeIs('CANONICAL_READ_ONLY_SNAPSHOT_REQUIRED'));
  await assert.rejects(db.begin('isolation level repeatable read read only', sql => inspectCanonicalIdentityTransition(sql, profile)), codeIs('CANONICAL_READ_ONLY_SNAPSHOT_REQUIRED'));
}));

test('full restored source passes exact preservation, canonical mapping, seeded additions, normal no-op and recovery', async t => isolated(async (source, sourceName) => {
  await sourceFixture(source);
  const { before, sourceTransition } = await snapshot(source, profile, 'source');
  assert.ok(before.rows.tables.every(table => BigInt(table.rows) > 0n), 'All original tables must have representative rows');
  const backup = docker(['pg_dump', '-U', username, '--format=custom', '--no-owner', '--no-acl', sourceName]);
  await isolated(async (target, targetName) => {
    docker(['pg_restore', '-U', username, '--exit-on-error', '--no-owner', '--no-acl', '-d', targetName], backup);
    await latest(target);
    const captured = await snapshot(target, profile);
    const result = compareCanonicalIdentityTransition({ before, sourceTransition, ...captured, profile });
    assert.equal(Object.values(result.checks).every(Boolean), true);
    await latest(target);
    assert.deepEqual(await snapshot(target, profile), captured, 'Second normal migrator must leave schema, every row and sequence exact');
    const changedBackup = docker(['pg_dump', '-U', username, '--format=custom', '--no-owner', '--no-acl', targetName]);
    async function rejects(label, mutate, code) {
      await t.test(label, async () => isolated(async (changed, name) => {
        docker(['pg_restore', '-U', username, '--exit-on-error', '--no-owner', '--no-acl', '-d', name], changedBackup);
        await mutate(changed);
        const observed = await snapshot(changed, profile);
        assert.throws(() => compareCanonicalIdentityTransition({ before, sourceTransition, ...observed, profile }), codeIs(code));
      }));
    }
    await rejects('raw note bytes remain part of the projection', db => db`UPDATE matches SET note_body = 'changed' WHERE legacy_id = ${legacy.match}`, 'CANONICAL_SAVED_ROWS_DIFFER');
    await rejects('precise notification JSONB decimals are never rounded by JavaScript', db => db`UPDATE discord_notifications
      SET payload = '{"accountId":"notification-account","precise":9007199254740993.123456788}' WHERE id = 'attendance:legacy'`, 'CANONICAL_SAVED_ROWS_DIFFER');
    await rejects('frozen bytea corruption fails even with the original schema and restored guard state', async db => {
      await db.begin(async tx => {
        await tx.unsafe('SET LOCAL session_replication_role = replica');
        await tx`UPDATE series_analysis_scope_aggregate_artifacts SET payload = set_byte(payload, 0, 0) WHERE artifact_id = ${legacy.artifact}`;
      });
    }, 'CANONICAL_SAVED_ROWS_DIFFER');
    await rejects('the renamed legacy replay retains its exact response bytes', db => db`UPDATE idempotency_keys_legacy SET response_body = ${Buffer.from('changed')}
      WHERE key = 'Legacy-Key:1'`, 'CANONICAL_SAVED_ROWS_DIFFER');
    await rejects('all retained legacy fields remain exact', db => db`UPDATE app_sessions SET legacy_member_id = 'different-old-member'`, 'CANONICAL_SAVED_ROWS_DIFFER');
    await rejects('canonical orphan references are checked independently of their retained legacy values', db => db`UPDATE app_sessions SET member_id = ${randomUUID()}`, 'CANONICAL_UUID_ASSIGNMENT_DIFFERS');
    await rejects('declared FK references are projected through their exact parent aliases', db => db`UPDATE matches SET owner_member_id = ${canonicalIdentity('members', '7')}
      WHERE legacy_id = ${legacy.match}`, 'CANONICAL_SAVED_ROWS_DIFFER');
    await rejects('both native anchor identity fields are checked', db => db`UPDATE series_analysis_artifact_identities SET id = ${randomUUID()}
      WHERE legacy_id = 'artifact:sealed-staging'`, 'CANONICAL_UUID_ASSIGNMENT_DIFFERS');
    await rejects('an unreferenced frozen source still requires its anchor', db => db`DELETE FROM series_radar_basis_identities WHERE legacy_id = 'radar:unreferenced'`, 'CANONICAL_ANCHOR_ROWS_DIFFER');
    await rejects('the new UUID replay boundary begins empty', db => db`INSERT INTO idempotency_keys(key, account_id, endpoint, request_hash,
      response_status, response_headers, expires_at) VALUES (${randomUUID()}, ${canonicalIdentity('momo_login_accounts', legacy.account)},
      '/unexpected', ${Buffer.from([0])}, 201, '{}', '2099-01-01')`, 'CANONICAL_NEW_REPLAY_NOT_EMPTY');
    await rejects('fencing counters equal the preserved global, active and attempt floors', db => db`UPDATE series_analysis_jobs SET fencing_counter = fencing_counter + 1`, 'CANONICAL_FENCING_SEED_DIFFERS');
    await rejects('a valid but different canonical layout is rejected', db => db`UPDATE game_titles SET layout_family = 'reiwa' WHERE legacy_id = ${legacy.title}`, 'CANONICAL_SAVED_ROWS_DIFFER');
    await rejects('valid unique public numbers must retain old bytewise ordering', db => db.unsafe(`ALTER TABLE matches ALTER COLUMN public_id SET GENERATED BY DEFAULT;
      UPDATE matches SET public_id = -public_id;
      UPDATE matches SET public_id = (SELECT count(*) + 1 FROM matches) + public_id;
      ALTER TABLE matches ALTER COLUMN public_id SET GENERATED ALWAYS`), 'CANONICAL_PUBLIC_NUMBER_ASSIGNMENT_DIFFERS');
    await rejects('public identity sequences remain aligned', db => db.unsafe('ALTER TABLE held_events ALTER COLUMN public_id RESTART WITH 1'), 'CANONICAL_PUBLIC_NUMBER_SEQUENCE_DIFFERS');
    await rejects('all old ledger row IDs remain unchanged', db => db.unsafe('UPDATE drizzle.__drizzle_migrations SET id = id - 1000 WHERE id <= 73'), 'CANONICAL_LEDGER_PREFIX_ROWS_DIFFER');
    await rejects('only normal ledger sequence advancement is accepted', db => db.unsafe('ALTER SEQUENCE drizzle.__drizzle_migrations_id_seq RESTART WITH 1000'), 'CANONICAL_LEDGER_SEQUENCE_DIFFERS');
    await rejects('empty tables are still part of the complete target schema', db => db.unsafe('CREATE TABLE public.unexpected_empty_table(id text PRIMARY KEY)'), 'CANONICAL_TARGET_SCHEMA_DIFFERS');
    await t.test('missing row, mapping, source projection or profile evidence cannot certify the transition', () => {
      const missing = structuredClone(captured); missing.transition.identityChecks.pop();
      assert.throws(() => compareCanonicalIdentityTransition({ before, sourceTransition, ...missing, profile }), codeIs('CANONICAL_IDENTITY_CHECKS_INCOMPLETE'));
      const missingRows = structuredClone(captured); missingRows.after.rows.tables.pop();
      assert.throws(() => compareCanonicalIdentityTransition({ before, sourceTransition, ...missingRows, profile }), codeIs('CANONICAL_FINGERPRINT_INCOMPLETE'));
      const changedSource = { ...sourceTransition, baselineDigest: 'changed' };
      assert.throws(() => compareCanonicalIdentityTransition({ before, sourceTransition: changedSource, ...captured, profile }), codeIs('CANONICAL_SOURCE_TRANSITION_MISMATCH'));
      const changedProfile = structuredClone(profile); changedProfile.coverage.columns.pop();
      assert.throws(() => compareCanonicalIdentityTransition({ before, sourceTransition, ...captured, profile: changedProfile }), codeIs('CANONICAL_PROFILE_CHANGED'));
    });
  });
  await isolated(async (recovery, name) => {
    docker(['pg_restore', '-U', username, '--exit-on-error', '--no-owner', '--no-acl', '-d', name], backup);
    const after = await snapshot(recovery);
    assert.deepEqual(schemaStructure(after.schema), schemaStructure(before.schema));
    assert.deepEqual(after.connection.ledger, before.connection.ledger);
    compareFingerprints(before.rows, after.rows);
  });
}));

test('source-only diagnostic function is retained exactly alongside the final canonical schema', async () => isolated(async db => {
  await sourceFixture(db);
  await db.unsafe(JSON.parse(readFileSync('tests/fixtures/rehearsal-diagnostic-function.json', 'utf8')));
  const original = await snapshot(db);
  const retained = createCanonicalIdentityProfile({ history, ...references, sourceSchema: original.schema });
  assert.equal(retained.retainedFunctions.length, 1);
  const { before, sourceTransition } = await snapshot(db, retained, 'source');
  await latest(db);
  const captured = await snapshot(db, retained);
  assert.equal(compareCanonicalIdentityTransition({ before, sourceTransition, ...captured, profile: retained }).checks.targetSchema, true);
  await db.unsafe('DROP FUNCTION public.show_db_tree()');
  const missing = await snapshot(db, retained);
  assert.throws(() => compareCanonicalIdentityTransition({ before, sourceTransition, ...missing, profile: retained }), codeIs('CANONICAL_TARGET_SCHEMA_DIFFERS'));
}));

test('OCR slot attempts preserve UUID bits and exact old spelling without analysis allocation', async () => isolated(async db => {
  await sourceFixture(db);
  await db`UPDATE worker_execution_slots SET task_kind = 'ocr', job_id = ${legacy.ocrJob},
    attempt_id = '{00112233-4455-6677-8899-AABBCCDDEEFF}', fencing_token = 9007199254740994`;
  const { before, sourceTransition } = await snapshot(db, profile, 'source');
  await latest(db);
  const captured = await snapshot(db, profile);
  assert.equal(compareCanonicalIdentityTransition({ before, sourceTransition, ...captured, profile }).checks.uuidAssignments, true);
  await db`UPDATE worker_execution_slots SET attempt_id = ${canonicalIdentity('series_analysis_job_attempts', 'incorrect-analysis-allocation')}`;
  const changed = await snapshot(db, profile);
  assert.throws(() => compareCanonicalIdentityTransition({ before, sourceTransition, ...changed, profile }), codeIs('CANONICAL_UUID_ASSIGNMENT_DIFFERS'));
}));
