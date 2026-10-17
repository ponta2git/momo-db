import { setTimeout as delay } from 'node:timers/promises';
import { command, start } from './process.mjs';
import { decryptStream, fileDigest, requireCondition } from './files.mjs';
import { connect } from './database.mjs';

const ownerLabel = 'io.momo.migration.run';
const databaseNames = new Set(['momo_rehearsal_baseline', 'momo_rehearsal_migration', 'momo_rehearsal_smoke', 'momo_rehearsal_recovery']);

export async function resolvePostgresImage(image) {
  const id = await command('docker', ['image', 'inspect', '--format', '{{.Id}}', image]);
  requireCondition(/^sha256:[a-f0-9]{64}$/.test(id), 'POSTGRES_IMAGE_MUST_BE_IMMUTABLE');
  const version = await command('docker', ['run', '--rm', '--network', 'none', id, 'pg_dump', '--version']);
  requireCondition(/^pg_dump \(PostgreSQL\) 18\./.test(version), 'POSTGRES_18_CLIENT_REQUIRED');
  return { id, version };
}

export async function assertOwned(manifest) {
  requireCondition(typeof manifest.runId === 'string' && /^[a-f0-9-]{36}$/.test(manifest.runId), 'INVALID_RUN_ID');
  requireCondition(typeof manifest.local?.container === 'string' && /^[a-f0-9]{64}$/.test(manifest.local.container), 'OWNED_CONTAINER_REQUIRED');
  const inspected = JSON.parse(await command('docker', ['inspect', manifest.local.container]));
  const item = inspected[0];
  requireCondition(item?.Config?.Labels?.[ownerLabel] === manifest.runId &&
    item.Image === manifest.postgres.id && item.State.Running &&
    item.HostConfig.Tmpfs?.['/var/lib/postgresql'] &&
    !item.Mounts?.some(mount => mount.Type !== 'tmpfs'), 'CONTAINER_OWNERSHIP_MISMATCH');
  const bindings = item.NetworkSettings.Ports?.['5432/tcp'];
  requireCondition(bindings?.length === 1 && bindings[0].HostIp === '127.0.0.1' &&
    Number(bindings[0].HostPort) === manifest.local.port, 'LOOPBACK_PORT_MISMATCH');
  const network = JSON.parse(await command('docker', ['network', 'inspect', manifest.local.network]))[0];
  requireCondition(network?.Internal === true && network.Labels?.[ownerLabel] === manifest.runId &&
    Object.keys(item.NetworkSettings.Networks).length === 1 &&
    Object.values(item.NetworkSettings.Networks)[0].NetworkID === network.Id, 'ISOLATED_NETWORK_REQUIRED');
}

export function localUrl(manifest, database) {
  requireCondition(databaseNames.has(database), 'OWNED_DATABASE_REQUIRED');
  requireCondition(Number.isInteger(manifest.local?.port) && manifest.local.port > 0 && manifest.local.port < 65536, 'INVALID_LOCAL_PORT');
  return `postgresql://postgres@127.0.0.1:${manifest.local.port}/${database}`;
}

export async function startLocal(manifest, save) {
  if (manifest.local?.container) { await assertOwned(manifest); return; }
  const suffix = manifest.runId.replaceAll('-', '');
  const networkName = `momo-rehearsal-${suffix}`;
  const network = await command('docker', ['network', 'create', '--internal', '--label', `${ownerLabel}=${manifest.runId}`, networkName]);
  manifest.local = { network, networkName };
  await save();
  const container = await command('docker', ['run', '--detach', '--name', networkName,
    '--label', `${ownerLabel}=${manifest.runId}`, '--network', network,
    '--publish', '127.0.0.1::5432', '--memory', '2g', '--memory-swap', '2g',
    '--tmpfs', '/var/lib/postgresql:rw,nosuid,size=1073741824',
    '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', '--env', 'POSTGRES_DB=momo_rehearsal_baseline',
    '--env', 'POSTGRES_INITDB_ARGS=--encoding=UTF8 --locale=C.UTF-8',
    manifest.postgres.id]);
  manifest.local.container = container;
  await save();
  const port = await command('docker', ['port', container, '5432/tcp']);
  requireCondition(/^127\.0\.0\.1:\d+$/.test(port), 'LOOPBACK_PORT_MISMATCH');
  manifest.local.port = Number(port.split(':')[1]);
  await save();
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await command('docker', ['exec', container, 'pg_isready', '--username=postgres', '--dbname=momo_rehearsal_baseline']);
      await assertOwned(manifest);
      return;
    } catch { await delay(1000); }
  }
  requireCondition(false, 'LOCAL_POSTGRES_NOT_READY');
}

export async function restoreArchive(manifest, archive, database, key) {
  await assertOwned(manifest);
  requireCondition(databaseNames.has(database), 'OWNED_DATABASE_REQUIRED');
  requireCondition(await fileDigest(archive) === manifest.snapshot.archiveDigest, 'ARCHIVE_DIGEST_MISMATCH');
  if (database !== 'momo_rehearsal_baseline') await createDatabase(manifest, database);
  const { child, completed } = start('docker', ['exec', '-i', manifest.local.container,
    'pg_restore', '--exit-on-error', '--single-transaction', '--no-owner', '--no-acl',
    '--username=postgres', `--dbname=${database}`], { failureCode: 'RESTORE_FAILED' });
  child.stdout.resume();
  try {
    await Promise.all([decryptStream(archive, child.stdin, key), completed]);
  } catch (error) { child.kill('SIGTERM'); await completed.catch(() => {}); throw error; }
}

export async function createDatabase(manifest, database, template) {
  await assertOwned(manifest);
  requireCondition(databaseNames.has(database) && (!template || databaseNames.has(template)), 'OWNED_DATABASE_REQUIRED');
  const administrativeUrl = new URL(localUrl(manifest, 'momo_rehearsal_baseline'));
  administrativeUrl.pathname = '/postgres';
  const sql = connect(administrativeUrl.toString(), { readOnly: false });
  try {
    if (template) await sql`CREATE DATABASE ${sql(database)} TEMPLATE ${sql(template)}`;
    else await sql`CREATE DATABASE ${sql(database)}`;
  } finally { await sql.end({ timeout: 1 }); }
}

export async function cleanupLocal(manifest, save) {
  // Cleanup also handles a failed start. Every object is reidentified before removal.
  if (manifest.local?.container) {
    const item = JSON.parse(await command('docker', ['inspect', manifest.local.container]))[0];
    requireCondition(item?.Config?.Labels?.[ownerLabel] === manifest.runId &&
      item.Image === manifest.postgres.id && !item.Mounts?.some(mount => mount.Type !== 'tmpfs'), 'CONTAINER_OWNERSHIP_MISMATCH');
    await command('docker', ['rm', '--force', manifest.local.container]);
    delete manifest.local.container;
    await save();
  }
  if (manifest.local?.network) {
    const network = JSON.parse(await command('docker', ['network', 'inspect', manifest.local.network]))[0];
    requireCondition(network?.Labels?.[ownerLabel] === manifest.runId &&
      Object.keys(network.Containers ?? {}).length === 0, 'NETWORK_OWNERSHIP_MISMATCH');
    await command('docker', ['network', 'rm', manifest.local.network]);
    delete manifest.local.network;
    await save();
  }
  manifest.local = null;
  await save();
}
