import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { docker, username } from './migration-fixtures.mjs';
import { createTestClient } from './notification-fixtures.mjs';
import { connect } from '../scripts/migration/database.mjs';
import { inspectFinalSource } from '../scripts/migration/cutover-apply.mjs';

test('a connection belonging to another role cannot disappear from the drain guard when statistics are hidden', async () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const database = `momo_db_test_cutover_${suffix}`;
  const observer = `cutover_observer_${suffix}`, peer = `cutover_peer_${suffix}`;
  const password = randomBytes(24).toString('hex');
  docker(['createdb', '-U', username, database]);
  let admin = createTestClient(database), other, reader;
  const roleUrl = role => {
    const url = new URL(`postgresql://127.0.0.1:${process.env.MOMO_DB_TEST_PORT ?? 5432}/${database}`);
    url.username = role; url.password = password;
    return url.toString();
  };
  try {
    for (const role of [observer, peer]) {
      // These identifiers/password contain only generated ASCII hex/underscores;
      // CREATE ROLE does not accept a protocol bind parameter for PASSWORD.
      await admin.unsafe(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
    }
    await admin.end(); admin = undefined;
    other = postgres(roleUrl(peer), { max: 1, prepare: false, onnotice() {} });
    await other`SELECT 1`;
    reader = connect(roleUrl(observer));
    const [visibility] = await reader`SELECT count(*)::int AS sessions,
      bool_and(backend_type IS NULL) AS hidden FROM pg_stat_activity WHERE usename=${peer}`;
    assert.equal(visibility.sessions, 1);
    assert.equal(visibility.hidden, true);
    // The empty fixture has no migration table: rejection must happen at drain,
    // before any schema/ledger work, rather than incidentally during inspection.
    await assert.rejects(inspectFinalSource(reader, roleUrl(observer), process.cwd()),
      { code: 'DATABASE_CLIENTS_NOT_DRAINED' });
  } finally {
    if (reader) await reader.end();
    if (other) await other.end();
    admin ??= createTestClient(database);
    for (const role of [observer, peer]) await admin.unsafe(`DROP ROLE IF EXISTS "${role}"`);
    await admin.end();
    docker(['dropdb', '-U', username, database]);
  }
});
