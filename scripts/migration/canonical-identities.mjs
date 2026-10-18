import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expectedMigrationHistory } from '../check-migration-history.mjs';
import { canonicalIdentity, canonicalUuid } from '../identity/canonical.mjs';
import { compareDatabaseLocale } from './database.mjs';
import { digest, requireCondition } from './files.mjs';
import { schemaStructure } from './schema.mjs';
import { PUBLIC_IDENTIFIER_TAIL, assertReferenceShape, retainReviewedFunctions, retainedFunctions,
  rowFingerprint } from './public-identifiers.mjs';

export const CANONICAL_IDENTITY_PROFILE = 'canonical-identities-v1';
export const CANONICAL_IDENTITY_SOURCE_LENGTH = 73;
export const CANONICAL_CONTRACT_DIGEST = 'a40ed5f8ec408ea1c4957967c42091485aac3a487901a5dc39f259b0c9dab811';
export const CANONICAL_IDENTITY_TAIL = Object.freeze([
  ...PUBLIC_IDENTIFIER_TAIL,
  { idx: 78, tag: '0078_lock-analysis-fencing-expansion', created_at: '1792283594713', hash: 'dc772c6342e86d0d79adbff1de1fa0cff700e9add96d9a11bce90446198bb8a5' },
  { idx: 79, tag: '0079_add-analysis-fencing-counter', created_at: '1792283604827', hash: 'fe38b0624a97897e5d4c2aa71c745f0c6d8859e0d44a47a91ecf23d032999e7f' },
  { idx: 80, tag: '0080_seed-analysis-fencing-counter', created_at: '1792283610471', hash: 'a140d0528116bcb751cd578f5274db4143865d0be188355b39818a9e780cf96f' },
  { idx: 81, tag: '0081_normalize-layout-families', created_at: '1792284729602', hash: 'cc1632dc4fad848f62d0ffb2fcebe62bf2c672e0ce36ae04255cc279506e8b04' },
  { idx: 82, tag: '0082_constrain-layout-families', created_at: '1792284916828', hash: '3e883a4f417a87222d162b7d508b741045504bb9372f4ac8a8ae146e9f7ff038' },
  { idx: 83, tag: '0083_explicit-analysis-transitions', created_at: '1792286314208', hash: '53ce0f1e02a5a3e1d16fb099fd6c8a71eed81a1f8a19470d765d0b38b445d62e' },
  { idx: 84, tag: '0084_expand-canonical-identities', created_at: '1792286623785', hash: '6990a135636f3686ec1fae8316d85b8cb24fa5a799d72ec1fa5f849d6cd5962c' },
  { idx: 85, tag: '0085_backfill-canonical-identities', created_at: '1792286636219', hash: '09a824fb1f7680b4e566a6f72b5a588363039396296bb7d9b873a09ff9ccf249' },
  { idx: 86, tag: '0086_detach-legacy-identity-references', created_at: '1792287148076', hash: 'bb4d6906ed73ba9210542f40a0bfac7602f794f6ba75114cb405647dd6a1038c' },
  { idx: 87, tag: '0087_retain-legacy-identity-columns', created_at: '1792287232093', hash: '9238ec5221b8dc504542b5fec7ac57caf73b3bbeaadf354159999d8ace124453' },
  { idx: 88, tag: '0088_promote-canonical-identity-columns', created_at: '1792287256444', hash: '43615a1f999b3aa267f6387ebba9c34780f0ec27f2cfb6b050cd9ba7ebf0e03e' },
  { idx: 89, tag: '0089_rebind-canonical-trigger-columns', created_at: '1792287802231', hash: 'b77d805f3c9981176c5efaa151da33e58f010b6f354e6838b59e58bf1201e5e5' },
  { idx: 90, tag: '0090_contract-canonical-identities', created_at: '1792287855126', hash: '7597c812c60c4eab9ce8854e23b18e2d8eae457e0332fe661074ccb1032d1c8e' },
  { idx: 91, tag: '0091_backfill-frozen-identity-anchors', created_at: '1792287870941', hash: 'ce65fe37e1c89925b6cb71ce1f73bf074e3da43f89daaab018120ebf32b2c685' },
  { idx: 92, tag: '0092_attach-canonical-identity-references', created_at: '1792287890195', hash: '861261e4161bcc53766a15ffa762aacf26fbc929dcf542ebeebc7643a6390d11' },
  { idx: 93, tag: '0093_canonical-publication-guards', created_at: '1792287900052', hash: '0151dcf6b10377acd9260a2e1a579198a6d124780c2fe533ecdc3039015afa16' },
].map(Object.freeze));

