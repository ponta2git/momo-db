import { constants } from 'node:fs';
import { chmod, copyFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { historyState } from './database.mjs';
import { digest, fileDigest, privateDirectory, privateFile, readJson, requireCondition, withRunLock, writeJson } from './files.mjs';

// A new candidate may reuse an authenticated, immutable source snapshot. It
// never inherits migration/consumer/final-freeze evidence from the old run.
export async function importSnapshot(path, directory, key, expected) {
  requireCondition(isAbsolute(path), 'ABSOLUTE_SNAPSHOT_MANIFEST_REQUIRED');
  const sourceDirectory = dirname(path);
  await privateDirectory(sourceDirectory);
  await privateDirectory(directory);
  requireCondition(resolve(sourceDirectory) !== resolve(directory), 'DISTINCT_SNAPSHOT_WORKSPACE_REQUIRED');
  return withRunLock(sourceDirectory, async () => {
    const previous = await readJson(path, key);
    requireCondition(previous.formatVersion === 1 && previous.checks?.sourceSnapshot === true &&
      previous.snapshot?.mode === 'online-consistent-snapshot' &&
      typeof previous.source?.identity === 'string' && /^[a-f0-9]{64}$/.test(previous.source.identity) &&
      typeof previous.candidate?.sha === 'string' && /^[a-f0-9]{40}$/.test(previous.candidate.sha), 'VALID_SOURCE_SNAPSHOT_REQUIRED');
    const source = await readJson(resolve(sourceDirectory, 'source.json.enc'), key);
    requireCondition(digest(source) === previous.snapshot.auditDigest, 'REPORT_DIGEST_MISMATCH');
    requireCondition(source.connection.ledgerDigest === digest(source.connection.ledger) &&
      historyState(expected, source.connection.ledger) !== 'unknown', 'SNAPSHOT_LEDGER_NOT_CANDIDATE_PREFIX');
    const archive = resolve(sourceDirectory, 'source.dump.enc');
    await privateFile(archive);
    requireCondition(await fileDigest(archive) === previous.snapshot.archiveDigest &&
      (await stat(archive)).size === previous.snapshot.bytes, 'ARCHIVE_DIGEST_MISMATCH');
    const destination = resolve(directory, 'source.dump.enc');
    await copyFile(archive, destination, constants.COPYFILE_EXCL);
    await chmod(destination, 0o600);
    // Hash the copied bytes too; a concurrent external change cannot replace
    // the archive between validation and copy unnoticed.
    requireCondition(await fileDigest(destination) === previous.snapshot.archiveDigest, 'ARCHIVE_CHANGED_DURING_COPY');
    await writeJson(resolve(directory, 'source.json.enc'), source, key);
    return {
      source: previous.source,
      snapshot: { ...previous.snapshot, pendingDigest: digest(expected.slice(source.connection.ledger.length)) },
      sourceAuditDigest: digest(source),
      snapshotOrigin: { runId: previous.runId, candidate: previous.candidate.sha, manifestDigest: digest(previous) },
    };
  });
}
