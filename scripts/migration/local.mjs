import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { command, start } from './process.mjs';
import { decryptStream, fileDigest, requireCondition } from './files.mjs';
import { connect, databaseLocale } from './database.mjs';

const ownerLabel = 'io.momo.migration.run';
const databaseNames = new Set(['momo_rehearsal_baseline', 'momo_rehearsal_migration', 'momo_rehearsal_smoke', 'momo_rehearsal_recovery']);
const fullId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const noMutationCheck = async () => {};
const localConnections = new WeakMap();
const isolatedGateway = 'com.docker.network.bridge.gateway_mode_ipv4';

function assertIdentity(manifest) {
  requireCondition(typeof manifest.runId === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(manifest.runId), 'INVALID_RUN_ID');
  requireCondition(typeof manifest.postgres?.id === 'string' &&
    /^sha256:[a-f0-9]{64}$/.test(manifest.postgres.id), 'POSTGRES_IMAGE_MUST_BE_IMMUTABLE');
}

export async function resolvePostgresImage(image) {
  const id = await command('docker', ['image', 'inspect', '--format', '{{.Id}}', image]);
  requireCondition(/^sha256:[a-f0-9]{64}$/.test(id), 'POSTGRES_IMAGE_MUST_BE_IMMUTABLE');
  const version = await command('docker', ['run', '--rm', '--network', 'none', id, 'pg_dump', '--version']);
  requireCondition(/^pg_dump \(PostgreSQL\) 18\./.test(version), 'POSTGRES_18_CLIENT_REQUIRED');
  await command('docker', ['run', '--rm', '--network', 'none', id, 'sh', '-c', 'command -v nc >/dev/null'],
    { failureCode: 'POSTGRES_IMAGE_RELAY_REQUIRED' });
  await command('docker', ['run', '--rm', '--network', 'none', id, 'sh', '-c', 'test -s /etc/ssl/certs/ca-certificates.crt'],
    { failureCode: 'POSTGRES_IMAGE_SYSTEM_CA_REQUIRED' });
  return { id, version };
}

export async function assertOwned(manifest) {
  assertIdentity(manifest);
  requireCondition(fullId(manifest.local?.container), 'OWNED_CONTAINER_REQUIRED');
  requireCondition(fullId(manifest.local?.network), 'OWNED_NETWORK_REQUIRED');
  const inspected = JSON.parse(await command('docker', ['inspect', manifest.local.container]));
  const item = inspected[0];
  requireCondition(item?.Id === manifest.local.container && item.Config?.Labels?.[ownerLabel] === manifest.runId &&
    item.Image === manifest.postgres.id && item.State.Running &&
    item.HostConfig.Tmpfs?.['/var/lib/postgresql'] &&
    !item.Mounts?.some(mount => mount.Type !== 'tmpfs'), 'CONTAINER_OWNERSHIP_MISMATCH');
  requireCondition(Object.keys(item.HostConfig.PortBindings ?? {}).length === 0 &&
    Object.values(item.NetworkSettings.Ports ?? {}).every(bindings => !bindings || bindings.length === 0), 'PUBLISHED_PORTS_FORBIDDEN');
  const network = JSON.parse(await command('docker', ['network', 'inspect', manifest.local.network]))[0];
  requireCondition(network?.Id === manifest.local.network && network.Internal === true && network.Labels?.[ownerLabel] === manifest.runId &&
    network.Options?.[isolatedGateway] === 'isolated' && !network.EnableIPv6 &&
    Object.keys(item.NetworkSettings.Networks).length === 1 &&
    Object.values(item.NetworkSettings.Networks)[0].NetworkID === network.Id, 'ISOLATED_NETWORK_REQUIRED');
}

export function localUrl(manifest, database) {
  requireCondition(databaseNames.has(database), 'OWNED_DATABASE_REQUIRED');
  const port = localConnections.get(manifest)?.port;
  requireCondition(Number.isInteger(port) && port > 0 && port < 65536, 'LOCAL_CONNECTION_REQUIRED');
  return `postgresql://postgres@127.0.0.1:${port}/${database}`;
}