const contractBytes = await readFile(new URL('../../docs/contracts/canonical-identities-v1.json', import.meta.url));
requireCondition(createHash('sha256').update(contractBytes).digest('hex') === CANONICAL_CONTRACT_DIGEST, 'CANONICAL_CONTRACT_CHANGED');
const contract = JSON.parse(contractBytes);
const targetLength = CANONICAL_IDENTITY_SOURCE_LENGTH + CANONICAL_IDENTITY_TAIL.length;
const rowAlgorithm = 'sha256-row-multiset-v2';
const key = value => JSON.stringify([value.schema, value.name]);
const columnKey = value => JSON.stringify([value.schema, value.table, value.column]);
const ledgerTable = { schema: 'drizzle', name: '__drizzle_migrations' };
const targets = ['held_events', 'matches'];
const layoutTables = ['game_titles', 'match_drafts', 'matches'];
const anchors = Object.freeze([
  { source: 'series_analysis_artifacts', target: 'series_analysis_artifact_identities' },
  { source: 'series_radar_bases', target: 'series_radar_basis_identities' },
]);
const additions = Object.freeze([
  { table: 'held_events', column: 'public_id', mode: 'public-number' },
  { table: 'matches', column: 'public_id', mode: 'public-number' },
  { table: 'series_analysis_jobs', column: 'fencing_counter', mode: 'fencing-seed' },
]);
const equal = (left, right) => digest(left) === digest(right);
const q = value => '"' + value.replaceAll('"', '""') + '"';
const relation = table => `${q(table.schema)}.${q(table.name)}`;
const historyRows = entries => entries.map(({ hash, created_at }) => ({ hash, created_at }));
const one = (values, wanted, code) => {
  const found = values.filter(value => key(value) === key(wanted));
  requireCondition(found.length === 1, code);
  return found[0];
};

function validateHistory(history) {
  requireCondition(history?.profile === CANONICAL_IDENTITY_PROFILE && Array.isArray(history.entries)
    && history.entries.length === targetLength && history.migrationDigest === digest(history.entries)
    && history.contractDigest === CANONICAL_CONTRACT_DIGEST, 'CANONICAL_HISTORY_INVALID');
  let previous = -1n;
  for (const entry of history.entries) {
    requireCondition(typeof entry.hash === 'string' && /^[0-9a-f]{64}$/.test(entry.hash)
      && typeof entry.created_at === 'string' && /^[1-9][0-9]*$/.test(entry.created_at), 'CANONICAL_HISTORY_INVALID');
    const timestamp = BigInt(entry.created_at);
    requireCondition(timestamp > previous, 'CANONICAL_HISTORY_INVALID');
    previous = timestamp;
  }
  requireCondition(equal(history.entries.slice(CANONICAL_IDENTITY_SOURCE_LENGTH), historyRows(CANONICAL_IDENTITY_TAIL)), 'CANONICAL_TAIL_CHANGED');
}

export async function loadCanonicalIdentityHistory(repository) {
  let journal; let entries; let bytes;
  try {
    const directory = resolve(repository, 'drizzle');
    journal = JSON.parse(await readFile(resolve(directory, 'meta/_journal.json'), 'utf8'));
    entries = expectedMigrationHistory(directory);
    bytes = await readFile(resolve(repository, 'docs/contracts/canonical-identities-v1.json'));
  } catch { requireCondition(false, 'CANONICAL_HISTORY_INVALID'); }
  requireCondition(createHash('sha256').update(bytes).digest('hex') === CANONICAL_CONTRACT_DIGEST, 'CANONICAL_CONTRACT_CHANGED');
  requireCondition(journal.entries.length === targetLength && CANONICAL_IDENTITY_TAIL.every(expected => {
    const actual = journal.entries[expected.idx];
    return actual?.idx === expected.idx && actual.tag === expected.tag && String(actual.when) === expected.created_at;
  }), 'CANONICAL_TAIL_CHANGED');
  const history = { profile: CANONICAL_IDENTITY_PROFILE, entries, migrationDigest: digest(entries), contractDigest: CANONICAL_CONTRACT_DIGEST };
  validateHistory(history);
  return history;
}

function assertLedger(audit, expected, code) {
  requireCondition(equal(audit?.connection?.ledger, expected) && audit.connection.ledgerDigest === digest(expected), code);
}

/** Every source and target column has an explicit proof. A new column, table,
 * omitted legacy alias or unknown conversion makes this fixed profile fail. */
