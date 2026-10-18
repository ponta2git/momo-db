// The caller owns the connection and the repeatable-read, read-only transaction.
// These functions issue only SELECTs. Returned values are private migration data;
// never print them, query errors, or bind parameters to a public log.
// Compare inventories with the same search_path: pg_get_* deparsing uses it.

const userNamespace = sql => sql`n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'`;
const keyOf = (schema, name) => JSON.stringify([schema, name]);
// postgres.js sql(name) treats dots as qualification. Catalog names can contain
// literal dots, so quote each already-separated identifier without that rewrite.
const identifier = (sql, name) => {
  if (typeof name !== 'string' || name.includes('\0')) throw new Error('Invalid catalog identifier.');
  return sql.unsafe('"' + name.replaceAll('"', '""') + '"');
};
const relation = (sql, table) => sql`${identifier(sql, table.schema)}.${identifier(sql, table.name)}`;
const join = (sql, fragments, separator) => fragments.reduce((left, right) =>
  left ? sql`${left}${separator}${right}` : right, null);
const plain = rows => Array.from(rows, row => ({ ...row }));

/** Inventory all non-system namespaces, including the Drizzle ledger schema.
 * OIDs and volatile statistics are deliberately absent so a restore can be
 * compared by object identity. Ownership/ACLs remain explicit for role mapping.
 */
