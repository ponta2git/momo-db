import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createServer, createConnection } from 'node:net';
import { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';
import { createWorkspace, createKey, loadKey, privateDirectory, privateFile,
  encryptStream, decryptStream, readJson, writeJson, withRunLock, digest, fileDigest } from '../scripts/migration/files.mjs';
import { command } from '../scripts/migration/process.mjs';
import { databaseLocation, connect, historyState, fingerprint, compareFingerprints, inspectConnection, inspectServer, compareDatabaseLocale } from '../scripts/migration/database.mjs';
import { inventoryClient } from '../scripts/migration/sql-client.mjs';
import { inspectSchema, inspectIdentifierValues } from '../scripts/migration/inventory.mjs';
import { assertOwned, cleanupLocal, localUrl, startLocal, databaseState, createDatabase, withLocalConnection, localInitdbArguments } from '../scripts/migration/local.mjs';
import { main, runAction, compareMigration } from '../scripts/migration/run.mjs';
import { expectedMigrationHistory } from '../scripts/check-migration-history.mjs';
import { createTestClient } from './notification-fixtures.mjs';
import { docker, username } from './migration-fixtures.mjs';

async function withDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'momo-rehearsal-fixture-'));
  await chmod(directory, 0o700);
  try { return await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

async function withDatabase(run) {
  const name = 'momo_db_test_rehearsal_' + randomUUID().replaceAll('-', '').slice(0, 12);
  docker(['createdb', '-U', username, name]);
  const db = createTestClient(name);
  try { return await run(db, name); }
  finally {
    await db.end();
    docker(['dropdb', '-U', username, name]);
  }
}

const codeIs = code => error => error.code === code && error.message === code;
const builtinLocale = { encoding: 'UTF8', collation: 'C.UTF-8', ctype: 'C.UTF-8', localeProvider: 'b',
  locale: 'C.UTF-8', icuRules: null, collationVersion: '1', actualCollationVersion: '1' };

test('equal locale names cannot hide different providers, rules or collation versions', () => {
  assert.match(localInitdbArguments(builtinLocale), /--locale-provider=builtin/);
  assert.match(localInitdbArguments(builtinLocale), /--builtin-locale=C.UTF-8/);
  for (const difference of [{ localeProvider: 'c' }, { icuRules: 'different-rules' },
    { collationVersion: '2', actualCollationVersion: '2' }, { collation: 'C' }]) {
    assert.throws(() => compareDatabaseLocale(builtinLocale, { ...builtinLocale, ...difference }), codeIs('DATABASE_LOCALE_DIFFERS'));
  }
  assert.throws(() => compareDatabaseLocale(builtinLocale, { ...builtinLocale, actualCollationVersion: '2' }), codeIs('DATABASE_COLLATION_VERSION_DRIFT'));
  assert.throws(() => localInitdbArguments({ ...builtinLocale, collation: 'C.UTF-8 --extra-option' }), codeIs('UNSUPPORTED_DATABASE_LOCALE'));
  assert.throws(() => localInitdbArguments({ ...builtinLocale, localeProvider: 'i' }), codeIs('DATABASE_LOCALE_REQUIRES_LOCAL_IMAGE_DESIGN'));
});
function collector(chunks) {
  return new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
}

test('private workspace, key and lock reject public permissions, symlinks and repository destinations', async () => {
  await withDirectory(async directory => {
    const repository = process.cwd();
    await assert.rejects(createWorkspace('relative-run', repository), codeIs('ABSOLUTE_RUN_DIRECTORY_REQUIRED'));
    await assert.rejects(createWorkspace(join(repository, 'private-fixture-' + randomUUID()), repository), codeIs('RUN_DIRECTORY_MUST_BE_OUTSIDE_REPOSITORY'));
    await symlink(repository, join(directory, 'repository-link'));
    await assert.rejects(createWorkspace(join(directory, 'repository-link', 'private-run'), repository), codeIs('RUN_DIRECTORY_MUST_BE_OUTSIDE_REPOSITORY'));
    const workspace = await createWorkspace(join(directory, 'run'), repository);
    assert.equal((await lstat(workspace)).mode & 0o777, 0o700);
    await privateDirectory(workspace);
    const keyPath = join(directory, 'key');
    await createKey(keyPath);
    const key = await loadKey(keyPath);
    assert.equal(key.length, 32);
    assert.equal((await lstat(keyPath)).mode & 0o777, 0o600);
    await assert.rejects(createKey(keyPath), { code: 'EEXIST' });
    assert.deepEqual(await loadKey(keyPath), key);
    await symlink(keyPath, join(directory, 'key-link'));
    await assert.rejects(loadKey(join(directory, 'key-link')), codeIs('PRIVATE_FILE_REQUIRED'));
    await chmod(keyPath, 0o644);
    await assert.rejects(privateFile(keyPath), codeIs('PRIVATE_FILE_REQUIRED'));
    await chmod(workspace, 0o755);
    await assert.rejects(privateDirectory(workspace), codeIs('PRIVATE_DIRECTORY_REQUIRED'));
    await chmod(workspace, 0o700);
    await withRunLock(workspace, async () => {
      await assert.rejects(withRunLock(workspace, () => assert.fail('second operation ran')), codeIs('RUN_LOCKED_INSPECT_BEFORE_RETRY'));
      assert.equal((await lstat(join(workspace, 'operation.lock'))).mode & 0o777, 0o600);
    });
    await assert.rejects(withRunLock(workspace, () => { throw new Error('fixture-operation-failure'); }), /fixture-operation-failure/);
    assert.equal(await withRunLock(workspace, () => 'reacquired'), 'reacquired');
  });
});

test('CLI acquires the run lock before opening even a missing or unreadable manifest', async () => {
  await withDirectory(async directory => {
    const keyPath = join(directory, 'key');
    await createKey(keyPath);
    await withRunLock(directory, async () => {
      await assert.rejects(main(['status', '--key-file', keyPath, '--manifest', join(directory, 'missing.json.enc')]),
        codeIs('RUN_LOCKED_INSPECT_BEFORE_RETRY'));
    });
  });
});

test('encrypted archives authenticate before releasing plaintext, including empty streams', async t => {
  await withDirectory(async directory => {
    const key = randomBytes(32);
    const archive = join(directory, 'archive.enc');
    const payload = Buffer.from('private-fixture-value\0' + 'x'.repeat(128 * 1024));
    await encryptStream(Readable.from([payload]), archive, key);
    assert.equal((await lstat(archive)).mode & 0o777, 0o600);
    const original = await readFile(archive);
    assert.equal(original.includes(Buffer.from('private-fixture-value')), false);
    const chunks = [];
    await decryptStream(archive, collector(chunks), key);
    assert.deepEqual(Buffer.concat(chunks), payload);
    for (const [name, offset] of [['magic', 0], ['nonce', 9], ['ciphertext', 25], ['tag', original.length - 1]]) {
      await t.test(`rejects changed ${name} without streaming unverified data`, async () => {
        const tampered = Buffer.from(original);
        tampered[offset] ^= 1;
        const path = join(directory, name + '.enc');
        await writeFile(path, tampered, { mode: 0o600 });
        const released = [];
        await assert.rejects(decryptStream(path, collector(released), key));
        assert.equal(Buffer.concat(released).length, 0);
      });
    }
    await t.test('rejects wrong keys and truncated archives', async () => {
      const released = [];
      await assert.rejects(decryptStream(archive, collector(released), randomBytes(32)));
      assert.equal(Buffer.concat(released).length, 0);
      const path = join(directory, 'short.enc');
      await writeFile(path, original.subarray(0, 25), { mode: 0o600 });
      await assert.rejects(decryptStream(path, collector([]), key), codeIs('INVALID_ENCRYPTED_ARCHIVE'));
    });
    await t.test('round-trips empty plaintext', async () => {
      const path = join(directory, 'empty.enc');
      await encryptStream(Readable.from([]), path, key);
      const empty = [];
      await decryptStream(path, collector(empty), key);
      assert.equal(Buffer.concat(empty).length, 0);
    });
    await t.test('round-trips JSON and refuses symlinked archive input', async () => {
      const path = join(directory, 'manifest.enc');
      await writeJson(path, { runId: randomUUID(), precise: '9007199254740993', nullable: null }, key);
      assert.equal((await readJson(path, key)).precise, '9007199254740993');
      await symlink(path, join(directory, 'archive-link'));
      await assert.rejects(readJson(join(directory, 'archive-link'), key), codeIs('PRIVATE_FILE_REQUIRED'));
    });
  });
});

test('process failures and output limits never include fixture credentials in errors', async () => {
  const secret = 'fixture-password-never-print-9f15';
  await assert.rejects(command(process.execPath, ['-e',
    `process.stdout.write(${JSON.stringify(secret)});process.stderr.write(${JSON.stringify(secret)});process.exit(2)`]), error => {
    assert.equal(error.message.includes(secret), false);
    return codeIs('CHILD_COMMAND_FAILED')(error);
  });
  await assert.rejects(command('/missing-fixture-command-' + secret, []), error => {
    assert.equal(error.message.includes(secret), false);
    return codeIs('CHILD_START_FAILED')(error);
  });
  await assert.rejects(command(process.execPath, ['-e', 'process.stdout.write("x".repeat(4096))'], { maxBytes: 128 }), codeIs('COMMAND_OUTPUT_TOO_LARGE'));
});

test('command output-limit failure reaps a child that ignores SIGTERM', async () => {
  await withDirectory(async directory => {
    const pidPath = join(directory, 'fixture-child.pid');
    let pid;
    try {
      await assert.rejects(command(process.execPath, ['-e',
        `require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));
        process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.stdout.write('x'.repeat(4096));`
      ], { maxBytes: 128 }), codeIs('COMMAND_OUTPUT_TOO_LARGE'));
      pid = Number(await readFile(pidPath, 'utf8'));
      let alive = true;
      for (let attempt = 0; attempt < 30 && alive; attempt++) {
        try { process.kill(pid, 0); await delay(20); } catch { alive = false; }
      }
      assert.equal(alive, false, 'output-limit failure left its child running');
    } finally {
      pid ??= Number(await readFile(pidPath, 'utf8').catch(() => '0'));
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }
  });
});

test('database location rejects remote local targets, pooled endpoints and unsafe URL overrides', () => {
  const secret = 'fixture-url-password-9f15';
  for (const [url, code] of [
    ['not-a-url-' + secret, 'INVALID_DATABASE_URL'],
    [`https://user:${secret}@db.example.test/database`, 'DIRECT_POSTGRES_URL_REQUIRED'],
    [`postgresql://user:${secret}@ep-test-pooler.example.test/database`, 'DIRECT_POSTGRES_URL_REQUIRED'],
    [`postgresql://user:${secret}@db.example.test/database`, 'LOOPBACK_DATABASE_REQUIRED'],
    [`postgresql://user:${secret}@127.0.0.1/database%0Aother`, 'INVALID_DATABASE_URL'],
  ]) {
    assert.throws(() => databaseLocation(url, { local: true }), error => {
      assert.equal(error.message.includes(secret), false);
      return codeIs(code)(error);
    });
  }
  for (const parameter of ['default_transaction_read_only=off', 'timezone=Asia%2FTokyo', 'search_path=unsafe', 'options=-c%20default_transaction_read_only%3Doff']) {
    assert.throws(() => databaseLocation(`postgresql://postgres@127.0.0.1/database?${parameter}`, { local: true }));
  }
  const first = databaseLocation(`postgresql://user:${secret}@127.0.0.1:5432/database`, { local: true });
  const rotated = databaseLocation('postgresql://other:rotated@127.0.0.1:5432/database', { local: true });
  assert.equal(first.identity, rotated.identity);
  assert.notEqual(first.identity, databaseLocation('postgresql://postgres@127.0.0.1:5433/database', { local: true }).identity);
});

test('migration history distinguishes prefix, target and every unknown divergence', () => {
  const expected = [{ hash: 'a'.repeat(64), created_at: '10' }, { hash: 'b'.repeat(64), created_at: '20' }];
  assert.equal(historyState(expected, []), 'prefix');
  assert.equal(historyState(expected, expected.slice(0, 1)), 'prefix');
  assert.equal(historyState(expected, structuredClone(expected)), 'target');
  for (const actual of [expected.slice(1), [...expected].reverse(), [...expected, expected[1]],
    [{ ...expected[0], hash: 'c'.repeat(64) }], [{ ...expected[0], created_at: '11' }]]) {
    assert.equal(historyState(expected, actual), 'unknown');
  }
});

const ownerLabel = 'io.momo.migration.run';
function ownedFixture() {
  const manifest = { runId: '11111111-2222-4333-8444-555555555555', postgres: { id: 'sha256:' + 'b'.repeat(64) },
    local: { container: 'a'.repeat(64), network: 'c'.repeat(64) } };
  const container = { Id: manifest.local.container, Image: manifest.postgres.id,
    Config: { Labels: { [ownerLabel]: manifest.runId } }, State: { Running: true },
    HostConfig: { Tmpfs: { '/var/lib/postgresql': 'rw,nosuid,size=1073741824' }, PortBindings: {} },
    Mounts: [{ Type: 'tmpfs', Destination: '/var/lib/postgresql' }],
    NetworkSettings: { Ports: { '5432/tcp': null },
      Networks: { fixture: { NetworkID: manifest.local.network } } } };
  const network = { Id: manifest.local.network, Internal: true, EnableIPv6: false,
    Options: { 'com.docker.network.bridge.gateway_mode_ipv4': 'isolated' },
    Labels: { [ownerLabel]: manifest.runId }, Containers: {} };
  return { manifest, container, network };
}

async function withFakeDocker(fixture, run) {
  await withDirectory(async directory => {
    const statePath = join(directory, 'docker-state.json');
    const logPath = join(directory, 'docker-calls.jsonl');
    await writeFile(statePath, JSON.stringify(fixture), { mode: 0o600 });
    await writeFile(join(directory, 'docker'), `#!${process.execPath}\n
      const fs = require('node:fs');
      const state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, 'utf8'));
      const args = process.argv.slice(2);
      fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + '\\n');
      if (args[0] === 'inspect') process.stdout.write(JSON.stringify([state.container]));
      else if (args[0] === 'network' && args[1] === 'inspect') process.stdout.write(JSON.stringify([state.network]));
      else if (args[0] === 'rm' || (args[0] === 'network' && args[1] === 'rm')) process.stdout.write('removed');
      else process.exit(2);
    `, { mode: 0o700 });
    const previous = process.env.PATH;
    process.env.PATH = directory + delimiter + previous;
    try { await run(async () => (await readFile(logPath, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))); }
    finally { process.env.PATH = previous; }
  });
}

test('owned-container guards reject wrong identities, persistence and network targets before removal', async t => {
  const valid = ownedFixture();
  assert.throws(() => localUrl(valid.manifest, 'momo_rehearsal_baseline'), codeIs('LOCAL_CONNECTION_REQUIRED'));
  assert.throws(() => localUrl(valid.manifest, 'postgres'), codeIs('OWNED_DATABASE_REQUIRED'));
  assert.throws(() => localUrl({ local: { port: 60432 } }, 'momo_rehearsal_baseline'), codeIs('LOCAL_CONNECTION_REQUIRED'));
  await withFakeDocker(valid, () => assertOwned(valid.manifest));
  for (const [name, change] of [
    ['wrong owner', fixture => { fixture.container.Config.Labels[ownerLabel] = 'another-run'; }],
    ['wrong image', fixture => { fixture.container.Image = 'sha256:' + 'd'.repeat(64); }],
    ['named volume', fixture => { fixture.container.Mounts.push({ Type: 'volume', Name: 'preserved-data' }); }],
    ['bind mount', fixture => { fixture.container.Mounts.push({ Type: 'bind', Source: '/fixture/preserved-data' }); }],
    ['public port', fixture => { fixture.container.NetworkSettings.Ports['5432/tcp'] = [{ HostIp: '0.0.0.0', HostPort: '5432' }]; }],
    ['loopback publish', fixture => { fixture.container.HostConfig.PortBindings['5432/tcp'] = [{ HostIp: '127.0.0.1', HostPort: '5433' }]; }],
    ['external network', fixture => { fixture.network.Internal = false; }],
    ['host gateway access', fixture => { delete fixture.network.Options['com.docker.network.bridge.gateway_mode_ipv4']; }],
    ['second network', fixture => { fixture.container.NetworkSettings.Networks.other = { NetworkID: 'd'.repeat(64) }; }],
  ]) {
    await t.test(name, async () => {
      const fixture = ownedFixture();
      change(fixture);
      await withFakeDocker(fixture, async calls => {
        await assert.rejects(assertOwned(fixture.manifest));
        await assert.rejects(withLocalConnection(fixture.manifest, () => assert.fail('unowned relay opened')));
        assert.ok((await calls()).every(args => !args.includes('rm')));
      });
    });
  }
  await t.test('cleanup refuses a different owner and both kinds of persistent mount', async () => {
    for (const change of [fixture => { fixture.container.Config.Labels[ownerLabel] = 'another-run'; },
      fixture => { fixture.container.Mounts.push({ Type: 'volume' }); },
      fixture => { fixture.container.Mounts.push({ Type: 'bind' }); }]) {
      const fixture = ownedFixture();
      change(fixture);
      await withFakeDocker(fixture, async calls => {
        await assert.rejects(cleanupLocal(fixture.manifest, async () => {}));
        assert.ok((await calls()).every(args => !args.includes('rm')));
      });
    }
  });
  await t.test('missing run, image, container and network identities never authorize cleanup', async () => {
    for (const change of [
      fixture => { delete fixture.manifest.runId; delete fixture.container.Config.Labels[ownerLabel]; delete fixture.network.Labels[ownerLabel]; },
      fixture => { delete fixture.manifest.postgres.id; delete fixture.container.Image; },
      fixture => { fixture.manifest.runId = '-'.repeat(36); fixture.container.Config.Labels[ownerLabel] = fixture.manifest.runId; },
      fixture => { fixture.manifest.local.container = ''; },
      fixture => { fixture.manifest.local.container = 'a'.repeat(12); },
      fixture => { delete fixture.manifest.local.network; },
      fixture => { fixture.manifest.local.network = ''; },
    ]) {
      const fixture = ownedFixture();
      change(fixture);
      await withFakeDocker(fixture, async calls => {
        await assert.rejects(cleanupLocal(fixture.manifest, async () => {}));
        assert.deepEqual(await calls(), []);
      });
    }
  });
});

async function withRunnerCommands(run) {
  await withDirectory(async directory => {
    const headPath = join(directory, 'candidate-head');
    const logPath = join(directory, 'migrator-calls.jsonl');
    const sha = 'e'.repeat(40);
    const executable = await command('which', ['pnpm']);
    await writeFile(headPath, sha, { mode: 0o600 });
    await writeFile(join(directory, 'git'), `#!${process.execPath}\n
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      if (args[0] === 'status' && args[1] === '--porcelain') process.exit(0);
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') process.stdout.write(fs.readFileSync(${JSON.stringify(headPath)}));
      else process.exit(2);
    `, { mode: 0o700 });
    await writeFile(join(directory, 'pnpm'), `#!${process.execPath}\n
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      if (args.length !== 1 || args[0] !== 'db:migrate:ci') process.exit(2);
      fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + '\\n');
      const result = require('node:child_process').spawnSync(${JSON.stringify(executable)}, args, { stdio: 'inherit' });
      process.exit(result.status ?? 1);
    `, { mode: 0o700 });
    const previous = process.env.PATH;
    process.env.PATH = directory + delimiter + previous;
    try {
      await run({
        candidate: { sha, migrationDigest: digest(expectedMigrationHistory(join(process.cwd(), 'drizzle'))),
          lockDigest: await fileDigest(join(process.cwd(), 'pnpm-lock.yaml')) },
        changeCandidate: () => writeFile(headPath, 'f'.repeat(40), { mode: 0o600 }),
        migratorCalls: async () => (await readFile(logPath, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
      });
    } finally { process.env.PATH = previous; }
  });
}

test('restore persists its started state and refuses a changed candidate before creating local resources', async () => {
  await withDirectory(async directory => withRunnerCommands(async commands => {
    const key = randomBytes(32);
    const source = { fixture: 'authenticated-source-report', connection: { server: builtinLocale } };
    const manifest = { ...ownedFixture().manifest, candidate: commands.candidate, local: null,
      state: 'snapshotted', snapshot: { auditDigest: digest(source) }, checks: {} };
    await writeJson(join(directory, 'source.json.enc'), source, key);
    const saves = [];
    await withFakeDocker(ownedFixture(), async calls => {
      await assert.rejects(runAction('restore', manifest, directory, key, async () => {
        saves.push(structuredClone(manifest));
        if (manifest.local?.starting) await commands.changeCandidate();
      }), codeIs('CANDIDATE_CHANGED'));
      assert.equal(saves[0].state, 'restore-started');
      assert.equal(saves[0].local, null);
      assert.equal(saves[1].local.starting, true);
      assert.deepEqual(await calls(), []);
      assert.equal(manifest.checks.restore, undefined);
    });
  }));
});

test('a valid encrypted report from another snapshot cannot authorize a restore', async () => {
  await withDirectory(async directory => withRunnerCommands(async commands => {
    const key = randomBytes(32);
    const manifest = { ...ownedFixture().manifest, candidate: commands.candidate, local: null,
      state: 'snapshotted', snapshot: { auditDigest: digest({ fixture: 'original' }) }, checks: {} };
    await writeJson(join(directory, 'source.json.enc'), { fixture: 'different-snapshot' }, key);
    await withFakeDocker(ownedFixture(), async calls => {
      await assert.rejects(runAction('restore', manifest, directory, key, () => assert.fail('state saved before report validation')),
        codeIs('REPORT_DIGEST_MISMATCH'));
      assert.deepEqual(await calls(), []);
    });
  }));
});

test('owned database retries inspect committed work, verify schemas and prove a second migrator is a no-op', async t => {
  await withDirectory(async directory => withRunnerCommands(async commands => {
    const keyPath = join(directory, 'key');
    await createKey(keyPath);
    const key = await loadKey(keyPath);
    const manifestPath = join(directory, 'manifest.json.enc');
    const manifest = { formatVersion: 1, runId: randomUUID(), candidate: commands.candidate,
      postgres: { id: await command('docker', ['inspect', '--format', '{{.Image}}', process.env.MOMO_DB_TEST_CONTAINER]) },
      state: 'restore-started', local: null, checks: {}, incomplete: [], durationsMs: {} };
    const save = () => writeJson(manifestPath, manifest, key);
    const capture = async database => {
      const sql = connect(localUrl(manifest, database));
      try {
        return await sql.begin('isolation level repeatable read read only', async transaction => ({
          connection: await inspectConnection(transaction, process.cwd()),
          schema: await inspectSchema(transaction), rows: await fingerprint(transaction),
        }));
      } finally { await sql.end(); }
    };
    const apply = async action => {
      await main([action, '--key-file', keyPath, '--manifest', manifestPath]);
      Object.assign(manifest, await readJson(manifestPath, key));
    };
    t.mock.method(console, 'log', () => {});
    try {
      // C is accepted verbatim by both musl and glibc. The builtin provider's
      // actual comparison locale remains C.UTF-8 and must also be retained.
      const fixtureLocale = { ...builtinLocale, collation: 'C', ctype: 'C' };
      await startLocal(manifest, save, { server: fixtureLocale });
      await withLocalConnection(manifest, async () => {
        assert.equal(await databaseState(manifest, 'momo_rehearsal_baseline'), 'empty');
        assert.equal(await databaseState(manifest, 'momo_rehearsal_migration'), 'missing');
        const baseline = connect(localUrl(manifest, 'momo_rehearsal_baseline'), { readOnly: false });
        try {
          compareDatabaseLocale(fixtureLocale, await inspectServer(baseline));
          await baseline.unsafe(`CREATE SCHEMA drizzle;
            CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint);
            CREATE TABLE public.rehearsal_values (id bigint PRIMARY KEY, value text NOT NULL);
            CREATE INDEX rehearsal_values_value_idx ON public.rehearsal_values(value);
            INSERT INTO public.rehearsal_values VALUES (9007199254740993, 'preserved-fixture');`);
          for (const entry of expectedMigrationHistory(join(process.cwd(), 'drizzle'))) {
            await baseline`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${entry.hash}, ${entry.created_at})`;
          }
        } finally { await baseline.end(); }
        const source = await capture('momo_rehearsal_baseline');
        manifest.snapshot = { mode: 'fixture', auditDigest: digest(source), archiveDigest: '0'.repeat(64) };
        await writeJson(join(directory, 'source.json.enc'), source, key);
        await save();

        await t.test('an interrupted committed restore is verified without an archive replay', async () => {
          await apply('restore');
          assert.equal(manifest.state, 'restored');
          assert.equal(manifest.checks.restore, true);
          assert.equal(await databaseState(manifest, 'momo_rehearsal_baseline'), 'populated');
          // There is deliberately no source.dump.enc: a blind restore fails.
          await assert.rejects(readFile(join(directory, 'source.dump.enc')), { code: 'ENOENT' });
        });
        await t.test('a fresh rehearsal invokes the normal migrator twice and compares both results', async () => {
          await apply('rehearse');
          assert.deepEqual(await commands.migratorCalls(), [['db:migrate:ci'], ['db:migrate:ci']]);
          assert.equal(manifest.state, 'verified');
          assert.equal(manifest.checks.migratorFirstRun, true);
          assert.equal(manifest.checks.migratorNoop, true);
          assert.equal(manifest.checks.migrationSchema, true);
        });
        await t.test('an existing migration target is verified without replay or fabricated command evidence', async () => {
          manifest.state = 'migration-started';
          delete manifest.checks.migratorFirstRun;
          delete manifest.checks.migratorNoop;
          delete manifest.firstMigrationDigest;
          delete manifest.migratedDigest;
          await save();
          await apply('rehearse');
          assert.equal((await commands.migratorCalls()).length, 2);
          assert.equal(manifest.checks.migratorNoop, false);
          assert.ok(manifest.incomplete.includes('interrupted-migrator-execution-requires-fresh-run'));
        });
        await t.test('verification rejects a dropped index with unchanged rows and ledger', async () => {
          const sql = connect(localUrl(manifest, 'momo_rehearsal_migration'), { readOnly: false });
          try { await sql`DROP INDEX public.rehearsal_values_value_idx`; }
          finally { await sql.end(); }
          await assert.rejects(apply('verify'), codeIs('RESTORED_SCHEMA_DIFFERS'));
          assert.equal((await commands.migratorCalls()).length, 2);
        });
        await t.test('pending tails fail closed before clone creation or migration', async () => {
          const before = await capture('momo_rehearsal_baseline');
          const pending = structuredClone(before);
          pending.connection.pending = [{ hash: 'f'.repeat(64), created_at: '999' }];
          assert.throws(() => compareMigration(pending, before), codeIs('PENDING_MIGRATIONS_REQUIRE_SCHEMA_COMPARATOR'));
          const originalDigest = manifest.baselineDigest;
          manifest.baselineDigest = digest(pending);
          manifest.state = 'restored';
          await writeJson(join(directory, 'baseline.json.enc'), pending, key);
          await save();
          await assert.rejects(apply('rehearse'), codeIs('PENDING_MIGRATIONS_REQUIRE_SCHEMA_COMPARATOR'));
          assert.equal((await commands.migratorCalls()).length, 2);
          manifest.baselineDigest = originalDigest;
          await writeJson(join(directory, 'baseline.json.enc'), before, key);
        });
        await t.test('an interrupted committed recovery is verified without a second restore', async () => {
          await createDatabase(manifest, 'momo_rehearsal_recovery', 'momo_rehearsal_baseline');
          manifest.state = 'recovery-started';
          await save();
          await apply('recover-rehearsal');
          assert.equal(manifest.state, 'recovery-verified');
          assert.equal(manifest.checks.databaseRecovery, true);
        });
        for (const mode of ['error', 'abort']) await t.test(`a parent ${mode} closes the loopback relay and its active PostgreSQL connection`, async () => {
          const transient = structuredClone(manifest);
          const controller = new AbortController();
          let port, closed;
          await assert.rejects(withLocalConnection(transient, async () => {
            port = Number(new URL(localUrl(transient, 'momo_rehearsal_baseline')).port);
            const socket = createConnection({ host: '127.0.0.1', port });
            socket.on('error', () => {});
            closed = new Promise(resolve => socket.once('close', resolve));
            await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
            const parameters = Buffer.from('user\0postgres\0database\0momo_rehearsal_baseline\0\0');
            const startup = Buffer.alloc(8 + parameters.length);
            startup.writeInt32BE(startup.length, 0);
            startup.writeInt32BE(196608, 4);
            parameters.copy(startup, 8);
            const response = new Promise((resolve, reject) => { socket.once('data', resolve); socket.once('error', reject); });
            socket.write(startup);
            await response;
            if (mode === 'error') throw new Error('fixture-parent-interrupted');
            controller.abort();
            await closed;
          }, { signal: controller.signal }), mode === 'error' ? /fixture-parent-interrupted/ : codeIs('LOCAL_DATABASE_RELAY_ABORTED'));
          await closed;
          assert.throws(() => localUrl(transient, 'momo_rehearsal_baseline'), codeIs('LOCAL_CONNECTION_REQUIRED'));
          await new Promise((resolve, reject) => {
            const socket = createConnection({ host: '127.0.0.1', port });
            socket.once('connect', () => { socket.destroy(); reject(new Error('relay listener survived')); });
            socket.once('error', error => error.code === 'ECONNREFUSED' ? resolve() : reject(error));
          });
          const count = await command('docker', ['exec', manifest.local.container, 'psql', '-U', 'postgres',
            '-d', 'momo_rehearsal_baseline', '-Atc',
            "SELECT count(*) FROM pg_stat_activity WHERE datname='momo_rehearsal_baseline' AND backend_type='client backend' AND pid<>pg_backend_pid()"]);
          assert.equal(count, '0');
          assert.equal(manifest.local.port, undefined, 'a relay port must never be saved in the manifest');
        });
        await t.test('candidate drift during verification cannot write successful evidence', async () => {
          manifest.state = 'recovery-started';
          delete manifest.checks.databaseRecovery;
          await rm(join(directory, 'recovered.json.enc'));
          await assert.rejects(runAction('recover-rehearsal', manifest, directory, key, async () => {
            await save();
            await commands.changeCandidate();
          }), codeIs('CANDIDATE_CHANGED'));
          assert.equal(manifest.checks.databaseRecovery, undefined);
          await assert.rejects(readFile(join(directory, 'recovered.json.enc')), { code: 'ENOENT' });
        });
      });
    } finally {
      await cleanupLocal(manifest, save);
    }
  }));
});

test('fingerprint sorts bounded row hashes even when complete values exceed the temporary-file budget', async () => {
  await withDatabase(async db => {
    await db.unsafe(`CREATE TABLE large_values (id integer, payload text);
      INSERT INTO large_values SELECT value, repeat('compressible-fixture-', 100000)
      FROM generate_series(1, 12) value;`);
    const inspect = () => db.begin('isolation level repeatable read read only', async sql => {
      await sql.unsafe("SET LOCAL work_mem = '64kB'; SET LOCAL temp_file_limit = '1MB'");
      return fingerprint(sql);
    });
    const before = await inspect();
    assert.equal(before.tables.find(table => table.name === 'large_values').rows, '12');
    await db.unsafe("UPDATE large_values SET payload = payload || 'changed' WHERE id=12");
    const after = await inspect();
    assert.throws(() => compareFingerprints(before, after), codeIs('SAVED_ROWS_DIFFER'));
  });
});

test('stream fingerprint preserves precise saved values, duplicates and empty tables across restore', async t => {
  await withDatabase(async (db, name) => {
    await db.unsafe(`
      CREATE TABLE precise_values (id bigint PRIMARY KEY, decimal_value numeric,
        payload jsonb, bytes bytea, nullable text, happened_at timestamptz, local_time timestamp);
      CREATE TABLE empty_values (id text PRIMARY KEY);
      CREATE TABLE duplicate_values (value text);
      INSERT INTO duplicate_values VALUES ('same-value'), ('same-value');
      CREATE TABLE generated_ids (id bigint GENERATED ALWAYS AS IDENTITY (START WITH 500) PRIMARY KEY);
      INSERT INTO generated_ids DEFAULT VALUES;
      INSERT INTO precise_values VALUES
        (9007199254740993, 12345678901234567890.123456789012345678,
          '{"precise":9007199254740993.0001,"nullable":null}', decode('0001ff','hex'), NULL,
          '2026-10-18 12:34:56.123456+09', '2026-10-18 12:34:56.123456'),
        (9007199254740992, -0.000000000000000001, '{"precise":9007199254740993.0002}',
          decode('00ff01','hex'), '', '2026-10-18 03:34:56.123456+00', '2026-10-18 03:34:56.123456');
    `);
    const snapshot = () => db.begin('isolation level repeatable read read only', sql => fingerprint(sql));
    const before = await snapshot();
    await t.test('empty-table and identity-sequence state are included', () => {
      const empty = before.tables.find(table => table.name === 'empty_values');
      assert.equal(empty.rows, '0');
      assert.equal(empty.digest, createHash('sha256').digest('hex'));
      assert.equal(before.tables.find(table => table.name === 'duplicate_values').rows, '2');
      assert.deepEqual(before.sequences.find(sequence => sequence.name === 'generated_ids_id_seq'),
        { schema: 'public', name: 'generated_ids_id_seq', last_value: '500', is_called: true });
    });
    await t.test('backup/restore retains the exact fingerprint', async () => {
      const backup = docker(['pg_dump', '-U', username, '--format=custom', name]);
      await withDatabase(async (copy, copyName) => {
        docker(['pg_restore', '-U', username, '--exit-on-error', '--single-transaction', '-d', copyName], backup);
        const after = await copy.begin('isolation level repeatable read read only', sql => fingerprint(sql));
        compareFingerprints(before, after);
      });
    });
    for (const [name, change] of [
      ['bigint', sql => sql`UPDATE precise_values SET id = 9007199254740994 WHERE id = 9007199254740993`],
      ['decimal', sql => sql`UPDATE precise_values SET decimal_value = decimal_value + 0.000000000000000001 WHERE id = 9007199254740993`],
      ['JSON number', sql => sql`UPDATE precise_values SET payload = '{"precise":9007199254740993.0002,"nullable":null}'::jsonb WHERE id = 9007199254740993`],
      ['bytea', sql => sql`UPDATE precise_values SET bytes = decode('0002ff','hex') WHERE id = 9007199254740993`],
      ['null', sql => sql`UPDATE precise_values SET nullable = '' WHERE id = 9007199254740993`],
      ['timestamp microseconds', sql => sql`UPDATE precise_values SET happened_at = happened_at + interval '1 microsecond' WHERE id = 9007199254740993`],
      ['duplicate row removal', sql => sql`DELETE FROM duplicate_values WHERE ctid IN (SELECT ctid FROM duplicate_values LIMIT 1)`],
    ]) {
      await t.test(`detects one saved ${name} change`, async () => {
        await db.begin(async sql => {
          await sql.savepoint(async savepoint => {
            await change(savepoint);
            const changed = await fingerprint(savepoint);
            assert.throws(() => compareFingerprints(before, changed), codeIs('SAVED_ROWS_DIFFER'));
            throw new Error('fixture-rollback');
          }).catch(error => { if (error.message !== 'fixture-rollback') throw error; });
        });
      });
    }
    await t.test('insertion order does not change the multiset fingerprint', async () => {
      await db.unsafe(`CREATE TEMP TABLE preserved AS SELECT * FROM precise_values;
        TRUNCATE precise_values; INSERT INTO precise_values SELECT * FROM preserved ORDER BY id DESC;`);
      compareFingerprints(before, await snapshot());
    });
    await t.test('sequence changes are checked independently of saved rows', async () => {
      await db`SELECT nextval('generated_ids_id_seq')`;
      const after = await snapshot();
      compareFingerprints(before, after, { sequences: false });
      assert.throws(() => compareFingerprints(before, after), codeIs('SEQUENCES_DIFFER'));
    });
  });
});

test('fingerprint accepts literal dots in catalog names and refuses RLS-hidden values', async () => {
  await withDatabase(async db => {
    await db.unsafe('CREATE SCHEMA "literal.dot"; CREATE TABLE "literal.dot"."table.name" ("column.name" text); INSERT INTO "literal.dot"."table.name" VALUES (\'fixture\')');
    const result = await db.begin('read only', sql => fingerprint(sql));
    assert.equal(result.tables.find(table => table.schema === 'literal.dot' && table.name === 'table.name').rows, '1');
  });
  const role = 'momo_rehearsal_reader_' + randomUUID().replaceAll('-', '').slice(0, 12);
  try {
    await withDatabase(async db => {
      await db.unsafe(`CREATE ROLE ${role}; CREATE TABLE hidden (id text);
        INSERT INTO hidden VALUES ('private-fixture'); ALTER TABLE hidden ENABLE ROW LEVEL SECURITY;
        GRANT SELECT ON hidden TO ${role}`);
      await assert.rejects(db.begin('read only', async sql => {
        await sql.unsafe(`SET LOCAL ROLE ${role}`);
        await fingerprint(sql);
      }));
    });
  } finally {
    docker(['psql', '-U', username, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', `DROP ROLE IF EXISTS ${role}`]);
  }
});

test('pg inventory adapter preserves parameters, schema shape, cursor cleanup and read-only snapshots', async t => {
  await withDatabase(async (db, name) => {
    await db.unsafe(`
      CREATE TYPE fixture_status AS ENUM ('open', 'closed');
      CREATE TABLE adapter_parent (id text PRIMARY KEY, status fixture_status NOT NULL);
      CREATE TABLE adapter_child (id text PRIMARY KEY, parent_id text REFERENCES adapter_parent(id));
      INSERT INTO adapter_parent VALUES ('fixture-parent', 'open');
      INSERT INTO adapter_child VALUES ('fixture-child', 'fixture-parent');
    `);
    const password = process.env.MOMO_DB_TEST_PASSWORD;
    const authority = encodeURIComponent(username) + (password ? ':' + encodeURIComponent(password) : '');
    const url = `postgresql://${authority}@127.0.0.1:${process.env.MOMO_DB_TEST_PORT ?? 5432}/${name}`;
    const client = connect(url);
    try {
      await t.test('connection settings pin read-only, timezone, search path and row security', async () => {
        const [settings] = await client`SELECT current_setting('default_transaction_read_only') AS readonly,
          current_setting('TimeZone') AS timezone, current_setting('search_path') AS path,
          current_setting('row_security') AS row_security`;
        assert.deepEqual(settings, { readonly: 'on', timezone: 'UTC', path: 'pg_catalog,public', row_security: 'off' });
        await assert.rejects(client`INSERT INTO adapter_parent VALUES ('should-not-exist', 'open')`, { code: '25006' });
      });
      await t.test('nested fragments renumber protocol parameters and keep adversarial text literal', async () => {
        const value = "'); DROP TABLE adapter_parent; --\nfixture";
        const fragment = client`${value}::text`;
        const [row] = await client`SELECT ${fragment} AS first, ${'second'}::text AS second,
          ${fragment} AS repeated, ${null}::text AS nullable`;
        assert.deepEqual(row, { first: value, second: 'second', repeated: value, nullable: null });
        assert.equal((await client`SELECT count(*)::text AS count FROM adapter_parent`)[0].count, '1');
      });
      await t.test('schema and identifier evidence agree across postgres.js and pg', async () => {
        const fromPostgres = await db.begin('isolation level repeatable read read only', async sql => {
          await sql`SELECT set_config('search_path', 'pg_catalog,public', true)`;
          const schema = await inspectSchema(sql);
          return { schema, identifiers: await inspectIdentifierValues(sql, schema), data: await fingerprint(sql) };
        });
        const fromPg = await client.begin('isolation level repeatable read read only', async sql => {
          const schema = await inspectSchema(sql);
          return { schema, identifiers: await inspectIdentifierValues(sql, schema), data: await fingerprint(sql) };
        });
        assert.deepEqual(fromPg, fromPostgres);
      });
      await t.test('early cursor exit and failed transaction release the connection', async () => {
        for await (const rows of client`SELECT generate_series(1, 1000) AS value`.cursor(4)) {
          assert.deepEqual(rows.map(row => row.value), [1, 2, 3, 4]);
          break;
        }
        assert.equal((await client`SELECT 42 AS value`)[0].value, 42);
        await assert.rejects(client.begin('isolation level repeatable read read only', async sql => {
          await sql`SELECT 1 / 0`;
        }), { code: '22012' });
        assert.equal((await client`SELECT 43 AS value`)[0].value, 43);
        await assert.rejects(client.begin('read write', () => assert.fail('unsafe transaction began')), codeIs('READ_ONLY_SNAPSHOT_REQUIRED'));
      });
    } finally { await client.end(); }
    assert.throws(() => inventoryClient({ ...databaseLocation(url, { local: true }).configuration,
      PGSSLMODE: 'disable', PGCHANNELBINDING: 'require' }), codeIs('CHANNEL_BINDING_REQUIRES_TLS'));
  });
});

function backendMessage(type, payload) {
  const bytes = Buffer.alloc(5 + payload.length);
  bytes.write(type, 0, 1, 'ascii');
  bytes.writeInt32BE(payload.length + 4, 1);
  payload.copy(bytes, 5);
  return bytes;
}

test('required channel binding rejects password and SCRAM fallback before a credential response', async t => {
  for (const [name, code, extra] of [
    ['cleartext password', 3, Buffer.alloc(0)],
    ['MD5 password', 5, Buffer.from([1, 2, 3, 4])],
    ['SCRAM without channel binding', 10, Buffer.from('SCRAM-SHA-256\0\0')],
    ['trust authentication', 0, Buffer.alloc(0)],
  ]) {
    await t.test(name, { timeout: 5000 }, async () => {
      let startup = Buffer.alloc(0);
      let receivedStartup = false;
      const responses = [];
      const sockets = new Set();
      const server = createServer(socket => {
        sockets.add(socket);
        socket.on('error', () => {});
        socket.on('close', () => sockets.delete(socket));
        socket.on('data', bytes => {
          if (!receivedStartup) {
            startup = Buffer.concat([startup, bytes]);
            if (startup.length < 4 || startup.length < startup.readInt32BE(0)) return;
            receivedStartup = true;
            const authentication = Buffer.alloc(4 + extra.length);
            authentication.writeInt32BE(code, 0);
            extra.copy(authentication, 4);
            socket.write(backendMessage('R', authentication));
            if (code === 0) socket.write(backendMessage('Z', Buffer.from('I')));
          } else {
            responses.push(Buffer.from(bytes));
            socket.end(backendMessage('E', Buffer.from('SERROR\0C28000\0Mfixture authentication refused\0\0')));
          }
        });
      });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const OriginalClient = pg.Client;
      // Only this fixture transport bypasses TLS to exercise real pg wire-parser
      // event ordering. Production inventoryClient always verifies TLS itself.
      pg.Client = class FixtureTransportClient extends OriginalClient {
        constructor(configuration) { super({ ...configuration, ssl: false }); }
      };
      let sql;
      try {
        sql = inventoryClient({ PGHOST: '127.0.0.1', PGPORT: String(server.address().port),
          PGDATABASE: 'fixture', PGUSER: 'fixture', PGPASSWORD: 'fixture-password-never-send',
          PGSSLMODE: 'require', PGCHANNELBINDING: 'require' });
        await assert.rejects(sql`SELECT 1`);
        await sql.end();
        sql = null;
        const sentPassword = Buffer.concat(responses).includes(Buffer.from('fixture-password-never-send'));
        assert.equal(sentPassword, false);
        // A PostgreSQL frontend password/SASL response starts with 'p'. A clean
        // Terminate ('X') is harmless for a server that used trust authentication.
        assert.ok(responses.every(bytes => bytes[0] !== 'p'.charCodeAt(0)));
      } finally {
        pg.Client = OriginalClient;
        if (sql) await sql.end().catch(() => {});
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
      }
    });
  }
});
