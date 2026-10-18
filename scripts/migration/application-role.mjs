import { digest, requireCondition } from './files.mjs';
import { connect, fingerprint, compareFingerprints } from './database.mjs';
import { inspectSchema } from './inventory.mjs';
import { assertOwned, localUrl, withLocalConnection } from './local.mjs';

const check = requireCondition;
const scopes = ['api', 'worker', 'summit'];
const tablePrivileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'];
const sequencePrivileges = ['SELECT', 'USAGE', 'UPDATE'];
const columnPrivileges = ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'];
const flags = { superuser: 'SUPERUSER', inherits: 'INHERIT', create_role: 'CREATEROLE', create_database: 'CREATEDB',
  login: 'LOGIN', replication: 'REPLICATION', bypass_rls: 'BYPASSRLS' };
const same = (left, right) => digest(left) === digest(right);
const complete = (value, names) => value && same(Object.keys(value).sort(), [...names].sort()) && names.every(name => value[name] === true);
const qualified = (sql, schema, name) => sql.unsafe('"' + schema.replaceAll('"', '""') + '"."' + name.replaceAll('"', '""') + '"');
const identifier = (sql, name) => sql.unsafe('"' + name.replaceAll('"', '""') + '"');

/**
 * The observed production contract is one non-superuser application owner.
 * Unknown roles, partial privileges, RLS, and SECURITY DEFINER require a new
 * reviewed mapping; they are never replaced by blanket local superuser access.
 */
export function applicationOwnerPlan(source, audit) {
  check(audit?.formatVersion === 1 && audit.snapshotSchemaDigest === digest(source?.schema) &&
    audit.snapshotLedgerDigest === source?.connection?.ledgerDigest && Number.isFinite(Date.parse(audit.observedAt)),
  'APPLICATION_ROLE_AUDIT_SCOPE_CHANGED');
  check(Array.isArray(audit.consumers) && scopes.every(scope => audit.consumers.some(item => item.consumer === scope)) &&
    audit.consumers.every(item => scopes.includes(item.consumer) && item.role === audit.sourceRole && item.machine?.bootId),
  'ALL_ACTUAL_CONSUMER_ROLES_REQUIRED');
  check(audit.roles?.length === 1, 'SINGLE_APPLICATION_OWNER_MAPPING_REQUIRED');
  const access = audit.roles[0]; const role = access.role;
  check(role?.name === audit.sourceRole && role.superuser === false && role.login === true && role.settings === null &&
    Object.keys(flags).every(name => typeof role[name] === 'boolean'), 'UNSUPPORTED_APPLICATION_ROLE_CONFIGURATION');
  check(same(source.schema.schemas.map(item => item.name).sort(), ['drizzle', 'public']) &&
    source.schema.schemas.every(item => item.owner === (item.name === 'public' ? 'pg_database_owner' : role.name)) &&
    source.schema.types.length === 0 &&
    source.schema.tables.every(table => table.kind === 'r' && table.owner === role.name && !table.rowSecurityEnabled &&
      !table.rowSecurityForced && table.policies.length === 0) &&
    source.schema.functions.every(fn => !fn.securityDefiner && fn.owner === role.name && fn.kind === 'f'),
  'REVIEWED_OWNER_SCHEMA_REQUIRED');
  const keys = values => values.map(item => `${item.schema}.${item.name}`).sort();
  check(same(keys(access.tables), keys(source.schema.tables)) &&
    access.tables.every(table => table.owned === true && complete(table.privileges, tablePrivileges)), 'SOURCE_TABLE_PRIVILEGES_INCOMPLETE');
  const expectedColumns = source.schema.tables.flatMap(table => table.columns.map(column => `${table.schema}.${table.name}.${column.name}`)).sort();
  check(same(access.columns.map(column => `${column.schema}.${column.table}.${column.name}`).sort(), expectedColumns) &&
    access.columns.every(column => complete(column.privileges, columnPrivileges)), 'SOURCE_COLUMN_PRIVILEGES_INCOMPLETE');
  check(same(keys(access.sequences), keys(source.schema.sequences)) &&
    access.sequences.every(sequence => sequence.owned === true && complete(sequence.privileges, sequencePrivileges)),
  'SOURCE_SEQUENCE_PRIVILEGES_INCOMPLETE');
  const functions = values => values.map(fn => `${fn.schema}.${fn.name}(${fn.arguments})`).sort();
  check(same(functions(access.functions), functions(source.schema.functions)) &&
    access.functions.every(fn => fn.owned === true && fn.execute === true && fn.security_definer === false),
  'SOURCE_FUNCTION_PRIVILEGES_INCOMPLETE');
  check(access.schemas?.length === 2 && access.schemas.every(schema => ['public', 'drizzle'].includes(schema.name) &&
    schema.usage === true && schema.create === true && schema.owned === (schema.name === 'drizzle')) &&
    access.database?.owned === true && complete(access.database.privileges, ['CONNECT', 'CREATE', 'TEMPORARY']),
  'SOURCE_SCHEMA_OR_DATABASE_PRIVILEGES_INCOMPLETE');
  return { formatVersion: 1, sourceAuditDigest: digest(audit), sourceSchemaDigest: digest(source.schema),
    sourceLedgerDigest: source.connection.ledgerDigest, roleFlags: Object.fromEntries(Object.keys(flags).map(name => [name, role[name]])),
    consumers: [...scopes, 'migration'], scope: 'application-database-effective-privileges',
    // Provider administration and cluster memberships are recorded, but this
    // local DB proof does not claim to emulate Neon management permissions.
    sourceMembershipsDigest: digest(access.memberships) };
}