export async function inspectSchema(sql) {
  const schemas = plain(await sql`
    SELECT n.nspname AS name, pg_catalog.pg_get_userbyid(n.nspowner) AS owner,
      n.nspacl::text[] AS privileges
    FROM pg_catalog.pg_namespace n WHERE ${userNamespace(sql)} ORDER BY n.nspname COLLATE "C"
  `);
  const tables = plain(await sql`
    SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind,
      pg_catalog.pg_get_userbyid(c.relowner) AS owner, c.relacl::text[] AS privileges,
      c.relpersistence::text AS persistence, c.relrowsecurity AS "rowSecurityEnabled",
      c.relforcerowsecurity AS "rowSecurityForced", c.relreplident::text AS "replicaIdentity",
      c.reloptions AS options, c.relispartition AS "isPartition",
      pg_catalog.pg_get_expr(c.relpartbound, c.oid) AS "partitionBound",
      CASE WHEN c.relkind = 'p' THEN pg_catalog.pg_get_partkeydef(c.oid) END AS "partitionKey",
      CASE WHEN c.relkind IN ('v', 'm') THEN pg_catalog.pg_get_viewdef(c.oid, false) END AS definition,
      coalesce((SELECT jsonb_agg(jsonb_build_object('schema', pn.nspname, 'table', pc.relname) ORDER BY inh.inhseqno)
        FROM pg_catalog.pg_inherits inh
        JOIN pg_catalog.pg_class pc ON pc.oid = inh.inhparent
        JOIN pg_catalog.pg_namespace pn ON pn.oid = pc.relnamespace
        WHERE inh.inhrelid = c.oid), '[]'::jsonb) AS parents
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE ${userNamespace(sql)} AND c.relkind IN ('r', 'p', 'f', 'v', 'm')
    ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C"
  `).map(table => ({ ...table, columns: [], constraints: [], indexes: [], triggers: [], policies: [] }));
  const byTable = new Map(tables.map(table => [keyOf(table.schema, table.name), table]));
  const attach = (rows, collection) => {
    for (const { schema, table, ...value } of rows) {
      const entry = byTable.get(keyOf(schema, table));
      if (!entry) throw new Error('Schema changed during inventory; use a consistent read-only snapshot.');
      entry[collection].push(value);
    }
  };
  attach(await sql`
    SELECT n.nspname AS schema, c.relname AS table, a.attname AS name, a.attnum AS position,
      pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
      tn.nspname AS "typeSchema", t.typname AS "typeName", t.typcategory::text AS "typeCategory",
      coalesce(bt.typname, t.typname) AS "baseTypeName",
      NOT (a.attnotnull OR t.typnotnull) AS nullable,
      pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS "default",
      a.attidentity::text AS identity, a.attgenerated::text AS generated,
      CASE WHEN co.oid IS NOT NULL THEN cn.nspname || '.' || co.collname END AS collation,
      a.attndims AS dimensions
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
    JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace
    LEFT JOIN pg_catalog.pg_type bt ON bt.oid = t.typbasetype AND t.typtype = 'd'
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    LEFT JOIN pg_catalog.pg_collation co ON co.oid = a.attcollation
    LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid = co.collnamespace
    WHERE ${userNamespace(sql)} AND c.relkind IN ('r', 'p', 'f', 'v', 'm')
      AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C", a.attnum
  `, 'columns');
  attach(await sql`
    SELECT n.nspname AS schema, c.relname AS table, con.conname AS name, con.contype::text AS kind,
      pg_catalog.pg_get_constraintdef(con.oid, false) AS definition,
      pg_catalog.pg_get_constraintdef(con.oid, true) AS "comparisonDefinition",
      con.condeferrable AS deferrable, con.condeferred AS "initiallyDeferred",
      con.convalidated AS validated,
      coalesce((to_jsonb(con)->>'conenforced')::boolean, true) AS enforced,
      ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(num, ord)
        JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.num ORDER BY k.ord) AS columns,
      rn.nspname AS "referencedSchema", rc.relname AS "referencedTable",
      ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(num, ord)
        JOIN pg_catalog.pg_attribute a ON a.attrelid = rc.oid AND a.attnum = k.num ORDER BY k.ord) AS "referencedColumns",
      con.confmatchtype::text AS "matchType", con.confupdtype::text AS "onUpdate",
      con.confdeltype::text AS "onDelete",
      coalesce((SELECT jsonb_agg(jsonb_build_object('schema', ons.nspname, 'name', op.oprname) ORDER BY k.ord)
        FROM unnest(con.conpfeqop) WITH ORDINALITY k(oid, ord)
        JOIN pg_catalog.pg_operator op ON op.oid = k.oid
        JOIN pg_catalog.pg_namespace ons ON ons.oid = op.oprnamespace), '[]'::jsonb) AS "equalityOperators"
    FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_catalog.pg_class rc ON rc.oid = con.confrelid
    LEFT JOIN pg_catalog.pg_namespace rn ON rn.oid = rc.relnamespace
    WHERE ${userNamespace(sql)} AND c.relkind IN ('r', 'p', 'f')
    ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C", con.conname COLLATE "C"
  `, 'constraints');
  attach(await sql`
    SELECT n.nspname AS schema, c.relname AS table, ic.relname AS name,
      pg_catalog.pg_get_indexdef(i.indexrelid) AS definition, i.indisunique AS unique,
      i.indisprimary AS primary, i.indisvalid AS valid, i.indisready AS ready,
      i.indisreplident AS "replicaIdentity", i.indnkeyatts AS "keyColumnCount",
      coalesce((to_jsonb(i)->>'indnullsnotdistinct')::boolean, false) AS "nullsNotDistinct",
      pg_catalog.pg_get_expr(i.indpred, i.indrelid) AS predicate,
      pg_catalog.pg_get_expr(i.indexprs, i.indrelid) AS expressions,
      ARRAY(SELECT a.attname FROM unnest(i.indkey) WITH ORDINALITY k(num, ord)
        LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.num ORDER BY k.ord) AS columns,
      am.amname AS method, ic.reloptions AS options
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
    JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_am am ON am.oid = ic.relam
    WHERE ${userNamespace(sql)}
    ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C", ic.relname COLLATE "C"
  `, 'indexes');
  attach(await sql`
    SELECT n.nspname AS schema, c.relname AS table, tr.tgname AS name,
      pg_catalog.pg_get_triggerdef(tr.oid, false) AS definition,
      tr.tgenabled::text AS enabled, fn.nspname AS "functionSchema", p.proname AS "functionName",
      pg_catalog.pg_get_function_identity_arguments(p.oid) AS "functionArguments"
    FROM pg_catalog.pg_trigger tr JOIN pg_catalog.pg_class c ON c.oid = tr.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_proc p ON p.oid = tr.tgfoid
    JOIN pg_catalog.pg_namespace fn ON fn.oid = p.pronamespace
    WHERE ${userNamespace(sql)} AND NOT tr.tgisinternal
    ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C", tr.tgname COLLATE "C"
  `, 'triggers');
  attach(await sql`
    SELECT n.nspname AS schema, c.relname AS table, p.polname AS name,
      p.polcmd::text AS command, p.polpermissive AS permissive,
      ARRAY(SELECT CASE WHEN r = 0 THEN 'public' ELSE pg_catalog.pg_get_userbyid(r) END
        FROM unnest(p.polroles) r ORDER BY 1) AS roles,
      pg_catalog.pg_get_expr(p.polqual, p.polrelid) AS using,
      pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) AS "withCheck"
    FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE ${userNamespace(sql)} ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C", p.polname COLLATE "C"
  `, 'policies');
  const functions = plain(await sql`
    SELECT n.nspname AS schema, p.proname AS name, p.prokind::text AS kind,
      pg_catalog.pg_get_function_identity_arguments(p.oid) AS arguments,
      pg_catalog.pg_get_function_result(p.oid) AS result, l.lanname AS language,
      p.prosecdef AS "securityDefiner", p.provolatile::text AS volatility,
      p.proparallel::text AS parallel, p.proisstrict AS strict, p.proleakproof AS leakproof,
      p.proconfig AS settings, pg_catalog.pg_get_userbyid(p.proowner) AS owner,
      p.proacl::text[] AS privileges,
      CASE WHEN p.prokind <> 'a' THEN pg_catalog.pg_get_functiondef(p.oid) END AS definition
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_catalog.pg_language l ON l.oid = p.prolang
    WHERE ${userNamespace(sql)} ORDER BY n.nspname COLLATE "C", p.proname COLLATE "C",
      pg_catalog.pg_get_function_identity_arguments(p.oid) COLLATE "C"
  `);
  const sequences = plain(await sql`
    SELECT n.nspname AS schema, c.relname AS name, pg_catalog.format_type(s.seqtypid, NULL) AS type,
      s.seqstart::text AS start, s.seqincrement::text AS increment, s.seqmax::text AS maximum,
      s.seqmin::text AS minimum, s.seqcache::text AS cache, s.seqcycle AS cycle,
      pg_catalog.pg_get_userbyid(c.relowner) AS owner, c.relacl::text[] AS privileges,
      tn.nspname AS "ownedBySchema", tc.relname AS "ownedByTable", a.attname AS "ownedByColumn"
    FROM pg_catalog.pg_sequence s JOIN pg_catalog.pg_class c ON c.oid = s.seqrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_class'::regclass
      AND d.objid = c.oid AND d.refclassid = 'pg_catalog.pg_class'::regclass AND d.deptype IN ('a', 'i')
    LEFT JOIN pg_catalog.pg_class tc ON tc.oid = d.refobjid
    LEFT JOIN pg_catalog.pg_namespace tn ON tn.oid = tc.relnamespace
    LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = tc.oid AND a.attnum = d.refobjsubid
    WHERE ${userNamespace(sql)} ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C"
  `);
  const types = plain(await sql`
    SELECT n.nspname AS schema, t.typname AS name, t.typtype::text AS kind,
      CASE WHEN t.typtype = 'd' THEN pg_catalog.format_type(t.typbasetype, t.typtypmod) END AS "baseType",
      t.typnotnull AS "notNull", t.typdefault AS "default",
      ARRAY(SELECT e.enumlabel FROM pg_catalog.pg_enum e WHERE e.enumtypid = t.oid ORDER BY e.enumsortorder) AS labels,
      ARRAY(SELECT pg_catalog.pg_get_constraintdef(con.oid, false) FROM pg_catalog.pg_constraint con
        WHERE con.contypid = t.oid ORDER BY con.conname COLLATE "C") AS checks,
      ARRAY(SELECT pg_catalog.pg_get_constraintdef(con.oid, true) FROM pg_catalog.pg_constraint con
        WHERE con.contypid = t.oid ORDER BY con.conname COLLATE "C") AS "comparisonChecks"
    FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    WHERE ${userNamespace(sql)} AND t.typtype IN ('d', 'e')
    ORDER BY n.nspname COLLATE "C", t.typname COLLATE "C"
  `);
  const extensions = plain(await sql`
    SELECT e.extname AS name, e.extversion AS version, n.nspname AS schema,
      pg_catalog.pg_get_userbyid(e.extowner) AS owner
    FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
    ORDER BY e.extname COLLATE "C"
  `);
  for (const table of tables) {
    table.primaryKey = table.constraints.find(constraint => constraint.kind === 'p') ?? null;
    table.foreignKeys = table.constraints.filter(constraint => constraint.kind === 'f');
    table.checks = table.constraints.filter(constraint => constraint.kind === 'c');
    table.uniqueConstraints = table.constraints.filter(constraint => constraint.kind === 'u');
  }
  return { formatVersion: 1, schemas, tables, functions, sequences, types, extensions };
}