export async function withLocalConnection(manifest, operation, { signal } = {}) {
  requireCondition(!signal?.aborted, 'LOCAL_DATABASE_RELAY_ABORTED');
  await assertOwned(manifest);
  if (localConnections.has(manifest)) return operation();
  // Internal Docker networks intentionally do not publish host ports. Relay
  // PostgreSQL only through Docker's exec stream: the DB retains no outbound
  // route, and its temporary host listener is restricted to IPv4 loopback.
  const sockets = new Set();
  const children = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    const running = start('docker', ['exec', '-i', manifest.local.container, 'nc', '127.0.0.1', '5432'],
      { failureCode: 'LOCAL_DATABASE_RELAY_FAILED' });
    children.add(running);
    socket.on('error', () => {});
    running.child.stdin.on('error', () => socket.destroy());
    socket.pipe(running.child.stdin);
    running.child.stdout.pipe(socket);
    socket.once('close', () => {
      sockets.delete(socket);
      running.child.kill('SIGKILL');
    });
    running.completed.then(() => socket.end(), () => socket.destroy()).finally(() => children.delete(running));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  localConnections.set(manifest, { port: server.address().port });
  let closing;
  const close = () => {
    if (closing) return closing;
    localConnections.delete(manifest);
    const closed = new Promise(resolve => server.close(resolve));
    for (const socket of sockets) socket.destroy();
    for (const { child } of children) child.kill('SIGKILL');
    closing = Promise.allSettled([closed, ...Array.from(children, ({ completed }) => completed)]);
    return closing;
  };
  const abort = () => { void close(); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    requireCondition(!signal?.aborted, 'LOCAL_DATABASE_RELAY_ABORTED');
    const result = await operation();
    requireCondition(!signal?.aborted, 'LOCAL_DATABASE_RELAY_ABORTED');
    return result;
  } finally {
    signal?.removeEventListener('abort', abort);
    await close();
  }
}

export function localInitdbArguments(server) {
  if (!server) return '--encoding=UTF8 --locale-provider=libc --locale=C.UTF-8';
  const locale = databaseLocale(server);
  requireCondition(locale.encoding === 'UTF8' && ['b', 'c'].includes(locale.localeProvider) && locale.icuRules === null,
    'DATABASE_LOCALE_REQUIRES_LOCAL_IMAGE_DESIGN');
  requireCondition([locale.collation, locale.ctype].every(value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.@+-]*$/.test(value)),
    'UNSUPPORTED_DATABASE_LOCALE');
  const args = ['--encoding=UTF8', `--locale-provider=${locale.localeProvider === 'b' ? 'builtin' : 'libc'}`,
    `--lc-collate=${locale.collation}`, `--lc-ctype=${locale.ctype}`];
  if (locale.localeProvider === 'b') {
    requireCondition(['C', 'C.UTF-8', 'PG_UNICODE_FAST'].includes(locale.locale), 'UNSUPPORTED_BUILTIN_LOCALE');
    args.push(`--builtin-locale=${locale.locale}`);
  } else requireCondition(locale.locale === null, 'UNSUPPORTED_DATABASE_LOCALE');
  return args.join(' ');
}

export async function startLocal(manifest, save, { beforeMutation = noMutationCheck, signal, server } = {}) {
  assertIdentity(manifest);
  const initdb = localInitdbArguments(server);
  if (manifest.local?.container) { await assertOwned(manifest); return; }
  requireCondition(!manifest.local, 'LOCAL_START_INCOMPLETE_REQUIRES_INSPECTION');
  const suffix = manifest.runId.replaceAll('-', '');
  const networkName = `momo-rehearsal-${suffix}`;
  // A crash can happen after Docker creates a resource and before its ID is
  // returned. Retain its unique planned name for manual, read-only inspection.
  manifest.local = { networkName, starting: true };
  await save();
  await beforeMutation();
  const network = await command('docker', ['network', 'create', '--internal', '--opt', `${isolatedGateway}=isolated`,
    '--label', `${ownerLabel}=${manifest.runId}`, networkName], { signal });
  requireCondition(fullId(network), 'OWNED_NETWORK_REQUIRED');
  manifest.local.network = network;
  await save();
  await beforeMutation();
  const container = await command('docker', ['run', '--detach', '--name', networkName,
    '--label', `${ownerLabel}=${manifest.runId}`, '--network', network,
    '--memory', '3g', '--memory-swap', '3g',
    '--tmpfs', '/var/lib/postgresql:rw,nosuid,size=2147483648',
    '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', '--env', 'POSTGRES_DB=momo_rehearsal_baseline',
    '--env', `POSTGRES_INITDB_ARGS=${initdb}`,
    manifest.postgres.id], { signal });
  requireCondition(fullId(container), 'OWNED_CONTAINER_REQUIRED');
  manifest.local.container = container;
  await save();
  for (let attempt = 0; attempt < 60; attempt++) {
    requireCondition(!signal?.aborted, 'REHEARSAL_INTERRUPTED');
    try {
      // initdb's temporary server accepts Unix sockets before the final TCP
      // server is ready. The relay must never race that shutdown/restart.
      await command('docker', ['exec', container, 'pg_isready', '--host=127.0.0.1', '--username=postgres', '--dbname=momo_rehearsal_baseline']);
    } catch { await delay(1000); continue; }
    await assertOwned(manifest);
    delete manifest.local.starting;
    await save();
    return;
  }
  requireCondition(false, 'LOCAL_POSTGRES_NOT_READY');
}

function administrativeUrl(manifest) {
  const url = new URL(localUrl(manifest, 'momo_rehearsal_baseline'));
  url.pathname = '/postgres';
  return url.toString();
}

