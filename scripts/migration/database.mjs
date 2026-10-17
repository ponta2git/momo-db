import { createHash } from 'node:crypto';
import { inventoryClient } from './sql-client.mjs';
import { expectedMigrationHistory } from '../check-migration-history.mjs';
import { digest, requireCondition } from './files.mjs';

export function databaseLocation(value, { local = false } = {}) {
  let url;
  try { url = new URL(value); } catch { requireCondition(false, 'INVALID_DATABASE_URL'); }
  requireCondition(['postgres:', 'postgresql:'].includes(url.protocol) && !!url.hostname &&
    !!url.pathname.slice(1) && !url.hostname.includes('-pooler.'), 'DIRECT_POSTGRES_URL_REQUIRED');
  if (local) requireCondition(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'LOOPBACK_DATABASE_REQUIRED');
  const allowedParameters = new Set(['sslmode', 'channel_binding']);
  const seen = new Set();
  for (const [name] of url.searchParams) {
    requireCondition(allowedParameters.has(name) && !seen.has(name), 'UNSUPPORTED_DATABASE_URL_PARAMETER');
    seen.add(name);
  }
  const configuration = {
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGSSLMODE: url.searchParams.get('sslmode') ?? (local ? 'disable' : 'require'),
  };
  requireCondition(['disable', 'require', 'verify-ca', 'verify-full'].includes(configuration.PGSSLMODE), 'INVALID_SSL_MODE');
  if (url.searchParams.has('channel_binding')) {
    configuration.PGCHANNELBINDING = url.searchParams.get('channel_binding');
    requireCondition(['disable', 'prefer', 'require'].includes(configuration.PGCHANNELBINDING), 'INVALID_CHANNEL_BINDING');
  }
  requireCondition(Object.values(configuration).every(item => !/[\r\n\0]/.test(item)), 'INVALID_DATABASE_URL');
  return {
    configuration,
    identity: digest({ host: configuration.PGHOST, port: configuration.PGPORT, database: configuration.PGDATABASE }),
  };
}

export function connect(value, { readOnly = true } = {}) {
  const { configuration: config } = databaseLocation(value, { local: ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(value).hostname) });
  return inventoryClient(config, { readOnly });
}

const identifier = (sql, name) => sql.unsafe('"' + name.replaceAll('"', '""') + '"');

export function historyState(expected, actual) {
  const prefix = actual.length <= expected.length && actual.every((entry, index) =>
    entry.hash === expected[index].hash && String(entry.created_at) === expected[index].created_at);
  if (!prefix) return 'unknown';
  return actual.length === expected.length ? 'target' : 'prefix';
}

export async function inspectConnection(sql, repository) {
  const [server] = await sql`SELECT current_setting('server_version_num') AS version,
    current_setting('TimeZone') AS timezone, current_database() AS database,
    pg_encoding_to_char(encoding) AS encoding, datcollate AS collation, datctype AS ctype
    FROM pg_database WHERE datname = current_database()`;
  const ledger = (await sql`SELECT hash, created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY id`)
    .map(row => ({ hash: row.hash, created_at: row.created_at }));
  const expected = expectedMigrationHistory(`${repository}/drizzle`);
  requireCondition(historyState(expected, ledger) !== 'unknown', 'UNKNOWN_MIGRATION_HISTORY');
  return { server, ledger, ledgerDigest: digest(ledger), pending: expected.slice(ledger.length) };
}

export async function fingerprint(sql, { sequences = true } = {}) {
  const [access] = await sql`SELECT count(*)::text AS inaccessible FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r','p','m') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_'
      AND (row_security_active(c.oid) OR NOT has_table_privilege(c.oid, 'SELECT'))`;
  requireCondition(access.inaccessible === '0', 'UNFILTERED_SELECT_REQUIRED');
  const tables = await sql`SELECT n.nspname AS schema, c.relname AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r','p','m') AND n.nspname NOT IN ('pg_catalog','information_schema')
      AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp_%'
      AND NOT c.relispartition
    ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C"`;
  const values = [];
  for (const table of tables) {
    const hash = createHash('sha256');
    let count = 0n;
    // PostgreSQL renders numeric/bytea/JSON values without a JS number conversion.
    // C ordering makes the row stream independent of local collation and PK type.
    for await (const rows of sql`SELECT to_jsonb(record)::text AS value
      FROM ${identifier(sql, table.schema)}.${identifier(sql, table.name)} record ORDER BY to_jsonb(record)::text COLLATE "C"`.cursor(256)) {
      for (const row of rows) {
        const bytes = Buffer.from(row.value);
        hash.update(String(bytes.length)).update(':').update(bytes).update('\n');
        count++;
      }
    }
    values.push({ schema: table.schema, name: table.name, rows: count.toString(), digest: hash.digest('hex') });
  }
  const sequenceValues = [];
  if (sequences) {
    const names = await sql`SELECT n.nspname AS schema, c.relname AS name
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'S' AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_'
      ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C"`;
    for (const sequence of names) {
      const [state] = await sql`SELECT last_value::text AS last_value, is_called FROM ${identifier(sql, sequence.schema)}.${identifier(sql, sequence.name)}`;
      sequenceValues.push({ ...sequence, ...state });
    }
  }
  return { tables: values, sequences: sequenceValues, digest: digest({ tables: values, sequences: sequenceValues }) };
}

export function compareFingerprints(before, after, { sequences = true } = {}) {
  requireCondition(digest(before.tables) === digest(after.tables), 'SAVED_ROWS_DIFFER');
  if (sequences) requireCondition(digest(before.sequences) === digest(after.sequences), 'SEQUENCES_DIFFER');
}