const scalarTypes = new Set(['text', 'varchar', 'bpchar', 'citext', 'uuid', 'int2', 'int4', 'int8', 'numeric']);
const idName = /(?:^id$|_ids?$|_key$|_keys$|_token$|_hash$|_checksum$|^checksum$|^seed$|_seed$|_owner$|^requested_by$|^saved_by$)/u;
const semanticName = /(?:^key$|^kind$|^family$|^layout_family$|^profile_id$|validation_contract|worker_id|lease_owner|algorithm_version|screen_type|scope_key)/u;
const externalName = /(?:discord|channel_id|message_id|interaction_id|object_key|image_path|^user_id$)/u;
const preservedName = /(?:payload|snapshot|checksum|fingerprint|hash|dedupe|token|seed|scope_key|object_key)/u;
const immutableTable = /(?:artifact|radar_basis|radar_bases|revision|notification|history|audit)/u;

function candidateReasons(table, column) {
  const reasons = [];
  if (table.schema === 'drizzle') reasons.push('migration-ledger-must-remain-unchanged');
  if (table.primaryKey?.columns.includes(column.name)) reasons.push('primary-key');
  if (table.foreignKeys.some(key => key.columns.includes(column.name))) reasons.push('foreign-key');
  if (idName.test(column.name)) reasons.push('identifier-name');
  if (column.baseTypeName === 'uuid') reasons.push('uuid-type');
  if (semanticName.test(column.name)) reasons.push('semantic-text-candidate');
  if (externalName.test(column.name)) reasons.push('external-identifier-candidate');
  if (preservedName.test(column.name) || immutableTable.test(table.name)) reasons.push('immutable-contract-candidate');
  if (['json', 'jsonb', 'bytea'].includes(column.baseTypeName) || column.dimensions > 0) reasons.push('embedded-reference-candidate');
  return reasons;
}

