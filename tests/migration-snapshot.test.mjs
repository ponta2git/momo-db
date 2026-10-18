import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { digest, encryptStream, fileDigest, readJson, withRunLock, writeJson } from '../scripts/migration/files.mjs';
import { importSnapshot } from '../scripts/migration/snapshot.mjs';
import { parseArguments } from '../scripts/migration/run.mjs';

const entry = { hash: 'a'.repeat(64), created_at: '1' };
const next = { hash: 'b'.repeat(64), created_at: '2' };
const codeIs = code => error => error.code === code;

async function fixture(operation) {
  const directory = await mkdtemp(join(tmpdir(), 'momo-snapshot-import-'));
  await chmod(directory, 0o700);
  const source = join(directory, 'source'), target = join(directory, 'target');
  await mkdir(source, { mode: 0o700 });
  await mkdir(target, { mode: 0o700 });
  const key = randomBytes(32), archive = join(source, 'source.dump.enc');
  const report = { connection: { ledger: [entry], ledgerDigest: digest([entry]) }, privateValue: 'preserved' };
  await encryptStream(Readable.from(['fixture archive']), archive, key);
  const manifest = { formatVersion: 1, runId: 'source-run', candidate: { sha: 'c'.repeat(40) },
    source: { identity: 'd'.repeat(64), configuration: '/private/never-open-this-file.enc' },
    checks: { sourceSnapshot: true, migration: true, databaseRecovery: true },
    snapshot: { mode: 'online-consistent-snapshot', archiveDigest: await fileDigest(archive),
      auditDigest: digest(report), bytes: (await readFile(archive)).length, pendingDigest: digest([]) } };
  const path = join(source, 'manifest.json.enc');
  await writeJson(path, manifest, key);
  await writeJson(join(source, 'source.json.enc'), report, key);
  try { await operation({ source, target, key, archive, path, manifest, report }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('reuses a verified encrypted snapshot without reading source configuration or carrying old gates', async () => {
  await fixture(async ({ target, key, archive, path, manifest, report }) => {
    const result = await importSnapshot(path, target, key, [entry, next]);
    assert.deepEqual(await readFile(join(target, 'source.dump.enc')), await readFile(archive));
    assert.deepEqual(await readJson(join(target, 'source.json.enc'), key), report);
    assert.equal(result.snapshot.pendingDigest, digest([next]));
    assert.equal(result.snapshotOrigin.manifestDigest, digest(manifest));
    assert.equal(Object.hasOwn(result, 'checks'), false);
    assert.equal(Object.hasOwn(result, 'local'), false);
    assert.equal(Object.hasOwn(result, 'baselineDigest'), false);
    await assert.rejects(importSnapshot(path, target, key, [entry, next]), { code: 'EEXIST' });
  });
});

test('refuses changed source history, report, archive, wrong key, or an active source operation', async () => {
  await fixture(async ({ source, target, key, archive, path, report }) => {
    await assert.rejects(importSnapshot(path, target, key, [next]), codeIs('SNAPSHOT_LEDGER_NOT_CANDIDATE_PREFIX'));
    await assert.rejects(importSnapshot(path, target, randomBytes(32), [entry]));
    await withRunLock(source, async () => {
      await assert.rejects(importSnapshot(path, target, key, [entry]), codeIs('RUN_LOCKED_INSPECT_BEFORE_RETRY'));
    });
    await writeJson(join(source, 'source.json.enc'), { ...report, privateValue: 'changed' }, key);
    await assert.rejects(importSnapshot(path, target, key, [entry]), codeIs('REPORT_DIGEST_MISMATCH'));
    await writeJson(join(source, 'source.json.enc'), report, key);
    await writeFile(archive, randomBytes(80), { mode: 0o600 });
    await assert.rejects(importSnapshot(path, target, key, [entry]), codeIs('ARCHIVE_DIGEST_MISMATCH'));
  });
});

test('snapshot import is an explicit prepare-only alternative to source configuration', () => {
  const args = ['--key-file', '/private/key', '--snapshot-manifest', '/private/snapshot'];
  assert.equal(parseArguments(['prepare', ...args]).options['snapshot-manifest'], '/private/snapshot');
  assert.throws(() => parseArguments(['snapshot', ...args]), codeIs('SNAPSHOT_IMPORT_ONLY_FOR_PREPARE'));
  assert.throws(() => parseArguments(['prepare', ...args, '--source-config', '/private/source']), codeIs('SNAPSHOT_IMPORT_ONLY_FOR_PREPARE'));
});