/** Capture inside a read-only transaction, using separately verified process role observations. */
export async function captureApplicationRoleAudit(tx, source, consumers) {
  const [connection] = await tx`SELECT current_user AS role, current_setting('transaction_read_only') AS read_only`;
  check(connection.read_only === 'on', 'READ_ONLY_ROLE_AUDIT_REQUIRED');
  const sourceRole = connection.role;
  const schema = await inspectSchema(tx);
  check(digest(schema) === digest(source.schema), 'SOURCE_SCHEMA_OR_PRIVILEGES_CHANGED');
  const ledger = await tx`SELECT id, hash, created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY id`;
  check(digest(ledger.map(({hash,created_at})=>({hash,created_at}))) === digest(source.connection.ledger.map(({hash,created_at})=>({hash,created_at}))),
    'SOURCE_LEDGER_CHANGED');
  const names = [...new Set([...consumers.map(item => item.role), sourceRole])].sort();
  const roles = [];
  for (const name of names) {
    const rows = await tx`SELECT rolname AS name, rolsuper AS superuser, rolinherit AS inherits, rolcreaterole AS create_role,
      rolcreatedb AS create_database, rolcanlogin AS login, rolreplication AS replication, rolbypassrls AS bypass_rls, rolconfig AS settings
      FROM pg_roles WHERE rolname=${name}`;
    check(rows.length === 1 && rows[0].login, 'SOURCE_ROLE_MISSING');
    const memberships = await tx`SELECT r.rolname AS name, pg_has_role(${name},r.oid,'USAGE') AS inherited,
      pg_has_role(${name},r.oid,'SET') AS can_set FROM pg_roles r WHERE r.rolname<>${name} AND pg_has_role(${name},r.oid,'MEMBER') ORDER BY r.rolname`;
    const schemas = await tx`SELECT n.nspname AS name, pg_get_userbyid(n.nspowner)=${name} AS owned,
      has_schema_privilege(${name},n.oid,'USAGE') AS usage, has_schema_privilege(${name},n.oid,'CREATE') AS create
      FROM pg_namespace n WHERE n.nspname IN ('public','drizzle') ORDER BY n.nspname`;
    const tables = await tx`SELECT n.nspname AS schema,c.relname AS name,pg_get_userbyid(c.relowner)=${name} AS owned,
      jsonb_object_agg(p,has_table_privilege(${name},c.oid,p) ORDER BY p) AS privileges
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p
      WHERE n.nspname IN ('public','drizzle') AND c.relkind IN ('r','p','v','m','f') GROUP BY n.nspname,c.relname,c.oid ORDER BY n.nspname,c.relname`;
    const columns = await tx`SELECT n.nspname AS schema,c.relname AS table,a.attname AS name,
      jsonb_object_agg(p,has_column_privilege(${name},c.oid,a.attnum,p) ORDER BY p) AS privileges
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) p
      WHERE n.nspname IN ('public','drizzle') AND c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped
      GROUP BY n.nspname,c.relname,a.attname,c.oid,a.attnum ORDER BY n.nspname,c.relname,a.attname`;
    const sequences = await tx`SELECT n.nspname AS schema,c.relname AS name,pg_get_userbyid(c.relowner)=${name} AS owned,
      jsonb_object_agg(p,has_sequence_privilege(${name},c.oid,p) ORDER BY p) AS privileges
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN unnest(ARRAY['SELECT','USAGE','UPDATE']) p
      WHERE n.nspname IN ('public','drizzle') AND c.relkind='S' GROUP BY n.nspname,c.relname,c.oid ORDER BY n.nspname,c.relname`;
    const functions = await tx`SELECT n.nspname AS schema,p.proname AS name,pg_get_function_identity_arguments(p.oid) AS arguments,
      p.prokind::text AS kind,pg_get_userbyid(p.proowner)=${name} AS owned,p.prosecdef AS security_definer,
      has_function_privilege(${name},p.oid,'EXECUTE') AS execute FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname IN ('public','drizzle') ORDER BY n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)`;
    const [database] = await tx`SELECT pg_get_userbyid(d.datdba)=${name} AS owned,
      jsonb_object_agg(p,has_database_privilege(${name},d.oid,p) ORDER BY p) AS privileges
      FROM pg_database d CROSS JOIN unnest(ARRAY['CONNECT','CREATE','TEMPORARY']) p
      WHERE d.datname=current_database() GROUP BY d.oid`;
    roles.push({ role:rows[0], memberships, database, schemas, tables, columns, sequences, functions });
  }
  return { formatVersion:1, observedAt:new Date().toISOString(), snapshotSchemaDigest:digest(source.schema),
    snapshotLedgerDigest:source.connection.ledgerDigest, consumers, sourceRole, roles };
}