// PostgreSQL accepts braces, uppercase, and optional hyphens after groups of
// four hex digits. Guard the cast so a legacy identifier never aborts the audit.
function canonicalUuid(sql, value) {
  const hex = '[0-9a-fA-F]{4}(-?[0-9a-fA-F]{4}){7}';
  return sql`CASE WHEN ${value} ~ ${`\\A(${hex}|\\{${hex}\\})\\Z`}
    THEN ${value}::uuid::text END`;
}

async function inspectColumn(sql, table, column, reasons) {
  const value = sql`${identifier(sql, column.name)}::text COLLATE "C"`;
  const source = sql`SELECT ${value} AS value, ${canonicalUuid(sql, value)} AS canonical FROM ${relation(sql, table)}`;
  const [counts] = await sql`
    SELECT count(*)::text AS rows, count(*) FILTER (WHERE value IS NULL)::text AS nulls,
      count(DISTINCT value)::text AS "distinctValues",
      count(*) FILTER (WHERE canonical IS NOT NULL)::text AS "uuidValues",
      count(*) FILTER (WHERE value IS NOT NULL AND canonical IS NULL)::text AS "nonUuidValues",
      count(*) FILTER (WHERE canonical IS NOT NULL AND value <> canonical)::text AS "nonCanonicalUuidValues",
      count(*) FILTER (WHERE value ~ '\\A[0-9]+\\Z')::text AS "numericLegacyValues"
    FROM (${source}) input
  `;
  // Only values requiring a design decision are retained, never whole rows.
  const nonUuidValues = plain(await sql`
    SELECT value, count(*)::text AS count FROM (${source}) input
    WHERE value IS NOT NULL AND canonical IS NULL GROUP BY value ORDER BY value COLLATE "C"
  `);
  const nonCanonicalUuidValues = plain(await sql`
    SELECT value, canonical, count(*)::text AS count FROM (${source}) input
    WHERE canonical IS NOT NULL AND value <> canonical GROUP BY value, canonical ORDER BY value COLLATE "C"
  `);
  const canonicalCollisions = plain(await sql`
    SELECT canonical, jsonb_agg(jsonb_build_object('value', value, 'count', count) ORDER BY value COLLATE "C") AS values
    FROM (SELECT value, canonical, count(*)::text AS count FROM (${source}) input
      WHERE canonical IS NOT NULL GROUP BY value, canonical) spellings
    GROUP BY canonical HAVING count(*) > 1 ORDER BY canonical COLLATE "C"
  `);
  return { schema: table.schema, table: table.name, column: column.name, type: column.type,
    classification: 'unresolved', reasons, counts: { ...counts }, nonUuidValues,
    nonCanonicalUuidValues, canonicalCollisions };
}