export async function databaseState(manifest, database) {
  await assertOwned(manifest);
  requireCondition(databaseNames.has(database), 'OWNED_DATABASE_REQUIRED');
  const administrative = connect(administrativeUrl(manifest));
  try {
    const [result] = await administrative`SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = ${database}) AS present`;
    if (!result.present) return 'missing';
  } finally { await administrative.end(); }
  const sql = connect(localUrl(manifest, database));
  try {
    return await sql.begin('isolation level repeatable read read only', async transaction => {
      const [result] = await transaction`SELECT
        EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_') OR
        EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_') OR
        EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_') OR
        EXISTS (SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('public', 'information_schema') AND nspname !~ '^pg_') OR
        EXISTS (SELECT 1 FROM pg_extension WHERE extname <> 'plpgsql') OR
        EXISTS (SELECT 1 FROM pg_event_trigger) OR EXISTS (SELECT 1 FROM pg_foreign_server) OR
        EXISTS (SELECT 1 FROM pg_publication) AS populated`;
      return result.populated ? 'populated' : 'empty';
    });
  } finally { await sql.end(); }
}

export async function restoreArchive(manifest, archive, database, key, { beforeMutation = noMutationCheck, signal } = {}) {
  await assertOwned(manifest);
  requireCondition(databaseNames.has(database), 'OWNED_DATABASE_REQUIRED');
  requireCondition(await fileDigest(archive) === manifest.snapshot.archiveDigest, 'ARCHIVE_DIGEST_MISMATCH');
  if (await databaseState(manifest, database) === 'missing') await createDatabase(manifest, database, undefined, { beforeMutation });
  requireCondition(await databaseState(manifest, database) === 'empty', 'RESTORE_TARGET_MUST_BE_EMPTY');
  await beforeMutation();
  const { child, completed } = start('docker', ['exec', '-i', manifest.local.container,
    'pg_restore', '--exit-on-error', '--single-transaction', '--no-owner', '--no-acl',
    '--username=postgres', `--dbname=${database}`], { failureCode: 'RESTORE_FAILED', signal });
  child.stdout.resume();
  try {
    await Promise.all([decryptStream(archive, child.stdin, key), completed]);
  } catch (error) { child.kill('SIGKILL'); await completed.catch(() => {}); throw error; }
}

export async function createDatabase(manifest, database, template, { beforeMutation = noMutationCheck } = {}) {
  await assertOwned(manifest);
  requireCondition(databaseNames.has(database) && (!template || databaseNames.has(template)), 'OWNED_DATABASE_REQUIRED');
  requireCondition(await databaseState(manifest, database) === 'missing', 'DATABASE_ALREADY_EXISTS_VERIFY_ONLY');
  const sql = connect(administrativeUrl(manifest), { readOnly: false });
  try {
    await beforeMutation();
    if (template) await sql`CREATE DATABASE ${sql(database)} TEMPLATE ${sql(template)}`;
    else await sql`CREATE DATABASE ${sql(database)}`;
  } finally { await sql.end({ timeout: 1 }); }
}

export async function cleanupLocal(manifest, save) {
  // Cleanup also handles a failed start. Every object is reidentified before removal.
  assertIdentity(manifest);
  if (manifest.local && 'container' in manifest.local) requireCondition(fullId(manifest.local.container), 'OWNED_CONTAINER_REQUIRED');
  if (manifest.local && 'network' in manifest.local) requireCondition(fullId(manifest.local.network), 'OWNED_NETWORK_REQUIRED');
  if (manifest.local?.container) requireCondition(fullId(manifest.local.network), 'OWNED_NETWORK_REQUIRED');
  requireCondition(!manifest.local?.starting || fullId(manifest.local.network), 'LOCAL_START_INCOMPLETE_REQUIRES_INSPECTION');
  if (manifest.local?.container) {
    const item = JSON.parse(await command('docker', ['inspect', manifest.local.container]))[0];
    requireCondition(item?.Id === manifest.local.container && item.Config?.Labels?.[ownerLabel] === manifest.runId &&
      item.Image === manifest.postgres.id && !item.Mounts?.some(mount => mount.Type !== 'tmpfs'), 'CONTAINER_OWNERSHIP_MISMATCH');
    await command('docker', ['rm', '--force', manifest.local.container]);
    delete manifest.local.container;
    await save();
  }
  if (manifest.local?.network) {
    const network = JSON.parse(await command('docker', ['network', 'inspect', manifest.local.network]))[0];
    requireCondition(network?.Id === manifest.local.network && network.Labels?.[ownerLabel] === manifest.runId &&
      Object.keys(network.Containers ?? {}).length === 0, 'NETWORK_OWNERSHIP_MISMATCH');
    await command('docker', ['network', 'rm', manifest.local.network]);
    delete manifest.local.network;
    await save();
  }
  manifest.local = null;
  await save();
}
