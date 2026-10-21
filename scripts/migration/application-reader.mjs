import pg from 'pg';
import { digest, requireCondition as check } from './files.mjs';
import { assertOwned, localUrl, withLocalConnection } from './local.mjs';
import { connect, fingerprint, compareFingerprints } from './database.mjs';

const same = (a, b) => digest(a) === digest(b);
const key = row => `${row.schema}.${row.name}`;
const settings = ['default_transaction_read_only=on', 'search_path=public'];

/** A narrow contract for the observed analysis reader, not an arbitrary ACL copier. */
export function applicationReaderPlan(source, audit, roleName) {
  check(audit?.snapshotSchemaDigest === digest(source.schema) &&
    audit.snapshotLedgerDigest === source.connection.ledgerDigest, 'READER_AUDIT_SCOPE_CHANGED');
  const access = audit.roles?.find(item => item.role.name === roleName);
  const role = access?.role;
  check(role && !role.superuser && !role.create_role && !role.create_database &&
    !role.replication && !role.bypass_rls && role.login && role.inherits &&
    same([...(role.settings ?? [])].sort(), [...settings].sort()), 'UNREVIEWED_READER_ROLE');
  check(access.memberships.length === 1 && access.memberships[0].inherited &&
    access.memberships[0].can_set, 'UNREVIEWED_READER_MEMBERSHIP');
  check(!access.database.owned && same(access.database.privileges,
    { CREATE: false, CONNECT: true, TEMPORARY: true }), 'UNREVIEWED_READER_DATABASE_ACCESS');
  check(access.schemas.length === 2 && access.schemas.every(item =>
    !item.owned && !item.create && item.usage === (item.name === 'public') &&
    ['public', 'drizzle'].includes(item.name)), 'UNREVIEWED_READER_SCHEMA_ACCESS');
  check(same(access.tables.map(key).sort(), source.schema.tables.map(key).sort()) &&
    access.tables.every(item => !item.owned && Object.entries(item.privileges).every(([name, value]) =>
      value === (name === 'SELECT' && item.schema === 'public'))), 'UNREVIEWED_READER_TABLE_ACCESS');
  check(access.columns.length === source.schema.tables.reduce((n, table) => n + table.columns.length, 0) &&
    access.columns.every(item => Object.entries(item.privileges).every(([name, value]) =>
      value === (name === 'SELECT' && item.schema === 'public'))), 'UNREVIEWED_READER_COLUMN_ACCESS');
  check(access.sequences.every(item => !item.owned && Object.values(item.privileges).every(value => !value)) &&
    access.functions.every(item => !item.owned && item.execute && !item.security_definer && item.kind === 'f'),
  'UNREVIEWED_READER_SEQUENCE_OR_FUNCTION_ACCESS');
  const defaults = audit.defaultPrivileges?.filter(item => item.owner === audit.sourceRole &&
    item.grantee === access.memberships[0].name);
  check(defaults?.length === 2 && defaults.every(item => item.schema === 'public' &&
    ['r', 'S'].includes(item.type) && item.privilege === 'SELECT' && !item.is_grantable) &&
    new Set(defaults.map(item => item.type)).size === 2, 'READER_DEFAULT_PRIVILEGES_REQUIRED');
  check(source.schema.tables.every(item => item.kind === 'r' && !item.rowSecurityEnabled &&
    !item.rowSecurityForced) && source.schema.functions.every(item => !item.securityDefiner),
  'UNREVIEWED_READER_SCHEMA');
  return { formatVersion: 1, scope: 'analysis-reader-effective-database-privileges',
    sourceAuditDigest: digest(audit), sourceRole: roleName,
    sourceSequences: access.sequences.map(key).sort(), settings,
    publicTableSelect: true, newOwnerTableSelect: true };
}

/**
 * Copy-only mapping after the owner mapping. Group membership is collapsed into
 * effective SELECT grants; this does not emulate SET ROLE or provider privileges.
 * New sequences require review rather than guessing whether they were renamed.
 */