export function canonicalColumnCoverage(before, after) {
  const covered = [];
  const tables = [];
  const observedSource = [];
  const add = (schema, table, column, mode) => covered.push({ schema, table, column, mode });
  for (const source of before.tables) {
    requireCondition(['r', 'p', 'm'].includes(source.kind) && !source.isPartition, 'CANONICAL_SOURCE_RELATION_UNSUPPORTED');
    if (key(source) === key(ledgerTable)) {
      for (const column of source.columns) add(source.schema, source.name, column.name, 'ledger-prefix-and-append');
      continue;
    }
    requireCondition(source.schema === 'public', 'CANONICAL_SOURCE_RELATION_UNSUPPORTED');
    const target = source.name === 'idempotency_keys' ? 'idempotency_keys_legacy' : source.name;
    const columns = source.columns.map(column => {
      const matches = contract.columns.filter(value => value.table === source.name && value.column === column.name);
      requireCondition(matches.length === 1, 'CANONICAL_SOURCE_COLUMN_UNCOVERED');
      const item = matches[0];
      observedSource.push(`${source.name}.${column.name}`);
      requireCondition(item.targetTable === target, 'CANONICAL_TARGET_TABLE_UNSUPPORTED');
      const converted = item.sourceType !== 'uuid' && item.targetType === 'uuid';
      const mode = converted ? 'typed-uuid' : layoutTables.includes(source.name) && column.name === 'layout_family' ? 'layout-normalization' : 'exact-saved-value';
      let lookupTable = null;
      if (converted && !item.legacyColumn) {
        requireCondition(item.targetEntity && (contract.mutableEntities.includes(item.targetEntity) || contract.anchoredEntities.includes(item.targetEntity)),
          'CANONICAL_REFERENCE_WITHOUT_LEGACY_PROOF');
        lookupTable = anchors.find(anchor => anchor.source === item.targetEntity)?.target ?? item.targetEntity;
      }
      add('public', target, column.name, mode);
      return { name: column.name, mode, entity: item.policy === 'canonical_entity' ? source.name : item.targetEntity,
        legacyColumn: item.legacyColumn, lookupTable, polymorphic: item.policy === 'polymorphic_reference' };
    });
    tables.push({ source: { schema: 'public', name: source.name }, target: { schema: 'public', name: target }, columns });
  }
  requireCondition(equal(observedSource.sort(), contract.columns.filter(item => !additions.some(added => added.table === item.table && added.column === item.column))
    .map(item => `${item.table}.${item.column}`).sort()), 'CANONICAL_SOURCE_COLUMN_COVERAGE_DIFFERS');
  for (const item of contract.newLegacyColumns) {
    const source = tables.find(table => table.source.name === item.table)?.columns.find(column => column.name === item.sourceColumn);
    requireCondition(source?.mode === 'typed-uuid' && source.legacyColumn === item.column, 'CANONICAL_LEGACY_COLUMN_WITHOUT_SOURCE_PROOF');
    add('public', item.table, item.column, 'exact-legacy-alias');
  }
  for (const item of additions) add('public', item.table, item.column, item.mode);
  for (const anchor of anchors) {
    for (const column of ['legacy_id', 'legacy_game_title_id']) add('public', anchor.target, column, 'exact-frozen-source-alias');
    for (const column of ['id', 'game_title_id']) add('public', anchor.target, column, 'typed-anchor-uuid');
  }
  const newReplay = one(after.tables, { schema: 'public', name: 'idempotency_keys' }, 'CANONICAL_NEW_REPLAY_TABLE_REQUIRED');
  for (const column of contract.columns.filter(column => column.table === 'idempotency_keys')) add('public', newReplay.name, column.column, 'empty-new-replay');
  const expected = after.tables.flatMap(table => table.columns.map(column => columnKey({ schema: table.schema, table: table.name, column: column.name }))).sort();
  const actual = covered.map(columnKey).sort();
  requireCondition(new Set(actual).size === actual.length && equal(actual, expected), 'CANONICAL_TARGET_COLUMN_COVERAGE_DIFFERS');
  requireCondition(tables.flatMap(table => table.columns).filter(column => column.mode === 'typed-uuid').length === 109
    && contract.newLegacyColumns.length === 47, 'CANONICAL_CONVERSION_COVERAGE_DIFFERS');
  return { tables, columns: covered.sort((left, right) => Buffer.compare(Buffer.from(columnKey(left)), Buffer.from(columnKey(right)))) };
}

function profileBody(profile) { const { profileDigest, ...body } = profile; return body; }

