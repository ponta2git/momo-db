import { randomUUID } from 'node:crypto';
import { databaseLocation } from './database.mjs';
import { command, start } from './process.mjs';
import { encryptStream, requireCondition as check } from './files.mjs';

/** An aborted Docker client must not leave pg_dump reading production indefinitely. */
export async function encryptedSourceDump({ url, image, snapshot, archive, key, signal,
  timeoutMs = 1200000 }) {
  check(/^sha256:[a-f0-9]{64}$/.test(image) && /^[0-9A-Fa-f-]+$/.test(snapshot),
    'PINNED_DUMP_CLIENT_AND_SNAPSHOT_REQUIRED');
  check(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 1800000, 'DUMP_TIMEOUT_INVALID');
  const ownership = randomUUID();
  const configuration = databaseLocation(url).configuration;
  const environment = { ...process.env, ...configuration,
    PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=300000 -c lock_timeout=10000',
    PGAPPNAME: 'momo-db-rehearsal-dump' };
  const names = [...Object.keys(configuration), 'PGOPTIONS', 'PGAPPNAME'];
  const cancellation = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) :
    AbortSignal.timeout(timeoutMs);
  let id;
  try {
    cancellation.throwIfAborted();
    // Creating a stopped container has no source I/O. Let creation settle so
    // cancellation cannot discard its ownership ID before cleanup can use it.
    id = await command('docker', ['create', '--interactive',
      '--label', `io.momo.dump.owner=${ownership}`, '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', ...names.flatMap(name => ['--env', name]),
      image, 'pg_dump', '--format=custom', '--no-password', `--snapshot=${snapshot}`],
    { env: environment });
    check(/^[a-f0-9]{64}$/.test(id), 'DUMP_CONTAINER_ID_INVALID');
    cancellation.throwIfAborted();
    const { child, completed } = start('docker', ['start', '--attach', '--interactive', id],
      { signal: cancellation, failureCode: 'SOURCE_DUMP_FAILED' });
    child.stdin.end();
    try { await Promise.all([encryptStream(child.stdout, archive, key), completed]); }
    catch (error) { child.kill('SIGKILL'); await completed.catch(() => {}); throw error; }
  } finally {
    if (id) {
      const [observed] = JSON.parse(await command('docker', ['inspect', id]));
      check(observed.Id === id && observed.Image === image &&
        observed.Config.Labels?.['io.momo.dump.owner'] === ownership, 'DUMP_CONTAINER_OWNERSHIP_CHANGED');
      // Explicit removal closes the server session even after client cancellation.
      await command('docker', ['rm', '--force', id]);
    }
  }
}