export async function mapApplicationReader(manifest, database, plan, ownerProof,
  { beforeMutation = async () => {} } = {}) {
  check(plan?.formatVersion === 1 && plan.scope === 'analysis-reader-effective-database-privileges' &&
    /^[a-f0-9]{64}$/.test(plan.sourceAuditDigest) && plan.publicTableSelect === true &&
    plan.newOwnerTableSelect === true && same(plan.settings, settings), 'VALIDATED_READER_PLAN_REQUIRED');
  check(ownerProof?.runId === manifest.runId && ownerProof.database === database &&
    ownerProof.applicationDataUnchanged === true && ownerProof.access?.superuser === false &&
    ['momo_rehearsal_smoke', 'momo_rehearsal_recovery'].includes(database),
  'VERIFIED_OWNER_COPY_REQUIRED');
  await assertOwned(manifest);
  return withLocalConnection(manifest, async () => {
    const name = `momo_rehearsal_reader_${manifest.runId.replaceAll('-', '').slice(0, 12)}`;
    const admin = connect(localUrl(manifest, database), { readOnly: false });
    let before;
    try {
      before = await admin.begin('isolation level repeatable read read only', fingerprint);
      const sequences = await admin`SELECT n.nspname AS schema,c.relname AS name FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','drizzle') AND c.relkind='S'`;
      check(sequences.every(item => plan.sourceSequences.includes(key(item))), 'NEW_READER_SEQUENCE_REQUIRES_REVIEW');
      const [unsupported] = await admin`SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname IN ('public','drizzle') AND (c.relrowsecurity OR c.relforcerowsecurity OR c.relkind IN ('v','m','f','p'))) OR
        EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname IN ('public','drizzle') AND p.prosecdef) AS found`;
      check(!unsupported.found, 'UNREVIEWED_READER_COPY_SCHEMA');
      check((await admin`SELECT 1 FROM pg_roles WHERE rolname=${name}`).length === 0,
        'READER_MAPPING_ALREADY_EXISTS_INSPECT_FIRST');
      await beforeMutation();
      await admin.unsafe('BEGIN');
      try {
        await admin.unsafe(`CREATE ROLE "${name}" LOGIN NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS`);
        await admin.unsafe(`ALTER ROLE "${name}" SET default_transaction_read_only=on`);
        await admin.unsafe(`ALTER ROLE "${name}" SET search_path=public`);
        await admin.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${name}"`);
        await admin.unsafe('COMMIT');
      } catch (error) { await admin.unsafe('ROLLBACK').catch(() => {}); throw error; }

      const url = new URL(localUrl(manifest, database)); url.username = name;
      // Do not use the inventory client's PGOPTIONS: they override role defaults.
      const reader = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 15000 });
      try {
        await reader.connect();
        const { rows: [identity] } = await reader.query(`SELECT current_user=session_user AS direct_login,
          current_setting('default_transaction_read_only')='on' AS read_only,
          current_setting('search_path')='public' AS search_path,
          (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`);
        check(identity.direct_login && identity.read_only && identity.search_path && !identity.superuser,
          'READER_LOGIN_DEFAULTS_DIFFER');
        const { rows: tables } = await reader.query(`SELECT n.nspname AS schema,c.relname AS name,
          p AS privilege,has_table_privilege(c.oid,p) AS allowed FROM pg_class c
          JOIN pg_namespace n ON n.oid=c.relnamespace
          CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p
          WHERE n.nspname IN ('public','drizzle') AND c.relkind='r'`);
        check(tables.length > 0 && tables.every(item => item.allowed ===
          (item.schema === 'public' && item.privilege === 'SELECT')), 'READER_EFFECTIVE_TABLE_GRANTS_DIFFER');
        for (const table of tables.filter(item => item.privilege === 'SELECT' && item.allowed)) {
          await reader.query(`SELECT * FROM ${pg.escapeIdentifier(table.schema)}.${pg.escapeIdentifier(table.name)} LIMIT 0`);
        }
        await reader.query('LISTEN processing_jobs; LISTEN ocr_submissions');
        const { rows: subscriptions } = await reader.query('SELECT pg_listening_channels() AS channel');
        check(same(subscriptions.map(item => item.channel).sort(), ['ocr_submissions', 'processing_jobs']),
          'READER_LISTEN_SUBSCRIPTIONS_DIFFER');
        await reader.query('UNLISTEN *');
        const checks = [
          ["SELECT 1 FROM drizzle.__drizzle_migrations LIMIT 0", '42501'],
          ["UPDATE public.members SET id=id WHERE false", '25006'],
        ];
        for (const [statement, expected] of checks) {
          let code;
          try { await reader.query(statement); } catch (error) { code = error.code; }
          check(code === expected, 'READER_DENIED_OPERATION_DID_NOT_FAIL');
        }
      } finally { await reader.end(); }
      compareFingerprints(before, await admin.begin('isolation level repeatable read read only', fingerprint));
      return { formatVersion: 1, runId: manifest.runId, database, localRole: name,
        sourceAuditDigest: plan.sourceAuditDigest, planDigest: digest(plan),
        applicationDataUnchanged: true, defaultReadOnly: true, publicReads: true,
        writeDenied: true, ledgerDenied: true, listenSubscriptions: ['processing_jobs', 'ocr_submissions'],
        scope: plan.scope, mappedAt: new Date().toISOString() };
    } finally { await admin.end(); }
  });
}