function validateProfile(profile) {
  requireCondition(profile?.formatVersion === 1 && profile.profile === CANONICAL_IDENTITY_PROFILE
    && profile.profileDigest === digest(profileBody(profile)), 'CANONICAL_PROFILE_CHANGED');
  validateHistory(profile.history);
  requireCondition(equal(profile.coverage, canonicalColumnCoverage(profile.schemaBefore, profile.schemaAfter)), 'CANONICAL_PROFILE_CHANGED');
  requireCondition(equal(profile.ledgerSequence, assertReferenceShape(profile.schemaBefore, profile.schemaAfter)), 'CANONICAL_PROFILE_CHANGED');
  for (const retained of profile.retainedFunctions ?? []) {
    requireCondition(retainedFunctions.some(expected => equal(retained, expected)), 'CANONICAL_PROFILE_CHANGED');
    for (const schema of [profile.schemaBefore, profile.schemaAfter]) {
      const functions = schema.functions.filter(value => value.schema === retained.schema && value.name === retained.name && value.arguments === retained.arguments);
      requireCondition(functions.length === 1 && digest(functions[0]) === retained.digest, 'CANONICAL_RETAINED_FUNCTION_CHANGED');
    }
  }
}

export function createCanonicalIdentityProfile({ history, referenceBefore, referenceAfter, sourceSchema }) {
  validateHistory(history);
  assertLedger(referenceBefore, history.entries.slice(0, CANONICAL_IDENTITY_SOURCE_LENGTH), 'CANONICAL_REFERENCE_PREFIX_DIFFERS');
  assertLedger(referenceAfter, history.entries, 'CANONICAL_REFERENCE_TARGET_DIFFERS');
  compareDatabaseLocale(referenceBefore.connection.server, referenceAfter.connection.server);
  for (const audit of [referenceBefore, referenceAfter]) {
    requireCondition(audit.rows?.algorithm === rowAlgorithm && targets.every(name =>
      one(audit.rows.tables, { schema: 'public', name }, 'CANONICAL_FRESH_REFERENCE_REQUIRED').rows === '0'), 'CANONICAL_FRESH_REFERENCE_REQUIRED');
  }
  const retained = retainReviewedFunctions(schemaStructure(referenceBefore.schema), schemaStructure(referenceAfter.schema), sourceSchema);
  const { schemaBefore, schemaAfter } = retained;
  const body = { formatVersion: 1, profile: CANONICAL_IDENTITY_PROFILE, history: structuredClone(history),
    referenceServer: structuredClone(referenceAfter.connection.server), ...retained,
    ledgerSequence: assertReferenceShape(schemaBefore, schemaAfter), coverage: canonicalColumnCoverage(schemaBefore, schemaAfter) };
  return { ...body, profileDigest: digest(body) };
}

async function assertSnapshot(sql) {
  const [transaction] = await sql`SELECT current_setting('transaction_isolation') AS isolation,
    current_setting('transaction_read_only') AS read_only, current_setting('row_security') AS row_security`;
  requireCondition(transaction.isolation === 'repeatable read' && transaction.read_only === 'on'
    && transaction.row_security === 'off', 'CANONICAL_READ_ONLY_SNAPSHOT_REQUIRED');
  const [access] = await sql`SELECT count(*)::text AS inaccessible FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r','p','m') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_'
      AND (row_security_active(c.oid) OR NOT has_table_privilege(c.oid, 'SELECT'))`;
  requireCondition(access.inaccessible === '0', 'UNFILTERED_SELECT_REQUIRED');
}

const layoutAliases = Object.freeze({ momotetsu_2: 'momotetsu_2', momotetsu2: 'momotetsu_2', 2: 'momotetsu_2',
  world: 'world', momotetsu_world: 'world', default: 'world', reiwa: 'reiwa', momotetsu_reiwa: 'reiwa' });
export function canonicalLayout(value) {
  if (value === null) return null;
  const normalized = value.replace(/^[\x09-\x0d ]+|[\x09-\x0d ]+$/gu, '').replace(/[A-Z]/gu, character => character.toLowerCase());
  requireCondition(Object.hasOwn(layoutAliases, normalized), 'CANONICAL_SOURCE_LAYOUT_UNMAPPED');
  return layoutAliases[normalized];
}
const normalizedLayoutSql = expression => `CASE translate(btrim(${expression}, U&'\\0020\\0009\\000A\\000B\\000C\\000D'),
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') ${Object.entries(layoutAliases).map(([alias, target]) => `WHEN '${alias}' THEN '${target}'`).join(' ')} ELSE NULL END`;

function legacyExpression(column) {
  if (column.legacyColumn) return `record.${q(column.legacyColumn)}`;
  requireCondition(column.lookupTable, 'CANONICAL_REFERENCE_WITHOUT_LEGACY_PROOF');
  return `(SELECT parent.legacy_id FROM public.${q(column.lookupTable)} parent WHERE parent.id = record.${q(column.name)})`;
}

function projectedSource(table, target) {
  return `(SELECT ${table.columns.map(column => {
    const expression = target && column.mode === 'typed-uuid' ? legacyExpression(column)
      : !target && column.mode === 'layout-normalization' ? normalizedLayoutSql(`record.${q(column.name)}`) : `record.${q(column.name)}`;
    return `${expression} AS ${q(column.name)}`;
  }).join(', ')} FROM ${relation(target ? table.target : table.source)} record)`;
}

