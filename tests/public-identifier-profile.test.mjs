import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { before } from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { inspectConnection, fingerprint } from '../scripts/migration/database.mjs';
import { inspectSchema } from '../scripts/migration/inventory.mjs';
import { createPublicIdentifierProfile, inspectPublicIdentifierTransition, comparePublicIdentifierTransition,
  loadPublicIdentifierHistory, PUBLIC_IDENTIFIER_PROFILE } from '../scripts/migration/public-identifiers.mjs';
import { createTestClient, resetFixtures } from './notification-fixtures.mjs';
import { docker, username } from './migration-fixtures.mjs';

const repository = resolve('.');
const codeIs = code => error => error.code === code && error.message === code;
let history;
let profile;

async function withDatabase(run) {
  const name = 'momo_db_test_public_profile_' + randomUUID().replaceAll('-', '').slice(0, 12);
  docker(['createdb', '-U', username, name]);
  const db = createTestClient(name);
  try { return await run(db, name); }
  finally { await db.end(); docker(['dropdb', '-U', username, name]); }
}

async function withPrefix(run) {
  const folder = mkdtempSync(join(tmpdir(), 'momo-public-profile-prefix-'));
  try {
    cpSync('./drizzle', folder, { recursive: true });
    const journal = JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8'));
    journal.entries = journal.entries.slice(0, 73);
    writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
    return await run(folder);
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

async function audit(sql) {
  return { connection: await inspectConnection(sql, repository), schema: await inspectSchema(sql), rows: await fingerprint(sql) };
}

async function snapshot(db, currentProfile) {
  return db.begin('isolation level repeatable read read only', async sql => {
    await sql.unsafe("SET LOCAL row_security = off; SET LOCAL search_path = pg_catalog, public; SET LOCAL timezone = 'UTC'");
    const value = await audit(sql);
    return currentProfile ? { after: value, transition: await inspectPublicIdentifierTransition(sql, currentProfile) } : value;
  });
}

before(async () => {
  history = await loadPublicIdentifierHistory(repository);
  await withDatabase(async db => {
    await withPrefix(folder => migrate(drizzle(db), { migrationsFolder: folder }));
    const referenceBefore = await snapshot(db);
    await migrate(drizzle(db), { migrationsFolder: './drizzle' });
    const referenceAfter = await snapshot(db);
    profile = createPublicIdentifierProfile({ history, referenceBefore, referenceAfter });
    const captured = await snapshot(db, profile);
    assert.equal(comparePublicIdentifierTransition({ before: referenceBefore, ...captured, profile }).checks.sequences, true);
  });
});

async function sourceFixture(db) {
  await withPrefix(folder => migrate(drizzle(db), { migrationsFolder: folder }));
  await resetFixtures(db);
  for (const id of ['10', '2', 'A', 'a', '\uE000', '\u{10000}']) {
    await db`INSERT INTO held_events(id, held_date_iso, start_at)
      VALUES (${id}, '2026-01-02', '2026-01-02T00:00:00.123456Z')`;
    await db`INSERT INTO matches(id, held_event_id, match_no_in_event, game_title_id, layout_family,
      season_master_id, owner_member_id, map_master_id, played_at, created_by_account_id)
      VALUES (${id}, ${id}, 1, 'notification-title', 'momotetsu_2', 'notification-season',
      'notification-member-1', 'notification-map', '2026-01-02T00:00:00.123456Z', 'notification-account')`;
  }
  await db`UPDATE matches SET note_body = 'preserved note', note_version = 9,
    note_updated_by_account_id = 'notification-account', note_updated_at = '2026-01-02',
    analysis_revision = 9007199254740993 WHERE id = '2'`;
  await db`INSERT INTO idempotency_keys(key, account_id, endpoint, request_hash, response_status,
    response_headers, response_body, expires_at)
    VALUES ('profile-legacy-key', 'notification-account', '/api/matches', ${Buffer.from([0, 255, 17])}, 201,
      '{"precise":9007199254740993.0001}', ${Buffer.from('exact legacy response\0')}, '2099-01-01')`;
  await db`INSERT INTO discord_notifications(id, family, kind, dedupe_key, payload, payload_hash, status)
    VALUES ('profile-notification', 'result', 'analysis_completed', 'profile-notification',
      '{"legacyId":"2","precise":9007199254740993.0001}', ${'a'.repeat(64)}, 'PENDING')`;
}

test('public identifier profile pins exact migration tags, timestamps, hashes and tail length', async () => {
  assert.equal(history.profile, PUBLIC_IDENTIFIER_PROFILE);
  for (const change of ['hash', 'tag', 'timestamp', 'extra']) {
    const directory = mkdtempSync(join(tmpdir(), 'momo-public-profile-history-'));
    try {
      cpSync('./drizzle', join(directory, 'drizzle'), { recursive: true });
      const path = join(directory, 'drizzle/meta/_journal.json');
      const journal = JSON.parse(readFileSync(path, 'utf8'));
      if (change === 'hash') {
        const sql = join(directory, 'drizzle', `${journal.entries[74].tag}.sql`);
        writeFileSync(sql, readFileSync(sql, 'utf8') + '\n-- changed tail\n');
      } else if (change === 'tag') {
        const previous = journal.entries[74].tag;
        journal.entries[74].tag = '0074_different-profile';
        cpSync(join(directory, 'drizzle', `${previous}.sql`), join(directory, 'drizzle', `${journal.entries[74].tag}.sql`));
      } else if (change === 'timestamp') journal.entries[74].when += 1;
      else {
        journal.entries.push({ ...journal.entries.at(-1), idx: 78, tag: '0078_unreviewed', when: journal.entries.at(-1).when + 1 });
        writeFileSync(join(directory, 'drizzle/0078_unreviewed.sql'), 'SELECT 1;');
      }
      writeFileSync(path, JSON.stringify(journal));
      await assert.rejects(loadPublicIdentifierHistory(directory), codeIs('PUBLIC_IDENTIFIER_TAIL_CHANGED'));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});

test('profile inspection requires an unfiltered repeatable-read read-only transaction', async () => {
  await withDatabase(async db => {
    await migrate(drizzle(db), { migrationsFolder: './drizzle' });
    await assert.rejects(inspectPublicIdentifierTransition(db, profile), codeIs('PUBLIC_IDENTIFIER_READ_ONLY_SNAPSHOT_REQUIRED'));
    await assert.rejects(db.begin('isolation level repeatable read read only', sql => inspectPublicIdentifierTransition(sql, profile)),
      codeIs('PUBLIC_IDENTIFIER_READ_ONLY_SNAPSHOT_REQUIRED'));
    const captured = await snapshot(db, profile);
    assert.equal(captured.transition.publicIdentifiers.every(item => item.assignment.rows === '0'), true);
  });
});

test('restored legacy rows pass only the two-column expansion and exact normal ledger transition', async t => {
  await withDatabase(async (source, sourceName) => {
    await sourceFixture(source);
    const before = await snapshot(source);
    const sourceDump = docker(['pg_dump', '-U', username, '--format=custom', sourceName]);
    await withDatabase(async (target, targetName) => {
      docker(['pg_restore', '-U', username, '--exit-on-error', '-d', targetName], sourceDump);
      await migrate(drizzle(target), { migrationsFolder: './drizzle' });
      const captured = await snapshot(target, profile);
      const sourceSequence = before.rows.sequences.find(sequence => sequence.schema === 'drizzle');
      const firstLedgerId = BigInt(sourceSequence.last_value) + (sourceSequence.is_called ? 1n : 0n);
      assert.deepEqual(captured.transition.ledgerTail, history.entries.slice(73).map((entry, index) => ({
        id: (firstLedgerId + BigInt(index)).toString(), hash: entry.hash, created_at: entry.created_at,
      })));
      assert.deepEqual(comparePublicIdentifierTransition({ before, ...captured, profile }), {
        profile: PUBLIC_IDENTIFIER_PROFILE,
        checks: { sourceSchema: true, targetSchema: true, savedRows: true, existingLedgerRows: true,
          expectedLedgerAppend: true, deterministicPublicIds: true, sequences: true },
      });
      await migrate(drizzle(target), { migrationsFolder: './drizzle' });
      const repeated = await snapshot(target, profile);
      assert.deepEqual(repeated, captured, 'second normal migrator changed rows, schema, ledger or sequence state');
      const targetDump = docker(['pg_dump', '-U', username, '--format=custom', targetName]);

      async function rejectsChange(label, mutate, code) {
        await t.test(label, async () => withDatabase(async (changed, name) => {
          docker(['pg_restore', '-U', username, '--exit-on-error', '-d', name], targetDump);
          await mutate(changed);
          const observed = await snapshot(changed, profile);
          assert.throws(() => comparePublicIdentifierTransition({ before, ...observed, profile }), codeIs(code));
        }));
      }

      await rejectsChange('does not hide a change to another column in a numbered table',
        db => db`UPDATE matches SET note_body = 'changed note' WHERE id = '2'`, 'PUBLIC_IDENTIFIER_SAVED_ROWS_DIFFER');
      await rejectsChange('does not hide other table values or exact stored JSONB decimals',
        db => db`UPDATE discord_notifications SET payload = '{"legacyId":"2","precise":9007199254740993.0002}' WHERE id = 'profile-notification'`,
        'PUBLIC_IDENTIFIER_SAVED_ROWS_DIFFER');
      await rejectsChange('rejects a valid unique numbering that differs from bytewise old-ID order',
        db => db.unsafe(`ALTER TABLE held_events ALTER COLUMN public_id SET GENERATED BY DEFAULT;
          UPDATE held_events SET public_id = -public_id;
          UPDATE held_events SET public_id = (SELECT count(*) + 1 FROM held_events) + public_id;
          ALTER TABLE held_events ALTER COLUMN public_id SET GENERATED ALWAYS`), 'PUBLIC_IDENTIFIER_ASSIGNMENT_DIFFERS');
      await rejectsChange('checks the complete target schema including empty tables',
        db => db.unsafe('CREATE TABLE public.unexpected_empty_table(id text PRIMARY KEY)'), 'PUBLIC_IDENTIFIER_TARGET_SCHEMA_DIFFERS');
      await rejectsChange('does not mask lost uniqueness',
        db => db.unsafe('ALTER TABLE held_events DROP CONSTRAINT held_events_public_id_unique'), 'PUBLIC_IDENTIFIER_TARGET_SCHEMA_DIFFERS');
      await rejectsChange('rejects a sequence next value that would collide with backfilled rows',
        db => db.unsafe('ALTER TABLE held_events ALTER COLUMN public_id RESTART WITH 1'), 'PUBLIC_IDENTIFIER_SEQUENCE_NOT_ALIGNED');
      await rejectsChange('retains existing ledger IDs as well as migration hashes and timestamps',
        db => db.unsafe('UPDATE drizzle.__drizzle_migrations SET id = id - 1000 WHERE id <= 73'), 'PUBLIC_IDENTIFIER_LEDGER_PREFIX_ROWS_DIFFER');
      await rejectsChange('rejects ledger sequence movement outside the five normal inserts',
        db => db.unsafe('ALTER SEQUENCE drizzle.__drizzle_migrations_id_seq RESTART WITH 1000'), 'PUBLIC_IDENTIFIER_LEDGER_SEQUENCE_DIFFERS');
      await t.test('rejects incomplete row fingerprints and a modified reference profile', () => {
        const omitted = structuredClone(captured);
        omitted.after.rows.tables = omitted.after.rows.tables.filter(table => table.name !== 'discord_notifications');
        assert.throws(() => comparePublicIdentifierTransition({ before, ...omitted, profile }), codeIs('PUBLIC_IDENTIFIER_SAVED_TABLES_DIFFER'));
        const altered = structuredClone(profile);
        altered.schemaAfter.tables[0].name = 'altered';
        assert.throws(() => comparePublicIdentifierTransition({ before, ...captured, profile: altered }), codeIs('PUBLIC_IDENTIFIER_PROFILE_CHANGED'));
      });
    });
  });
});

test('source schema must equal the fresh fixed prefix before any transformation is certified', async () => {
  await withDatabase(async db => {
    await sourceFixture(db);
    await db.unsafe('CREATE TABLE public.unexpected_before_tail(id text PRIMARY KEY)');
    const before = await snapshot(db);
    await migrate(drizzle(db), { migrationsFolder: './drizzle' });
    const captured = await snapshot(db, profile);
    assert.throws(() => comparePublicIdentifierTransition({ before, ...captured, profile }), codeIs('PUBLIC_IDENTIFIER_SOURCE_SCHEMA_DIFFERS'));
  });
});
