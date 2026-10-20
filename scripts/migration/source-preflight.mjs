import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expectedCutoverBaseline, cutoverBaselineMatches } from '../check-cutover-baseline.mjs';
import { connect, databaseLocation, inspectServer } from './database.mjs';
import { command } from './process.mjs';
import { digest, loadKey, writeJson, RehearsalError, requireCondition as check } from './files.mjs';

const provider = 'https://console.neon.tech/api/v2';
const isolation = 'isolation level repeatable read read only';

export function sourceApproval(env = process.env) {
  const value = {
    project: env.MOMO_REHEARSAL_PROJECT_ID,
    branch: env.MOMO_REHEARSAL_BRANCH_ID,
    endpoint: env.MOMO_REHEARSAL_ENDPOINT_ID,
    host: env.MOMO_DB_EXPECTED_DIRECT_HOST,
    database: 'neondb',
  };
  check(['project', 'branch', 'endpoint'].every(name =>
    typeof value[name] === 'string' && /^[a-z0-9-]+$/.test(value[name])), 'APPROVED_NEON_IDENTITY_REQUIRED');
  check(typeof value.host === 'string' && /^[a-z0-9.-]+\.neon\.tech$/.test(value.host) &&
    !value.host.includes('-pooler.'), 'APPROVED_DIRECT_HOST_REQUIRED');
  return value;
}

export function matchSourceEndpoint(url, approval, response) {
  const location = databaseLocation(url);
  check(location.configuration.PGHOST === approval.host &&
    location.configuration.PGDATABASE === approval.database &&
    location.configuration.PGPORT === '5432' &&
    location.configuration.PGSSLMODE === 'verify-full', 'SOURCE_NOT_APPROVED');
  check(Array.isArray(response?.endpoints), 'NEON_ENDPOINT_RESPONSE_INVALID');
  const matches = response.endpoints.filter(item => item.id === approval.endpoint);
  check(matches.length === 1, 'NEON_ENDPOINT_NOT_UNIQUE');
  const endpoint = matches[0];
  check(endpoint.project_id === approval.project && endpoint.branch_id === approval.branch &&
    endpoint.host === approval.host && endpoint.type === 'read_write' && endpoint.disabled === false,
  'NEON_ENDPOINT_NOT_APPROVED');
  return location;
}

async function readEndpointsWithCli(approval) {
  const output = await command('neonctl', ['api', `/projects/${approval.project}/endpoints`,
    '--method', 'GET', '--output', 'json', '--no-analytics'],
  { signal: AbortSignal.timeout(20000), failureCode: 'NEON_CLI_READ_ACCESS_REQUIRED' });
  return JSON.parse(output);
}

export async function verifySourceEndpoint(url, approval, {
  token = process.env.NEON_API_KEY, request = fetch, cliRead = readEndpointsWithCli,
} = {}) {
  if (!token) return matchSourceEndpoint(url, approval, await cliRead(approval));
  const response = await request(`${provider}/projects/${encodeURIComponent(approval.project)}/endpoints`, {
    method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  check(response.ok, 'NEON_ENDPOINT_LOOKUP_FAILED');
  return matchSourceEndpoint(url, approval, await response.json());
}

export async function inspectApprovedSource(sql, approval, { directory = './drizzle' } = {}) {
  return sql.begin(isolation, async tx => {
    const [connection] = await tx`SELECT current_database() AS database, current_user AS role,
      current_setting('transaction_read_only') AS read_only, pg_is_in_recovery() AS replica,
      pg_database_size(current_database())::text AS bytes`;
    check(connection.database === approval.database && connection.read_only === 'on' && connection.replica === false,
      'SOURCE_CONNECTION_NOT_APPROVED');
    const ledger = await tx`SELECT id, hash, created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY id`;
    check(cutoverBaselineMatches(expectedCutoverBaseline(directory), ledger), 'SOURCE_BASELINE_DIFFERS');
    return { connection, server: await inspectServer(tx),
      ledger: ledger.map(({ hash, created_at }) => ({ hash, created_at })) };
  });
}

export async function prepareSource({ url, approval, key, destination, request, token }) {
  const started = performance.now();
  const location = await verifySourceEndpoint(url, approval, { request, token });
  const sql = connect(url);
  let observation;
  try { observation = await inspectApprovedSource(sql, approval); }
  finally { await sql.end().catch(() => {}); }
  // A provider move during the DB probe must not certify the old observation.
  await verifySourceEndpoint(url, approval, { request, token });
  const preflight = { formatVersion: 1, approved: approval, observedAt: new Date().toISOString(),
    identity: location.identity, ...observation, ledgerDigest: digest(observation.ledger),
    durationMs: Math.round(performance.now() - started) };
  await writeJson(destination, { sourceUrl: url, preflight }, key);
  return preflight;
}

async function main() {
  const args = process.argv.slice(2);
  check(args.length === 4 && args[0] === '--key-file' && args[2] === '--output' &&
    args[1].startsWith('/') && args[3].startsWith('/'), 'SOURCE_PREFLIGHT_ARGUMENTS_REQUIRED');
  const key = await loadKey(args[1]);
  await prepareSource({ url: process.env.MOMO_REHEARSAL_SOURCE_URL, approval: sourceApproval(),
    key, destination: args[3] });
  console.log('Approved source preflight passed; encrypted configuration written.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(); }
  catch (error) {
    console.error(error instanceof RehearsalError ? error.code : 'SOURCE_PREFLIGHT_FAILED_PRIVATE_DETAILS_WITHHELD');
    process.exitCode = 1;
  }
}