/** Capture the three approved layout projections and frozen source aliases in
 * the same transaction as the complete baseline audit. Numeric/JSON/bytea
 * values stay in PostgreSQL; only fixed-width row hashes leave the server. */
export async function inspectCanonicalSource(sql, profile, before) {
  validateProfile(profile); await assertSnapshot(sql);
  assertLedger(before, profile.history.entries.slice(0, CANONICAL_IDENTITY_SOURCE_LENGTH), 'CANONICAL_SOURCE_LEDGER_DIFFERS');
  requireCondition(equal(schemaStructure(before.schema), profile.schemaBefore), 'CANONICAL_SOURCE_SCHEMA_DIFFERS');
  const normalizedTables = [];
  for (const table of profile.coverage.tables.filter(table => layoutTables.includes(table.source.name))) {
    const expression = normalizedLayoutSql('layout_family');
    for (const row of await sql.unsafe(`SELECT DISTINCT layout_family AS legacy, (${expression}) AS normalized FROM ${relation(table.source)}`)) {
      requireCondition(row.normalized === canonicalLayout(row.legacy), 'CANONICAL_SOURCE_LAYOUT_PROJECTION_DIFFERS');
    }
    normalizedTables.push(await rowFingerprint(sql, table.source, sql.unsafe(projectedSource(table, false)), sql`to_jsonb(record)`));
  }
  const anchorAliases = [];
  for (const anchor of anchors) {
    anchorAliases.push(await rowFingerprint(sql, { schema: 'public', name: anchor.target },
      sql.unsafe(`(SELECT id AS legacy_id, game_title_id AS legacy_game_title_id FROM public.${q(anchor.source)})`), sql`to_jsonb(record)`));
  }
  return { formatVersion: 1, profile: profile.profile, profileDigest: profile.profileDigest,
    baselineDigest: digest(before), algorithm: rowAlgorithm, normalizedTables, anchorAliases };
}

async function inspectIdentityPairs(sql, table, column, identities) {
  let pairs = 0n; let incorrect = 0n; let collisions = 0n;
  const task = column.polymorphic ? ', record.task_kind' : '';
  for await (const rows of sql.unsafe(`SELECT DISTINCT record.${q(column.name)}::text AS canonical,
    ${legacyExpression(column)} AS legacy${task} FROM ${relation(table)} record`).cursor(256)) {
    for (const row of rows) {
      pairs++;
      if (row.legacy === null || row.canonical === null) {
        if (row.legacy !== null || row.canonical !== null) incorrect++;
        continue;
      }
      let entity = column.entity; let expected;
      if (column.polymorphic) {
        if (row.task_kind === 'analysis') entity = column.name === 'job_id' ? 'series_analysis_jobs' : 'series_analysis_job_attempts';
        else if (row.task_kind === 'ocr') entity = column.name === 'job_id' ? 'ocr_jobs' : 'ocr_attempts';
        else { incorrect++; continue; }
      }
      expected = entity === 'ocr_attempts' ? canonicalUuid(row.legacy) : canonicalIdentity(entity, row.legacy);
      if (row.canonical !== expected) incorrect++;
      const mapping = identities.get(entity) ?? new Map();
      if (mapping.has(row.canonical) && mapping.get(row.canonical) !== row.legacy) collisions++;
      mapping.set(row.canonical, row.legacy);
      identities.set(entity, mapping);
    }
  }
  return { ...table, column: column.name, pairs: pairs.toString(), incorrect: incorrect.toString(), collisions: collisions.toString() };
}

async function inspectPublicNumbers(sql) {
  const values = [];
  for (const name of targets) {
    const table = { schema: 'public', name };
    const [assignment] = await sql.unsafe(`SELECT count(*)::text AS rows, count(DISTINCT public_id)::text AS distinct_values,
      count(*) FILTER (WHERE public_id IS NULL)::text AS null_values,
      count(*) FILTER (WHERE public_id IS DISTINCT FROM expected_id)::text AS incorrect_values,
      coalesce(max(public_id), 0)::text AS maximum
      FROM (SELECT public_id, row_number() OVER (ORDER BY legacy_id COLLATE "C") AS expected_id FROM ${relation(table)}) numbered`);
    const sequence = { schema: 'public', name: `${name}_public_id_seq` };
    const [state] = await sql.unsafe(`SELECT last_value::text AS last_value, is_called FROM ${relation(sequence)}`);
    const ownership = await sql`SELECT d.deptype::text AS dependency, a.attidentity::text AS identity
      FROM pg_class s JOIN pg_namespace sn ON sn.oid = s.relnamespace
      JOIN pg_depend d ON d.classid = 'pg_class'::regclass AND d.objid = s.oid
        AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('i','a')
      JOIN pg_class t ON t.oid = d.refobjid JOIN pg_namespace tn ON tn.oid = t.relnamespace
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
      WHERE sn.nspname = 'public' AND s.relname = ${sequence.name}
        AND tn.nspname = 'public' AND t.relname = ${name} AND a.attname = 'public_id'`;
    values.push({ table, assignment, sequence: { ...sequence, ...state }, ownership: Array.from(ownership) });
  }
  return values;
}