async function inspectForeignKey(sql, table, key) {
  const identity = { schema: table.schema, table: table.name, constraint: key.name,
    columns: key.columns, referencedSchema: key.referencedSchema, referencedTable: key.referencedTable,
    referencedColumns: key.referencedColumns, matchType: key.matchType };
  if (!['s', 'f'].includes(key.matchType) || key.equalityOperators.some(op => op.schema !== 'pg_catalog' || op.name !== '=')) {
    return { ...identity, status: 'unresolved', reason: 'unsupported-foreign-key-comparison' };
  }
  const sourceColumns = key.columns.map(name => sql`source.${identifier(sql, name)}`);
  const allPresent = join(sql, sourceColumns.map(column => sql`${column} IS NOT NULL`), sql` AND `);
  const anyPresent = join(sql, sourceColumns.map(column => sql`${column} IS NOT NULL`), sql` OR `);
  const equal = join(sql, sourceColumns.map((column, index) =>
    sql`target.${identifier(sql, key.referencedColumns[index])} = ${column}`), sql` AND `);
  const tuple = join(sql, sourceColumns.map(column => sql`${column}::text`), sql`, `);
  const relevant = key.matchType === 'f' ? anyPresent : allPresent;
  const orphanValues = plain(await sql`
    SELECT jsonb_build_array(${tuple}) AS values, count(*)::text AS count
    FROM ${relation(sql, table)} source
    WHERE (${relevant}) AND NOT EXISTS (
      SELECT 1 FROM ${relation(sql, { schema: key.referencedSchema, name: key.referencedTable })} target WHERE ${equal})
    GROUP BY jsonb_build_array(${tuple}) ORDER BY jsonb_build_array(${tuple})
  `);
  const orphanRows = orphanValues.reduce((count, row) => count + BigInt(row.count), 0n).toString();
  return { ...identity, status: orphanRows === '0' ? 'consistent' : 'orphaned', orphanRows, orphanValues };
}

/** A conservative audit, not an instruction to convert *_id columns.
 * Call in the same read-only snapshot as inspectSchema. No sampling/truncation
 * is used; non-UUID values, spelling collisions and orphan keys remain private.
 * App/JSON/browser references still need a reviewed column-by-column contract.
 */
export async function inspectIdentifierValues(sql, schema) {
  const columns = [];
  const references = [];
  const unresolved = [];
  const blockers = [];
  const [access] = await sql`
    SELECT count(*)::text AS inaccessible FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE ${userNamespace(sql)} AND c.relkind IN ('r', 'p')
      AND (pg_catalog.row_security_active(c.oid) OR NOT pg_catalog.has_table_privilege(c.oid, 'SELECT'))
  `;
  if (access.inaccessible !== '0') throw new Error('Identifier inventory requires unfiltered SELECT access to every application table.');
  for (const table of schema.tables) {
    if (!['r', 'p'].includes(table.kind)) {
      unresolved.push({ schema: table.schema, table: table.name, reason: 'non-local-table-requires-review' });
      continue;
    }
    for (const column of table.columns) {
      const reasons = candidateReasons(table, column);
      if (!reasons.length) continue;
      const identity = { schema: table.schema, table: table.name, column: column.name };
      unresolved.push({ ...identity, reasons, requiredDecision: 'value-classification-target-generation-compatibility-comparison-recovery' });
      if (!scalarTypes.has(column.baseTypeName) || column.dimensions > 0) continue;
      const inspection = await inspectColumn(sql, table, column, reasons);
      columns.push(inspection);
      if (inspection.canonicalCollisions.length) blockers.push({ ...identity, reason: 'canonical-uuid-collision' });
    }
    for (const key of table.foreignKeys) {
      const reference = await inspectForeignKey(sql, table, key);
      references.push(reference);
      if (reference.status !== 'consistent') blockers.push({ schema: table.schema, table: table.name, constraint: key.name, reason: reference.status });
    }
  }
  return { formatVersion: 1, complete: false, columns, references, unresolved, blockers,
    limitations: ['No conversion is approved by this audit.', 'Non-FK, embedded, browser, URL, checksum and immutable references need consumer review.'] };
}