async function roleFlags(sql, name) {
  const rows = await sql`SELECT rolsuper AS superuser, rolinherit AS inherits, rolcreaterole AS create_role,
    rolcreatedb AS create_database, rolcanlogin AS login, rolreplication AS replication, rolbypassrls AS bypass_rls,
    rolconfig AS settings, EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) AS membership
    FROM pg_roles r WHERE rolname=${name}`;
  return rows;
}

export async function mapApplicationOwner(manifest, database, plan, { beforeMutation = async () => {}, expectedRows } = {}) {
  check(['momo_rehearsal_smoke', 'momo_rehearsal_recovery'].includes(database), 'APPLICATION_ROLE_COPY_REQUIRED');
  check(plan?.formatVersion === 1 && plan.scope === 'application-database-effective-privileges' &&
    /^[a-f0-9]{64}$/.test(plan.sourceAuditDigest) && plan.roleFlags?.superuser === false && plan.roleFlags?.login === true &&
    Object.keys(flags).every(name => typeof plan.roleFlags[name] === 'boolean'), 'VALIDATED_APPLICATION_ROLE_PLAN_REQUIRED');
  await assertOwned(manifest);
  return withLocalConnection(manifest, async () => {
    const name = `momo_rehearsal_app_${manifest.runId.replaceAll('-', '').slice(0, 12)}`;
    const administrative = connect(localUrl(manifest, database), { readOnly: false });
    let before;
    try {
      before = await administrative.begin('isolation level repeatable read read only', fingerprint);
      if (expectedRows) compareFingerprints(expectedRows, before);
      await beforeMutation();
      await administrative.unsafe('BEGIN');
      try {
        const sql = administrative;
        const existing = await roleFlags(sql, name);
        if (existing.length === 0) {
          const options = Object.entries(flags).map(([property, option]) => `${plan.roleFlags[property] ? '' : 'NO'}${option}`).join(' ');
          await sql.unsafe(`CREATE ROLE "${name}" ${options}`);
        } else check(existing.length === 1 && existing[0].settings === null && !existing[0].membership &&
          Object.keys(flags).every(property => existing[0][property] === plan.roleFlags[property]), 'LOCAL_APPLICATION_ROLE_CHANGED');
        const unexpected = await sql`SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('public','drizzle','information_schema') AND nspname !~ '^pg_') OR
          EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','drizzle') AND
            (c.relrowsecurity OR c.relforcerowsecurity OR c.relkind IN ('v','m','f','p'))) OR
          EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','drizzle') AND (p.prosecdef OR p.prokind<>'f')) OR
          EXISTS(SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname IN ('public','drizzle') AND t.typtype IN ('d','e')) AS unsupported`;
        check(unexpected[0]?.unsupported === false, 'UNREVIEWED_LOCAL_ROLE_MAPPING_SCHEMA');
        await sql`ALTER DATABASE ${identifier(sql, database)} OWNER TO ${identifier(sql, name)}`;
        await sql`ALTER SCHEMA drizzle OWNER TO ${identifier(sql, name)}`;
        // public remains owned by pg_database_owner, as in the source; making
        // the application role the DB owner gives it that same effective role.
        const [publicSchema] = await sql`SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname='public'`;
        check(publicSchema.owner === 'pg_database_owner', 'PUBLIC_SCHEMA_OWNER_MAPPING_CHANGED');
        const tables = await sql`SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname IN ('public','drizzle') AND c.relkind='r' ORDER BY n.nspname,c.relname`;
        for (const table of tables) await sql`ALTER TABLE ${qualified(sql, table.schema, table.name)} OWNER TO ${identifier(sql, name)}`;
        const sequences = await sql`SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname IN ('public','drizzle') AND c.relkind='S' ORDER BY n.nspname,c.relname`;
        for (const sequence of sequences) await sql`ALTER SEQUENCE ${qualified(sql, sequence.schema, sequence.name)} OWNER TO ${identifier(sql, name)}`;
        const functions = await sql`SELECT n.nspname AS schema,p.proname AS name,pg_get_function_identity_arguments(p.oid) AS arguments
          FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','drizzle') ORDER BY n.nspname,p.proname`;
        for (const fn of functions) await sql`ALTER FUNCTION ${qualified(sql, fn.schema, fn.name)}(${sql.unsafe(fn.arguments)}) OWNER TO ${identifier(sql, name)}`;
        await sql.unsafe('COMMIT');
      } catch (error) { await administrative.unsafe('ROLLBACK').catch(() => {}); throw error; }
    } finally { await administrative.end(); }
    const url = new URL(localUrl(manifest, database)); url.username = name;
    const application = connect(url.toString());
    try {
      const access = await application.begin('isolation level repeatable read read only', async sql => {
        const [identity] = await sql`SELECT current_user=session_user AS direct_login,
          (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser,
          pg_get_userbyid(datdba)=current_user AS database_owner,
          has_database_privilege(current_database(),'CREATE') AND has_database_privilege(current_database(),'CONNECT') AND
          has_database_privilege(current_database(),'TEMPORARY') AS database_privileges
          FROM pg_database WHERE datname=current_database()`;
        const [objects] = await sql`SELECT
          (SELECT bool_and(has_schema_privilege(n.oid,'USAGE') AND has_schema_privilege(n.oid,'CREATE'))
            FROM pg_namespace n WHERE n.nspname IN ('public','drizzle')) AS schemas,
          (SELECT bool_and(pg_get_userbyid(c.relowner)=current_user AND has_table_privilege(c.oid,p))
            FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN unnest(${tablePrivileges}::text[]) p
            WHERE n.nspname IN ('public','drizzle') AND c.relkind='r') AS tables,
          (SELECT coalesce(bool_and(pg_get_userbyid(c.relowner)=current_user AND has_sequence_privilege(c.oid,p)),true)
            FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN unnest(${sequencePrivileges}::text[]) p
            WHERE n.nspname IN ('public','drizzle') AND c.relkind='S') AS sequences,
          (SELECT coalesce(bool_and(pg_get_userbyid(p.proowner)=current_user AND has_function_privilege(p.oid,'EXECUTE')),true)
            FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','drizzle')) AS functions`;
        check(identity.direct_login && !identity.superuser && identity.database_owner && identity.database_privileges &&
          Object.values(objects).every(value => value === true), 'LOCAL_APPLICATION_PRIVILEGES_DIFFER');
        compareFingerprints(before, await fingerprint(sql));
        return { ...identity, ...objects };
      });
      return { formatVersion: 1, runId: manifest.runId, database, localRole: name, planDigest: digest(plan),
        sourceAuditDigest: plan.sourceAuditDigest, dataDigest: before.digest, access, applicationDataUnchanged: true,
        scope: plan.scope, mappedAt: new Date().toISOString() };
    } finally { await application.end(); }
  });
}