/** All legacy projections and mapping checks share the target audit's read-only
 * snapshot. UUID comparisons use the independent JavaScript implementation;
 * immutable bodies and all numeric values never make a JSON round trip. */
export async function inspectCanonicalIdentityTransition(sql, profile) {
  validateProfile(profile); await assertSnapshot(sql);
  const projectedTables = [];
  const identityChecks = [];
  const identities = new Map();
  for (const table of profile.coverage.tables) {
    projectedTables.push(await rowFingerprint(sql, table.source, sql.unsafe(projectedSource(table, true)), sql`to_jsonb(record)`));
    for (const column of table.columns.filter(column => column.mode === 'typed-uuid')) {
      identityChecks.push(await inspectIdentityPairs(sql, table.target, column, identities));
    }
  }
  const anchorAliases = [];
  for (const anchor of anchors) {
    const table = { schema: 'public', name: anchor.target };
    anchorAliases.push(await rowFingerprint(sql, table,
      sql.unsafe(`(SELECT legacy_id, legacy_game_title_id FROM ${relation(table)})`), sql`to_jsonb(record)`));
    for (const column of [
      { name: 'id', entity: anchor.source, legacyColumn: 'legacy_id' },
      { name: 'game_title_id', entity: 'game_titles', legacyColumn: 'legacy_game_title_id' },
    ]) identityChecks.push(await inspectIdentityPairs(sql, table, column, identities));
  }
  const [fencing] = await sql`SELECT count(*)::text AS rows,
    count(*) FILTER (WHERE jobs.fencing_counter IS DISTINCT FROM greatest(0::bigint,
      (SELECT max(fencing_token) FROM public.worker_execution_slots), coalesce(jobs.lease_fencing_token, 0),
      coalesce((SELECT max(attempt.fencing_token) FROM public.series_analysis_job_attempts attempt WHERE attempt.job_id = jobs.id), 0)))::text AS incorrect,
    count(*) FILTER (WHERE jobs.fencing_counter < 0 OR jobs.fencing_counter >= 9223372036854775807)::text AS exhausted
    FROM public.series_analysis_jobs jobs`;
  const ledgerPrefix = await rowFingerprint(sql, ledgerTable,
    sql`(SELECT * FROM drizzle.__drizzle_migrations ORDER BY id LIMIT ${CANONICAL_IDENTITY_SOURCE_LENGTH})`, sql`to_jsonb(record)`);
  const ledgerTail = await sql`SELECT record.id::text AS id, record.hash, record.created_at::text AS created_at
    FROM drizzle.__drizzle_migrations record ORDER BY record.id OFFSET ${CANONICAL_IDENTITY_SOURCE_LENGTH} LIMIT ${CANONICAL_IDENTITY_TAIL.length + 1}`;
  return { formatVersion: 1, profile: profile.profile, profileDigest: profile.profileDigest, algorithm: rowAlgorithm,
    coverageDigest: digest(profile.coverage), projectedTables, identityChecks, anchorAliases, fencing,
    publicIdentifiers: await inspectPublicNumbers(sql), ledgerPrefix, ledgerTail: Array.from(ledgerTail) };
}

function assertFingerprintCoverage(audit, schema) {
  const expectedTables = schema.tables.filter(table => ['r', 'p', 'm'].includes(table.kind) && !table.isPartition).map(key);
  requireCondition(equal(audit.rows.tables.map(key), expectedTables)
    && equal(audit.rows.sequences.map(key), schema.sequences.map(key))
    && audit.rows.digest === digest({ algorithm: audit.rows.algorithm, tables: audit.rows.tables, sequences: audit.rows.sequences }),
  'CANONICAL_FINGERPRINT_INCOMPLETE');
}

