import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createTestClient, envelope, resetFixtures } from './notification-fixtures.mjs';
import { docker, expectedPublicIdentifierRows, snapshotDatabase, username } from './migration-fixtures.mjs';

const tables = ['held_events', 'matches'];
const journal = () => JSON.parse(readFileSync('./drizzle/meta/_journal.json', 'utf8'));

async function isolated(run) {
  const name = 'momo_db_test_public_' + randomUUID().replaceAll('-', '').slice(0, 12);
  docker(['createdb', '-U', username, name]);
  const db = createTestClient(name);
  try { return await run(db, name); }
  finally { await db.end(); docker(['dropdb', '-U', username, name]); }
}

async function prefix(db, lastIndex) {
  const folder = mkdtempSync(join(tmpdir(), 'momo-db-public-prefix-'));
  try {
    cpSync('./drizzle', folder, { recursive: true });
    const copied = journal();
    copied.entries = copied.entries.filter(entry => entry.idx <= lastIndex);
    writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify(copied));
    await migrate(drizzle(db), { migrationsFolder: folder });
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

async function seedHistory(db) {
  await resetFixtures(db);
  // Numeric legacy keys, case differences and supplementary Unicode must keep
  // exact identity while numbering follows PostgreSQL's bytewise C collation.
  for (const id of ['10', '2', 'A', 'a', '\uE000', '\u{10000}']) {
    await db`INSERT INTO held_events(id, held_date_iso, start_at)
      VALUES (${id}, '2026-01-01', '2026-01-01T00:00:00.123456Z')`;
    await insertMatch(db, id, id);
  }
  await db`UPDATE matches SET note_body = '旧 ID とメモを保持する。', note_version = 7,
    note_updated_by_account_id = 'notification-account', note_updated_at = '2026-01-02T00:00:00.654321Z',
    analysis_revision = 9007199254740993 WHERE id = '2'`;
  await db`INSERT INTO match_players(match_id, member_id, play_order, rank, total_assets_man_yen, revenue_man_yen)
    SELECT m.id, 'notification-member-' || p, p, p, 10000 - p, 1000 - p
    FROM matches m CROSS JOIN generate_series(1, 4) p`;
  await db`INSERT INTO match_incidents(match_id, member_id, incident_master_id, count)
    SELECT p.match_id, p.member_id, i.id, 1 FROM match_players p CROSS JOIN incident_masters i`;
  await db`INSERT INTO held_event_participants(held_event_id, member_id)
    SELECT h.id, 'notification-member-' || p FROM held_events h CROSS JOIN generate_series(1, 4) p`;
  await db`INSERT INTO app_sessions(id_hash, account_id, csrf_secret_hash, expires_at)
    VALUES ('public-migration-session', 'notification-account', 'public-migration-csrf', '2099-01-01')`;
  await db`INSERT INTO idempotency_keys(key, account_id, endpoint, request_hash, response_status,
    response_headers, response_body, expires_at)
    VALUES ('Legacy-Key', 'notification-account', '/api/matches', ${Buffer.from('old request')},
      201, '{"content-type":"application/json"}', ${Buffer.from('{"matchId":"2"}')}, '2099-01-01')`;

  const payload = Buffer.from('{"matches":[{"id":"2","heldEventId":"2"}],"members":["notification-member-1"]}');
  const checksum = 'sha256:' + createHash('sha256').update(payload).digest('hex');
  const contract = 'series-analysis-artifact-v2-full-validation-v1';
  await db`UPDATE series_analysis_title_states SET algorithm_version = 'series-analysis-v4',
    artifact_schema_version = 2, validation_contract_id = ${contract} WHERE game_title_id = 'notification-title'`;
  await db`INSERT INTO series_analysis_artifacts(id, game_title_id, input_revision, algorithm_version,
    artifact_schema_version, source_input_checksum, root_checksum, aggregate_chunk_count, review_chunk_count,
    drilldown_chunk_count, match_context_chunk_count, encoded_bytes, decoded_bytes)
    VALUES ('public-preserved-artifact', 'notification-title', 0, 'series-analysis-v4', 2, ${checksum}, ${checksum},
      1, 0, 0, 0, ${payload.length}, ${payload.length})`;
  await db`INSERT INTO series_analysis_scope_aggregate_artifacts(artifact_id, scope_key, scope_kind, payload,
    encoded_bytes, decoded_bytes, item_count, nesting_depth, checksum)
    VALUES ('public-preserved-artifact', 'overall', 'overall', ${payload}, ${payload.length}, ${payload.length}, 1, 3, ${checksum})`;
  await db`UPDATE series_analysis_artifacts SET validation_contract_id = ${contract} WHERE id = 'public-preserved-artifact'`;
  await db`UPDATE series_analysis_artifacts SET status = 'published', published_at = '2026-01-02'
    WHERE id = 'public-preserved-artifact'`;
  await db`UPDATE series_analysis_title_states SET current_artifact_id = 'public-preserved-artifact'
    WHERE game_title_id = 'notification-title'`;
  await db`INSERT INTO series_radar_bases(id, game_title_id, checksum, payload, source_snapshot, source_checksum, source_input_revision)
    VALUES ('public-preserved-basis', 'notification-title', ${checksum}, '{"axes":[]}',
      ${payload.toString()}::jsonb, ${checksum}, 0)`;

  for (const status of ['PENDING', 'IN_FLIGHT', 'DELIVERED', 'FAILED', 'CANCELLED']) {
    const notification = await envelope(db, 'analysis_completed', 'public-history-' + status);
    const claim = status === 'IN_FLIGHT' ? '11111111-1111-4111-8111-111111111111' : null;
    await db`INSERT INTO discord_notifications(id, family, kind, dedupe_key, payload, payload_hash,
      status, claim_token, claim_expires_at, part_count, renderer_version, delivery_context)
      VALUES (${notification.notificationId}, 'result', 'analysis_completed', ${notification.notificationId},
        ${JSON.stringify(notification)}::jsonb, ${'b'.repeat(64)}, ${status}, ${claim}::uuid,
        ${claim ? '2099-01-01' : null}::timestamptz, 1, 1,
        '{"webOrigin":"https://example.test","channelId":"public-history-channel"}')`;
    await db`INSERT INTO discord_notification_results(notification_id, kind, source_job_id, occurred_at, settings_generation)
      VALUES (${notification.notificationId}, 'analysis_completed', ${notification.sourceJobId}, '2026-01-01', 0)`;
    await db`INSERT INTO discord_notification_targets(notification_id, target_kind, target_id)
      VALUES (${notification.notificationId}, 'match', '2')`;
    await db`INSERT INTO discord_notification_parts(notification_id, part_no, status, delivered_at, delivered_message_id)
      VALUES (${notification.notificationId}, 0, 'DELIVERED', '2026-01-01', ${'message-' + status})`;
  }
}

async function insertMatch(db, id, heldId) {
  const [row] = await db`INSERT INTO matches(id, held_event_id, match_no_in_event, game_title_id, layout_family,
    season_master_id, owner_member_id, map_master_id, played_at, created_by_account_id)
    VALUES (${id}, ${heldId}, 1, 'notification-title', 'momotetsu_2', 'notification-season',
      'notification-member-1', 'notification-map', '2026-01-01T00:00:00.123456Z', 'notification-account')
    RETURNING id`;
  return row;
}

async function schema(db) {
  const [row] = await db`SELECT
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.table_name, c.ordinal_position)
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
  // Database name is intentionally different after pg_restore.
  return { ...row, columns: row.columns.map(({ table_catalog, udt_catalog, ...column }) => column) };
}

async function sequences(db) {
  const values = {};
  for (const table of tables) {
    const name = table + '_public_id_seq';
    if ((await db`SELECT to_regclass(${'public.' + name}) AS name`)[0].name) {
      const [state] = await db`SELECT last_value::text, is_called FROM ${db(name)}`;
      values[table] = { ...state };
    }
  }
  return values;
}

async function assertIdentitySchema(db) {
  for (const table of tables) {
    const [column] = await db`SELECT data_type, is_nullable, is_identity, identity_generation
      FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table} AND column_name = 'public_id'`;
    assert.deepEqual({ ...column }, { data_type: 'bigint', is_nullable: 'NO', is_identity: 'YES', identity_generation: 'ALWAYS' });
    const [constraint] = await db`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conname = ${table + '_public_id_unique'}`;
    assert.equal(constraint.definition, 'UNIQUE (public_id)');
  }
}

test('fresh identities start at one, preserve decimal bigint precision and reject explicit or duplicate values', async () => {
  await isolated(async db => {
    await migrate(drizzle(db), { migrationsFolder: './drizzle' });
    await assertIdentitySchema(db);
    assert.deepEqual(await sequences(db), {
      held_events: { last_value: '1', is_called: false }, matches: { last_value: '1', is_called: false }
    });
    await resetFixtures(db);
    assert.equal((await db`SELECT public_id::text FROM held_events WHERE id = 'notification-held'`)[0].public_id, '1');
    assert.deepEqual((await db`SELECT public_id::text FROM matches ORDER BY id`).map(row => row.public_id), ['1', '2']);
    await assert.rejects(db`INSERT INTO held_events(id, public_id, held_date_iso, start_at)
      VALUES ('explicit', 9, '2026-01-01', '2026-01-01')`, { code: '428C9' });
    await assert.rejects(db`INSERT INTO held_events(id, public_id, held_date_iso, start_at) OVERRIDING SYSTEM VALUE
      VALUES ('duplicate', 1, '2026-01-01', '2026-01-01')`, { code: '23505' });
    await assert.rejects(db`INSERT INTO held_events(id, public_id, held_date_iso, start_at) OVERRIDING SYSTEM VALUE
      VALUES ('null', NULL, '2026-01-01', '2026-01-01')`, { code: '23502' });
    await db`ALTER TABLE held_events ALTER COLUMN public_id RESTART WITH 9007199254740993`;
    await db`ALTER TABLE matches ALTER COLUMN public_id RESTART WITH 9007199254740993`;
    const [held] = await db`INSERT INTO held_events(id, held_date_iso, start_at)
      VALUES ('large-number', '2026-01-01', '2026-01-01') RETURNING public_id::text`;
    await insertMatch(db, 'large-number', 'large-number');
    const [match] = await db`SELECT public_id::text FROM matches WHERE id = 'large-number'`;
    assert.deepEqual(JSON.parse(JSON.stringify({ event: held.public_id, match: match.public_id })),
      { event: '9007199254740993', match: '9007199254740993' });
  });
});

test('restored history receives C-ordered numbers without changing any legacy row, mechanism or sealed payload', async () => {
  await isolated(async (source, name) => {
    await prefix(source, 72);
    await seedHistory(source);
    const before = await snapshotDatabase(source);
    const backup = docker(['pg_dump', '-U', username, '--format=custom', '--no-owner', '--no-acl', name]);
    await isolated(async (copy, restored) => {
      docker(['pg_restore', '-U', username, '--exit-on-error', '--no-owner', '--no-acl', '-d', restored], backup);
      assert.deepEqual(await snapshotDatabase(copy), before);
      // pg_restore compacts dropped-column ordinals and can normalize CHECK
      // expression parentheses. Compare the migration against its restored baseline.
      const beforeSchema = await schema(copy);
      await migrate(drizzle(copy), { migrationsFolder: './drizzle' });
      const after = await snapshotDatabase(copy);
      assert.deepEqual(after.rows, expectedPublicIdentifierRows(before.rows));
      assert.equal((await copy`SELECT analysis_revision::text FROM matches WHERE id = '2'`)[0].analysis_revision,
        '9007199254740993', 'Legacy bigint values must keep all bits');
      assert.deepEqual(after.history.slice(0, before.history.length), before.history);
      assert.equal(after.history.length, journal().entries.length);
      await assertIdentitySchema(copy);
      const afterSchema = await schema(copy);
      assert.equal(afterSchema.columns.length, beforeSchema.columns.length + 2);
      assert.deepEqual(afterSchema.columns.filter(column =>
        !(tables.includes(column.table_name) && column.column_name === 'public_id')), beforeSchema.columns);
      for (const category of ['functions', 'triggers']) assert.deepEqual(afterSchema[category], beforeSchema[category]);
      for (const category of ['constraints', 'indexes']) {
        assert.deepEqual(afterSchema[category].filter(object =>
          !tables.some(table => object.name === table + '_public_id_unique')
          && !(tables.includes(object.table) && object.definition === 'NOT NULL public_id')),
          beforeSchema[category]);
      }
      for (const table of tables) {
        const ordered = await copy`SELECT id, public_id::text FROM ${copy(table)} ORDER BY id COLLATE "C"`;
        assert.deepEqual(ordered.map(row => row.public_id), ordered.map((_, index) => String(index + 1)));
      }
      const expectedNext = Object.fromEntries(tables.map(table => [table, String(before.rows[table].length + 1)]));
      assert.deepEqual(await sequences(copy), Object.fromEntries(tables.map(table =>
        [table, { last_value: expectedNext[table], is_called: false }])));
      const [held] = await copy`INSERT INTO held_events(id, held_date_iso, start_at)
        VALUES ('after-migration', '2026-01-02', '2026-01-02') RETURNING public_id::text`;
      await insertMatch(copy, 'after-migration', 'after-migration');
      assert.equal(held.public_id, expectedNext.held_events);
      assert.equal((await copy`SELECT public_id::text FROM matches WHERE id = 'after-migration'`)[0].public_id, expectedNext.matches);
      const beforeRerun = await snapshotDatabase(copy);
      const sequencesBeforeRerun = await sequences(copy);
      await migrate(drizzle(copy), { migrationsFolder: './drizzle' });
      assert.deepEqual(await snapshotDatabase(copy), beforeRerun);
      assert.deepEqual(await sequences(copy), sequencesBeforeRerun, 'No-op migration must not rewind either sequence');
      await assert.rejects(copy`UPDATE series_analysis_artifacts SET source_input_checksum = ${'sha256:' + 'f'.repeat(64)}`,
        /immutable/);
      await assert.rejects(copy`UPDATE series_radar_bases SET payload = '{"changed":true}'`, /immutable/);
    });
  });
});

for (const startIndex of [72, 76]) {
  test(`failure after sequence alignment rolls back rows, DDL, history and sequence state from ${startIndex}`, async () => {
    await isolated(async db => {
      await prefix(db, 72);
      await seedHistory(db);
      if (startIndex === 76) await prefix(db, startIndex);
      const before = await snapshotDatabase(db);
      const beforeSchema = await schema(db);
      const beforeSequences = await sequences(db);
      const folder = mkdtempSync(join(tmpdir(), 'momo-db-public-failure-'));
      try {
        cpSync('./drizzle', folder, { recursive: true });
        const final = journal().entries.find(entry => entry.idx === 77);
        const file = join(folder, final.tag + '.sql');
        const failure = 'forced public identifier migration failure after alignment';
        writeFileSync(file, readFileSync(file, 'utf8') + `\n--> statement-breakpoint\nDO $$ BEGIN
          IF (SELECT last_value FROM public.held_events_public_id_seq) <> (SELECT max(public_id) + 1 FROM public.held_events)
            OR (SELECT last_value FROM public.matches_public_id_seq) <> (SELECT max(public_id) + 1 FROM public.matches)
            OR (SELECT is_called FROM public.held_events_public_id_seq)
            OR (SELECT is_called FROM public.matches_public_id_seq) THEN
            RAISE EXCEPTION 'sequence alignment checkpoint was not reached';
          END IF;
          IF (SELECT count(*) FROM drizzle.__drizzle_migrations) <> 77 THEN
            RAISE EXCEPTION 'preceding migration history checkpoint was not reached';
          END IF;
          RAISE EXCEPTION '${failure}';
        END $$;\n`);
        await assert.rejects(migrate(drizzle(db), { migrationsFolder: folder }),
          error => error.cause?.code === 'P0001' && error.cause?.message === failure);
        assert.deepEqual(await snapshotDatabase(db), before);
        assert.deepEqual(await schema(db), beforeSchema);
        assert.deepEqual(await sequences(db), beforeSequences);
      } finally { rmSync(folder, { recursive: true, force: true }); }
      await migrate(drizzle(db), { migrationsFolder: './drizzle' });
      await assertIdentitySchema(db);
    });
  });
}

test('unexpected preassigned numbers stop backfill without overwriting history or advancing the ledger', async () => {
  await isolated(async db => {
    await prefix(db, 72);
    await seedHistory(db);
    await prefix(db, 73);
    await db`UPDATE held_events SET public_id = 42 WHERE id = '2'`;
    const before = await snapshotDatabase(db);
    const beforeSchema = await schema(db);
    await assert.rejects(migrate(drizzle(db), { migrationsFolder: './drizzle' }),
      error => error.cause?.message === 'Public identifier backfill requires unassigned public_id columns');
    assert.deepEqual(await snapshotDatabase(db), before);
    assert.deepEqual(await schema(db), beforeSchema);
    assert.deepEqual(await sequences(db), {});
  });
});

test('the normal migrator waits for an active legacy writer and numbers its committed rows', async () => {
  await isolated(async (db, name) => {
    await prefix(db, 72);
    await resetFixtures(db);
    const writer = createTestClient(name);
    const migrator = createTestClient(name);
    const ready = Promise.withResolvers();
    const release = Promise.withResolvers();
    const writing = writer.begin(async tx => {
      await tx`INSERT INTO held_events(id, held_date_iso, start_at)
        VALUES ('late-writer', '2026-01-01', '2026-01-01')`;
      await insertMatch(tx, 'late-writer', 'late-writer');
      ready.resolve((await tx`SELECT pg_backend_pid() AS pid`)[0].pid);
      await release.promise;
    });
    writing.catch(error => ready.reject(error));
    let migration;
    let migrationFinished = false;
    try {
      const writerPid = await ready.promise;
      migration = migrate(drizzle(migrator), { migrationsFolder: './drizzle' });
      migration.then(() => { migrationFinished = true; }, () => { migrationFinished = true; });
      const deadline = Date.now() + 3000;
      let waiting = false;
      do {
        const locks = await db`SELECT l.pid FROM pg_locks l
          WHERE l.locktype = 'relation' AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
            AND l.relation = 'public.held_events'::regclass AND l.mode = 'AccessExclusiveLock'
            AND NOT l.granted AND ${writerPid} = ANY(pg_blocking_pids(l.pid))`;
        waiting = locks.length > 0;
        assert.equal(migrationFinished, false);
      } while (!waiting && Date.now() < deadline);
      assert.equal(waiting, true, 'DDL must wait for the uncommitted legacy writer');
      release.resolve();
      await writing;
      await migration;
      for (const table of tables) {
        const rows = await db`SELECT id, public_id::text FROM ${db(table)} ORDER BY id COLLATE "C"`;
        assert.ok(rows.some(row => row.id === 'late-writer'));
        assert.deepEqual(rows.map(row => row.public_id), rows.map((_, index) => String(index + 1)));
      }
    } finally {
      release.resolve();
      await Promise.allSettled([writing, migration]);
      await Promise.allSettled([writer.end(), migrator.end()]);
    }
  });
});
