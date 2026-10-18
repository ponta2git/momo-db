import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { digest } from '../scripts/migration/files.mjs';
import { command } from '../scripts/migration/process.mjs';
import { connect } from '../scripts/migration/database.mjs';
import { inspectSchema } from '../scripts/migration/inventory.mjs';
import { cleanupLocal, createDatabase, localUrl, startLocal, withLocalConnection } from '../scripts/migration/local.mjs';
import { applicationOwnerPlan, captureApplicationRoleAudit, mapApplicationOwner } from '../scripts/migration/application-role.mjs';
import { parseArguments } from '../scripts/migration/run.mjs';

const privileges = names => Object.fromEntries(names.map(name => [name, true]));
function fixture() {
  const name = 'source_application_owner';
  const source = { connection: { ledgerDigest: digest('full-ledger') }, schema: {
    schemas: [{ name: 'public', owner: 'pg_database_owner' }, { name: 'drizzle', owner: name }], types: [],
    tables: [{ schema: 'public', name: 'records', kind: 'r', owner: name, rowSecurityEnabled: false, rowSecurityForced: false,
      policies: [], columns: [{ name: 'id' }, { name: 'value' }] }],
    sequences: [{ schema: 'public', name: 'records_id_seq' }],
    functions: [{ schema: 'public', name: 'record_guard', arguments: '', owner: name, securityDefiner: false, kind: 'f' }],
  } };
  const audit = { formatVersion: 1, observedAt: '2026-10-18T00:00:00Z', sourceRole: name, snapshotSchemaDigest: digest(source.schema),
    snapshotLedgerDigest: source.connection.ledgerDigest,
    consumers: ['api', 'worker', 'summit'].map(consumer => ({ consumer, role: name, machine: { bootId: `verified-${consumer}` } })),
    roles: [{ role: { name, superuser: false, inherits: true, create_role: false, create_database: false, login: true,
      replication: false, bypass_rls: false, settings: null }, memberships: [],
    database: { owned: true, privileges: privileges(['CONNECT', 'CREATE', 'TEMPORARY']) },
    schemas: ['public', 'drizzle'].map(name => ({ name, owned: name === 'drizzle', usage: true, create: true })),
    tables: [{ schema: 'public', name: 'records', owned: true,
      privileges: privileges(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) }],
    columns: ['id', 'value'].map(name => ({ schema: 'public', table: 'records', name, privileges: privileges(['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) })),
    sequences: [{ schema: 'public', name: 'records_id_seq', owned: true, privileges: privileges(['SELECT', 'USAGE', 'UPDATE']) }],
    functions: [{ schema: 'public', name: 'record_guard', arguments: '', owned: true, execute: true, security_definer: false }],
    }],
  };
  return { source, audit };
}

test('source role mapping binds the complete observed owner contract and rejects weaker or unknown evidence', () => {
  const f = fixture(); const plan = applicationOwnerPlan(f.source, f.audit);
  assert.equal(plan.sourceAuditDigest, digest(f.audit)); assert.equal(plan.roleFlags.superuser, false);
  assert.deepEqual(plan.consumers, ['api', 'worker', 'summit', 'migration']);
  for (const mutate of [
    f => { f.audit.snapshotSchemaDigest = digest('other'); },
    f => { f.audit.consumers.pop(); },
    f => { f.audit.consumers[0].role = 'other'; },
    f => { f.audit.roles[0].role.superuser = true; },
    f => { f.audit.roles[0].role.settings = ['role=other']; },
    f => { f.audit.roles[0].tables[0].privileges.MAINTAIN = false; },
    f => { f.audit.roles[0].columns.pop(); },
    f => { f.audit.roles[0].sequences[0].owned = false; },
    f => { f.audit.roles[0].database.owned = false; },
    f => { f.source.schema.schemas.pop(); f.audit.snapshotSchemaDigest = digest(f.source.schema); },
    f => { f.source.schema.schemas[0].owner = 'other'; f.audit.snapshotSchemaDigest = digest(f.source.schema); },
    f => { f.source.schema.tables[0].rowSecurityEnabled = true; f.audit.snapshotSchemaDigest = digest(f.source.schema); },
    f => { f.source.schema.functions[0].securityDefiner = true; f.audit.snapshotSchemaDigest = digest(f.source.schema); },
  ]) {
    const changed = fixture(); mutate(changed);
    assert.throws(() => applicationOwnerPlan(changed.source, changed.audit));
  }
});

test('application mapping commands require an explicit private audit and only a smoke or recovery copy', () => {
  const args = ['application-role', '--key-file', '/private/key', '--manifest', '/private/manifest', '--role-audit', '/private/audit'];
  assert.equal(parseArguments([...args, '--copy', 'smoke']).options.copy, 'smoke');
  assert.equal(parseArguments([...args, '--copy', 'recovery']).options.copy, 'recovery');
  assert.throws(() => parseArguments([...args, '--copy', 'baseline']), { code: 'APPLICATION_ROLE_INPUT_REQUIRED' });
  assert.throws(() => parseArguments(args), { code: 'APPLICATION_ROLE_INPUT_REQUIRED' });
  assert.throws(() => parseArguments(['verify', ...args.slice(1), '--copy', 'smoke']), { code: 'INVALID_ARGUMENTS' });
});

test('only owned smoke/recovery copies receive the non-superuser mapping, preserving rows and sequence state', async () => {
  const container = process.env.MOMO_DB_TEST_CONTAINER;
  assert.match(container ?? '', /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
  const image = await command('docker', ['inspect', '--format', '{{.Image}}', container]);
  const manifest = { runId: randomUUID(), postgres: { id: image }, local: null };
  const f = fixture(); const plan = applicationOwnerPlan(f.source, f.audit);
  const server = { encoding: 'UTF8', collation: 'C', ctype: 'C', localeProvider: 'b', locale: 'C.UTF-8', icuRules: null,
    collationVersion: '1', actualCollationVersion: '1' };
  try {
    await assert.rejects(mapApplicationOwner(manifest, 'momo_rehearsal_baseline', plan), { code: 'APPLICATION_ROLE_COPY_REQUIRED' });
    await assert.rejects(mapApplicationOwner(manifest, 'momo_rehearsal_migration', plan), { code: 'APPLICATION_ROLE_COPY_REQUIRED' });
    await startLocal(manifest, async () => {}, { server });
    await withLocalConnection(manifest, async () => {
      await createDatabase(manifest, 'momo_rehearsal_smoke');
      const admin = connect(localUrl(manifest, 'momo_rehearsal_smoke'), { readOnly: false });
      try {
        await admin.unsafe(`CREATE SCHEMA drizzle;
          CREATE TABLE drizzle.__drizzle_migrations(id serial PRIMARY KEY,hash text NOT NULL,created_at bigint NOT NULL);
          INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES ('fixture',1);
          CREATE TABLE public.records(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,value jsonb NOT NULL);
          INSERT INTO public.records(value) VALUES ('{"large":9007199254740993,"unicode":"桃"}');
          CREATE FUNCTION public.record_guard() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END';
          CREATE TRIGGER records_guard BEFORE INSERT OR UPDATE ON public.records FOR EACH ROW EXECUTE FUNCTION public.record_guard();`);
      } finally { await admin.end(); }
      const refusal = new Error('fixture-control-changed');
      await assert.rejects(mapApplicationOwner(manifest, 'momo_rehearsal_smoke', plan, { beforeMutation: async () => { throw refusal; } }),
        error => error === refusal);
      const proof = await mapApplicationOwner(manifest, 'momo_rehearsal_smoke', plan);
      assert.equal(proof.applicationDataUnchanged, true); assert.equal(proof.access.superuser, false);
      assert.equal(proof.sourceAuditDigest, plan.sourceAuditDigest);
      await assert.rejects(mapApplicationOwner(manifest, 'momo_rehearsal_smoke', plan, {
        expectedRows: { algorithm: 'sha256-row-multiset-v2', tables: [], sequences: [] },
      }), { code: 'SAVED_ROWS_DIFFER' });
      const second = await mapApplicationOwner(manifest, 'momo_rehearsal_smoke', plan);
      assert.equal(second.dataDigest, proof.dataDigest);
      const url = new URL(localUrl(manifest, 'momo_rehearsal_smoke')); url.username = proof.localRole;
      const application = connect(url.toString(), { readOnly: false });
      try {
        await assert.rejects(captureApplicationRoleAudit(application, {}, []), { code: 'READ_ONLY_ROLE_AUDIT_REQUIRED' });
        await application.begin('isolation level repeatable read read only', async tx => {
          const ledger = (await tx`SELECT hash,created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY id`)
            .map(({ hash, created_at }) => ({ hash, created_at }));
          const source = { schema: await inspectSchema(tx), connection: { ledger, ledgerDigest: digest(ledger) } };
          const consumers = f.audit.consumers.map(item => ({ ...item, role: proof.localRole }));
          const observed = await captureApplicationRoleAudit(tx, source, consumers);
          assert.equal(applicationOwnerPlan(source, observed).sourceAuditDigest, digest(observed));
          await assert.rejects(captureApplicationRoleAudit(tx, { ...source, schema: {} }, consumers),
            { code: 'SOURCE_SCHEMA_OR_PRIVILEGES_CHANGED' });
        });
        const rows = await application`INSERT INTO records(value) VALUES ('{"next":true}') RETURNING id::text`;
        assert.equal(rows[0].id, '2');
        await application`UPDATE records SET value='{"edited":true}' WHERE id=2`;
        const [saved] = await application`SELECT value FROM records WHERE id=2`;
        assert.deepEqual(saved.value, { edited: true });
        await assert.rejects(application`ALTER ROLE ${application(proof.localRole)} SUPERUSER`, error => error.code === '42501');
      } finally { await application.end(); }
      const changed = connect(localUrl(manifest, 'momo_rehearsal_smoke'), { readOnly: false });
      try { await changed`ALTER TABLE records ENABLE ROW LEVEL SECURITY`; }
      finally { await changed.end(); }
      await assert.rejects(mapApplicationOwner(manifest, 'momo_rehearsal_smoke', plan), { code: 'UNREVIEWED_LOCAL_ROLE_MAPPING_SCHEMA' });
    });
  } finally { if (manifest.local) await cleanupLocal(manifest, async () => {}); }
});