export function compareCanonicalIdentityTransition({ before, after, sourceTransition, transition, profile }) {
  validateProfile(profile);
  assertLedger(before, profile.history.entries.slice(0, CANONICAL_IDENTITY_SOURCE_LENGTH), 'CANONICAL_SOURCE_LEDGER_DIFFERS');
  assertLedger(after, profile.history.entries, 'CANONICAL_TARGET_LEDGER_DIFFERS');
  compareDatabaseLocale(profile.referenceServer, before.connection.server);
  compareDatabaseLocale(before.connection.server, after.connection.server);
  requireCondition(equal(schemaStructure(before.schema), profile.schemaBefore), 'CANONICAL_SOURCE_SCHEMA_DIFFERS');
  requireCondition(equal(schemaStructure(after.schema), profile.schemaAfter), 'CANONICAL_TARGET_SCHEMA_DIFFERS');
  requireCondition(before.rows?.algorithm === rowAlgorithm && after.rows?.algorithm === rowAlgorithm
    && transition?.algorithm === rowAlgorithm && transition.formatVersion === 1
    && transition.profile === profile.profile && transition.profileDigest === profile.profileDigest
    && transition.coverageDigest === digest(profile.coverage), 'CANONICAL_TRANSITION_MISMATCH');
  requireCondition(sourceTransition?.algorithm === rowAlgorithm && sourceTransition.formatVersion === 1
    && sourceTransition.profile === profile.profile && sourceTransition.profileDigest === profile.profileDigest
    && sourceTransition.baselineDigest === digest(before), 'CANONICAL_SOURCE_TRANSITION_MISMATCH');
  assertFingerprintCoverage(before, profile.schemaBefore); assertFingerprintCoverage(after, profile.schemaAfter);
  requireCondition(equal(transition.projectedTables.map(key), profile.coverage.tables.map(table => key(table.source))), 'CANONICAL_SAVED_TABLES_DIFFER');
  requireCondition(equal(sourceTransition.normalizedTables.map(key), profile.coverage.tables.filter(table => layoutTables.includes(table.source.name)).map(table => key(table.source)))
    && equal(sourceTransition.anchorAliases.map(key), anchors.map(anchor => key({ schema: 'public', name: anchor.target })))
    && equal(transition.anchorAliases.map(key), sourceTransition.anchorAliases.map(key)), 'CANONICAL_SOURCE_TRANSITION_INCOMPLETE');
  for (const table of profile.coverage.tables) {
    const original = one(before.rows.tables, table.source, 'CANONICAL_SAVED_TABLES_DIFFER');
    const observed = one(after.rows.tables, table.target, 'CANONICAL_SAVED_TABLES_DIFFER');
    const expected = layoutTables.includes(table.source.name)
      ? one(sourceTransition.normalizedTables, table.source, 'CANONICAL_SOURCE_TRANSITION_INCOMPLETE') : original;
    const projected = one(transition.projectedTables, table.source, 'CANONICAL_SAVED_TABLES_DIFFER');
    requireCondition(expected.rows === original.rows && observed.rows === original.rows && equal(projected, expected), 'CANONICAL_SAVED_ROWS_DIFFER');
  }
  const identityColumns = profile.coverage.tables.flatMap(table => table.columns.filter(column => column.mode === 'typed-uuid')
    .map(column => ({ ...table.target, column: column.name })));
  for (const anchor of anchors) for (const column of ['id', 'game_title_id']) identityColumns.push({ schema: 'public', name: anchor.target, column });
  requireCondition(equal(transition.identityChecks.map(({ schema, name, column }) => ({ schema, name, column })), identityColumns), 'CANONICAL_IDENTITY_CHECKS_INCOMPLETE');
  requireCondition(transition.identityChecks.every(check => /^\d+$/.test(check.pairs) && check.incorrect === '0' && check.collisions === '0'), 'CANONICAL_UUID_ASSIGNMENT_DIFFERS');
  for (const anchor of anchors) {
    const expected = one(sourceTransition.anchorAliases, { schema: 'public', name: anchor.target }, 'CANONICAL_SOURCE_TRANSITION_INCOMPLETE');
    const actual = one(transition.anchorAliases, expected, 'CANONICAL_ANCHOR_ROWS_DIFFER');
    requireCondition(equal(actual, expected)
      && expected.rows === one(before.rows.tables, { schema: 'public', name: anchor.source }, 'CANONICAL_SAVED_TABLES_DIFFER').rows
      && actual.rows === one(after.rows.tables, expected, 'CANONICAL_ANCHOR_ROWS_DIFFER').rows, 'CANONICAL_ANCHOR_ROWS_DIFFER');
  }
  requireCondition(one(after.rows.tables, { schema: 'public', name: 'idempotency_keys' }, 'CANONICAL_NEW_REPLAY_TABLE_REQUIRED').rows === '0', 'CANONICAL_NEW_REPLAY_NOT_EMPTY');
  requireCondition(transition.fencing?.rows === one(before.rows.tables, { schema: 'public', name: 'series_analysis_jobs' }, 'CANONICAL_SAVED_TABLES_DIFFER').rows
    && transition.fencing.incorrect === '0' && transition.fencing.exhausted === '0', 'CANONICAL_FENCING_SEED_DIFFERS');
  const oldLedger = one(before.rows.tables, ledgerTable, 'CANONICAL_LEDGER_PREFIX_ROWS_DIFFER');
  const newLedger = one(after.rows.tables, ledgerTable, 'CANONICAL_TARGET_LEDGER_DIFFERS');
  requireCondition(equal(transition.ledgerPrefix, oldLedger), 'CANONICAL_LEDGER_PREFIX_ROWS_DIFFER');
  requireCondition(BigInt(newLedger.rows) === BigInt(oldLedger.rows) + BigInt(CANONICAL_IDENTITY_TAIL.length), 'CANONICAL_TARGET_LEDGER_DIFFERS');
  const expectedSequenceNames = [...before.rows.sequences.map(key), ...targets.map(name => key({ schema: 'public', name: `${name}_public_id_seq` }))].sort();
  requireCondition(equal(after.rows.sequences.map(key).sort(), expectedSequenceNames), 'CANONICAL_SEQUENCE_SET_DIFFERS');
  const sourceSequence = one(before.rows.sequences, profile.ledgerSequence, 'CANONICAL_LEDGER_SEQUENCE_UNSUPPORTED');
  requireCondition(typeof sourceSequence.is_called === 'boolean' && /^-?[0-9]+$/.test(sourceSequence.last_value), 'CANONICAL_LEDGER_SEQUENCE_UNSUPPORTED');
  const firstLedgerId = BigInt(sourceSequence.last_value) + (sourceSequence.is_called ? 1n : 0n);
  const lastLedgerId = firstLedgerId + BigInt(CANONICAL_IDENTITY_TAIL.length - 1);
  requireCondition(firstLedgerId >= BigInt(profile.ledgerSequence.minimum) && lastLedgerId <= BigInt(profile.ledgerSequence.maximum), 'CANONICAL_LEDGER_SEQUENCE_EXHAUSTED');
  requireCondition(equal(transition.ledgerTail, CANONICAL_IDENTITY_TAIL.map((entry, index) => ({
    id: (firstLedgerId + BigInt(index)).toString(), hash: entry.hash, created_at: entry.created_at,
  }))), 'CANONICAL_LEDGER_APPEND_DIFFERS');
  for (const sequence of before.rows.sequences) {
    const observed = one(after.rows.sequences, sequence, 'CANONICAL_SEQUENCE_SET_DIFFERS');
    if (key(sequence) === key(profile.ledgerSequence)) {
      requireCondition(equal(observed, { ...sequence, last_value: lastLedgerId.toString(), is_called: true }), 'CANONICAL_LEDGER_SEQUENCE_DIFFERS');
    } else requireCondition(equal(observed, sequence), 'CANONICAL_EXISTING_SEQUENCE_DIFFERS');
  }
  requireCondition(transition.publicIdentifiers.length === targets.length, 'CANONICAL_PUBLIC_NUMBER_ASSIGNMENT_DIFFERS');
  for (const name of targets) {
    const values = transition.publicIdentifiers.filter(value => key(value.table) === key({ schema: 'public', name }));
    requireCondition(values.length === 1, 'CANONICAL_PUBLIC_NUMBER_ASSIGNMENT_DIFFERS');
    const { assignment, sequence, ownership } = values[0];
    const source = one(before.rows.tables, { schema: 'public', name }, 'CANONICAL_SAVED_TABLES_DIFFER');
    requireCondition(assignment.rows === source.rows && assignment.distinct_values === source.rows
      && assignment.null_values === '0' && assignment.incorrect_values === '0' && assignment.maximum === source.rows, 'CANONICAL_PUBLIC_NUMBER_ASSIGNMENT_DIFFERS');
    requireCondition(equal(ownership, [{ dependency: 'i', identity: 'a' }]), 'CANONICAL_PUBLIC_NUMBER_OWNERSHIP_DIFFERS');
    requireCondition(sequence.last_value === (BigInt(source.rows) + 1n).toString() && sequence.is_called === false
      && equal(sequence, one(after.rows.sequences, sequence, 'CANONICAL_SEQUENCE_SET_DIFFERS')), 'CANONICAL_PUBLIC_NUMBER_SEQUENCE_DIFFERS');
  }
  return { profile: profile.profile, checks: { sourceSchema: true, targetSchema: true, allColumns: true, savedRows: true,
    legacyAliases: true, uuidAssignments: true, frozenAnchors: true, replayBoundary: true, layoutNormalization: true,
    fencingSeeds: true, existingLedgerRows: true, expectedLedgerAppend: true, deterministicPublicIds: true, sequences: true } };
}
