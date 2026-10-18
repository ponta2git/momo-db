import pg from 'pg';
import Cursor from 'pg-cursor';
import { RehearsalError, requireCondition } from './files.mjs';

const fragment = Symbol('query-fragment');

// Only the tiny tagged-query surface used by the inventory is shared with its
// existing postgres.js fixture tests. pg supplies TLS, channel binding, types,
// wire protocol and cursors; values are always protocol parameters.
export function inventoryClient(configuration, { readOnly = true } = {}) {
  const requiredBinding = configuration.PGCHANNELBINDING === 'require';
  const tls = configuration.PGSSLMODE !== 'disable';
  requireCondition(!requiredBinding || tls, 'CHANNEL_BINDING_REQUIRES_TLS');
  const client = new pg.Client({
    host: configuration.PGHOST.replace(/^\[|\]$/g, ''), port: Number(configuration.PGPORT),
    database: configuration.PGDATABASE, user: configuration.PGUSER, password: configuration.PGPASSWORD,
    // Introspection always validates the remote server certificate, including
    // when a libpq URL asks only for encryption with sslmode=require.
    ssl: tls ? { rejectUnauthorized: true } : false,
    enableChannelBinding: configuration.PGCHANNELBINDING !== 'disable',
    types: { getTypeParser(oid, format) { return pg.types.getTypeParser(oid === 1003 ? 1009 : oid, format); } },
    connectionTimeoutMillis: 15000,
    application_name: 'momo-db-rehearsal',
    options: `-c default_transaction_read_only=${readOnly ? 'on' : 'off'} -c statement_timeout=300000 -c lock_timeout=10000 -c timezone=UTC -c search_path=pg_catalog,public -c row_security=off`,
  });
  let bindingOffered = false;
  let connectionFailure;
  client.on('error', () => { connectionFailure = new RehearsalError('DATABASE_CONNECTION_FAILED'); });
  // pg enables PLUS when offered but otherwise permits fallback. A required
  // libpq channel_binding contract must fail before that fallback is sent.
  client.connection.on('authenticationSASL', message => {
    bindingOffered = message.mechanisms.includes('SCRAM-SHA-256-PLUS');
    if (requiredBinding && !bindingOffered) {
      connectionFailure = new RehearsalError('REQUIRED_CHANNEL_BINDING_UNAVAILABLE');
      client.connection.stream.destroy(connectionFailure);
    }
  });
  for (const event of ['authenticationCleartextPassword', 'authenticationMD5Password']) {
    client.connection.on(event, () => {
      if (requiredBinding) {
        connectionFailure = new RehearsalError('REQUIRED_CHANNEL_BINDING_UNAVAILABLE');
        client.connection.stream.destroy(connectionFailure);
      }
    });
  }
  let connected;
  const ready = async () => {
    connected ??= client.connect().then(() => {
      requireCondition(!requiredBinding || bindingOffered, 'REQUIRED_CHANNEL_BINDING_UNAVAILABLE');
    });
    await connected;
    if (connectionFailure) throw connectionFailure;
  };
  const compile = query => {
    const values = [];
    const visit = parts => parts.map(part => {
      if (typeof part === 'string') return part;
      if (part?.[fragment]) return visit(part.parts);
      values.push(part.value);
      return `$${values.length}`;
    }).join('');
    return { text: visit(query.parts), values };
  };
  const query = parts => ({
    [fragment]: true, parts,
    then(resolve, reject) { return ready().then(async () => (await client.query(compile(this))).rows).then(resolve, reject); },
    catch(reject) { return this.then(undefined, reject); },
    async *cursor(batchSize) {
      await ready();
      const compiled = compile(this);
      const cursor = client.query(new Cursor(compiled.text, compiled.values));
      try {
        for (;;) {
          const rows = await cursor.read(batchSize);
          if (!rows.length) break;
          yield rows;
        }
      } finally { await cursor.close(); }
    },
  });
  const sql = (strings, ...values) => {
    if (typeof strings === 'string') return query([pg.escapeIdentifier(strings)]);
    const parts = [];
    for (let index = 0; index < strings.length; index++) {
      parts.push(strings[index]);
      if (index < values.length) parts.push(values[index]?.[fragment] ? values[index] : { value: values[index] });
    }
    return query(parts);
  };
  sql.unsafe = text => query([text]);
  sql.begin = async (options, operation) => {
    requireCondition(options === 'isolation level repeatable read read only', 'READ_ONLY_SNAPSHOT_REQUIRED');
    await sql.unsafe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try { const result = await operation(sql); await sql.unsafe('COMMIT'); return result; }
    catch (error) { await sql.unsafe('ROLLBACK').catch(() => {}); throw error; }
  };
  sql.end = async () => { await client.end(); };
  return sql;
}
