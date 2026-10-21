import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationReaderPlan, readerSequenceGrants } from '../scripts/migration/application-reader.mjs';
import { digest } from '../scripts/migration/files.mjs';

const table = (schema, name) => ({ schema, name, kind: 'r', columns: [{ name: 'id' }],
  rowSecurityEnabled: false, rowSecurityForced: false });
const source = { schema: { tables: [table('public', 'members'), table('drizzle', '__drizzle_migrations')],
  functions: [] }, connection: { ledgerDigest: 'a'.repeat(64) } };
const grants = (names, read) => Object.fromEntries(names.map(name => [name, name === 'SELECT' && read]));
const audit = {
  snapshotSchemaDigest: digest(source.schema), snapshotLedgerDigest: source.connection.ledgerDigest,
  sourceRole: 'owner', roles: [{
    role: { name: 'reader', superuser: false, create_role: false, create_database: false,
      replication: false, bypass_rls: false, login: true, inherits: true,
      settings: ['default_transaction_read_only=on', 'search_path=public'] },
    memberships: [{ name: 'read_group', inherited: true, can_set: true }],
    database: { owned: false, privileges: { CREATE: false, CONNECT: true, TEMPORARY: true } },
    schemas: ['drizzle', 'public'].map(name => ({ name, owned: false, create: false, usage: name === 'public' })),
    tables: source.schema.tables.map(row => ({ ...row, owned: false, privileges:
      grants(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'], row.schema === 'public') })),
    columns: source.schema.tables.map(row => ({ schema: row.schema, table: row.name, name: 'id',
      privileges: grants(['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'], row.schema === 'public') })),
    sequences: [], functions: [],
  }],
  defaultPrivileges: ['r', 'S'].map(type => ({ owner: 'owner', schema: 'public', type,
    privilege: 'SELECT', is_grantable: false, grantee: 'read_group' })),
};

test('observed reader plan preserves read-only defaults and reviewed future table grants', () => {
  const plan = applicationReaderPlan(source, audit, 'reader');
  assert.equal(plan.scope, 'analysis-reader-effective-database-privileges');
  assert.deepEqual(plan.settings, ['default_transaction_read_only=on', 'search_path=public']);
  assert.equal(plan.newOwnerTableSelect, true);
  assert.equal(plan.newOwnerSequenceSelect, true);
});

test('only verified public-ID identities inherit the audited new-sequence SELECT grant', () => {
  const plan = applicationReaderPlan(source, audit, 'reader');
  const manifest = { profile: 'canonical-identities-retired-slots-v1',
    checks: { migrationSchema: true, migratorFirstRun: true } };
  const sequences = ['held_events', 'matches'].map(table => ({ schema: 'public',
    name: `${table}_public_id_seq`, table_schema: 'public', table_name: table,
    column_name: 'public_id', identity: 'a' }));
  assert.deepEqual(readerSequenceGrants(manifest, 'momo_rehearsal_smoke', plan, sequences),
    ['public.held_events_public_id_seq', 'public.matches_public_id_seq']);
  assert.throws(() => readerSequenceGrants(manifest, 'momo_rehearsal_recovery', plan, sequences));
  assert.throws(() => readerSequenceGrants({ ...manifest, checks: {} }, 'momo_rehearsal_smoke', plan, sequences));
  for (const mutate of [rows => rows.pop(), rows => { rows[0].identity = ''; },
    rows => { rows[0].column_name = 'other'; }, rows => rows.push({ schema: 'public', name: 'unknown' })]) {
    const changed = structuredClone(sequences); mutate(changed);
    assert.throws(() => readerSequenceGrants(manifest, 'momo_rehearsal_smoke', plan, changed));
  }
});

test('elevated, partial, or changed reader contracts are not mapped as read-only', () => {
  for (const mutate of [
    value => { value.roles[0].role.superuser = true; },
    value => { value.roles[0].role.settings = []; },
    value => { value.roles[0].memberships[0].inherited = false; },
    value => { value.roles[0].tables[0].privileges.UPDATE = true; },
    value => { value.roles[0].tables[0].privileges.SELECT = false; },
    value => { value.roles[0].columns[0].privileges.SELECT = false; },
    value => { value.roles[0].schemas[0].usage = true; },
    value => { value.defaultPrivileges = []; },
    value => { value.defaultPrivileges[0].privilege = 'INSERT'; },
    value => { value.snapshotLedgerDigest = 'b'.repeat(64); },
  ]) {
    const changed = structuredClone(audit); mutate(changed);
    assert.throws(() => applicationReaderPlan(source, changed, 'reader'));
  }
});
