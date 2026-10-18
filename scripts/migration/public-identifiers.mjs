import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expectedMigrationHistory } from '../check-migration-history.mjs';
import { compareDatabaseLocale } from './database.mjs';
import { digest, requireCondition } from './files.mjs';
import { schemaStructure } from './run.mjs';

export const PUBLIC_IDENTIFIER_PROFILE = 'public-identifiers-v1';
export const PUBLIC_IDENTIFIER_SOURCE_LENGTH = 73;
export const PUBLIC_IDENTIFIER_TAIL = Object.freeze([
  { idx: 73, tag: '0073_add-public-identifiers', created_at: '1792280151246', hash: 'df42acef90e56da36e62daaf5810b12853271e5e098374c485b6b1bdbab36593' },
  { idx: 74, tag: '0074_backfill-public-identifiers', created_at: '1792280152177', hash: '32f8e47f90fb343f575972644f31ea6266c8888a904aedfe69507818731f9df8' },
  { idx: 75, tag: '0075_constrain-public-identifiers', created_at: '1792280153184', hash: '2c9e98e24a570cac7d499d587ab42f9cdc0f0c22aaa550b9c205d11aff5869fe' },
  { idx: 76, tag: '0076_generate-public-identifiers', created_at: '1792280154107', hash: 'e930bf75ddb0502dd20e7280b15e4e0dd2c3d26dbf9e562741d2bb97da738b9a' },
  { idx: 77, tag: '0077_align-public-identifier-sequences', created_at: '1792280154978', hash: '5fa492a337f595703fb7b6408e56ddf6395ecd00a39b216ebc03d7914a3146a6' },
].map(Object.freeze));

const targets = ['held_events', 'matches'];
const targetLength = PUBLIC_IDENTIFIER_SOURCE_LENGTH + PUBLIC_IDENTIFIER_TAIL.length;
const rowAlgorithm = 'sha256-row-multiset-v2';
const key = value => JSON.stringify([value.schema, value.name]);
const ledgerTable = { schema: 'drizzle', name: '__drizzle_migrations' };
const identifier = (sql, name) => sql.unsafe('"' + name.replaceAll('"', '""') + '"');
const relation = (sql, table) => sql`${identifier(sql, table.schema)}.${identifier(sql, table.name)}`;
const equal = (left, right) => digest(left) === digest(right);
const historyRows = entries => entries.map(({ hash, created_at }) => ({ hash, created_at }));
const entryByName = (values, expected, code) => {
  const matches = values.filter(value => key(value) === key(expected));
  requireCondition(matches.length === 1, code);
  return matches[0];
};

function validateHistory(history) {
  requireCondition(history?.profile === PUBLIC_IDENTIFIER_PROFILE && Array.isArray(history.entries)
    && history.entries.length === targetLength && history.migrationDigest === digest(history.entries), 'PUBLIC_IDENTIFIER_HISTORY_INVALID');
  let previous = -1n;
  for (const entry of history.entries) {
    requireCondition(typeof entry.hash === 'string' && /^[0-9a-f]{64}$/.test(entry.hash)
      && typeof entry.created_at === 'string' && /^[1-9][0-9]*$/.test(entry.created_at), 'PUBLIC_IDENTIFIER_HISTORY_INVALID');
    const timestamp = BigInt(entry.created_at);
    requireCondition(timestamp > previous, 'PUBLIC_IDENTIFIER_HISTORY_INVALID');
    previous = timestamp;
  }
  requireCondition(equal(history.entries.slice(PUBLIC_IDENTIFIER_SOURCE_LENGTH), historyRows(PUBLIC_IDENTIFIER_TAIL)), 'PUBLIC_IDENTIFIER_TAIL_CHANGED');
}

/** Read the fixed candidate's history. The profile accepts exactly the reviewed
 * 0073..0077 files; a new or changed tail needs a separately reviewed profile. */
export async function loadPublicIdentifierHistory(repository) {
  let journal;
  let entries;
  try {
    const directory = resolve(repository, 'drizzle');
    journal = JSON.parse(await readFile(resolve(directory, 'meta/_journal.json'), 'utf8'));
    entries = expectedMigrationHistory(directory);
  } catch { requireCondition(false, 'PUBLIC_IDENTIFIER_HISTORY_INVALID'); }
  requireCondition(journal.entries.length === targetLength && PUBLIC_IDENTIFIER_TAIL.every(expected => {
    const actual = journal.entries[expected.idx];
    return actual?.idx === expected.idx && actual.tag === expected.tag && String(actual.when) === expected.created_at;
  }), 'PUBLIC_IDENTIFIER_TAIL_CHANGED');
  const history = { profile: PUBLIC_IDENTIFIER_PROFILE, entries, migrationDigest: digest(entries) };
  validateHistory(history);
  return history;
}

function assertLedger(audit, expected, code) {
  requireCondition(equal(audit?.connection?.ledger, expected)
    && audit.connection.ledgerDigest === digest(expected), code);
}

function assertFreshEmptyTargets(audit) {
  requireCondition(audit?.rows?.algorithm === rowAlgorithm, 'PUBLIC_IDENTIFIER_REFERENCE_ROWS_REQUIRED');
  for (const name of targets) {
    const table = entryByName(audit.rows.tables, { schema: 'public', name }, 'PUBLIC_IDENTIFIER_REFERENCE_ROWS_REQUIRED');
    requireCondition(table.rows === '0', 'PUBLIC_IDENTIFIER_FRESH_REFERENCE_REQUIRED');
  }
}

function sequenceForColumn(schema, table, column) {
  const matches = schema.sequences.filter(sequence => sequence.ownedBySchema === table.schema
    && sequence.ownedByTable === table.name && sequence.ownedByColumn === column);
  requireCondition(matches.length === 1, 'PUBLIC_IDENTIFIER_SEQUENCE_OWNERSHIP_DIFFERS');
  return matches[0];
}

function assertReferenceShape(before, after) {
  for (const name of targets) {
    const previous = entryByName(before.tables, { schema: 'public', name }, 'PUBLIC_IDENTIFIER_REFERENCE_TABLE_MISSING');
    const target = entryByName(after.tables, { schema: 'public', name }, 'PUBLIC_IDENTIFIER_REFERENCE_TABLE_MISSING');
    requireCondition(!previous.columns.some(column => column.name === 'public_id'), 'PUBLIC_IDENTIFIER_SOURCE_ALREADY_EXPANDED');
    const columns = target.columns.filter(column => column.name === 'public_id');
    requireCondition(columns.length === 1 && columns[0].type === 'bigint' && columns[0].nullable === false
      && columns[0].identity === 'a' && columns[0].generated === '' && columns[0].default === null, 'PUBLIC_IDENTIFIER_IDENTITY_SHAPE_DIFFERS');
    requireCondition(target.constraints.some(constraint => constraint.name === `${name}_public_id_unique`
      && constraint.kind === 'u' && equal(constraint.columns, ['public_id']) && constraint.validated
      && constraint.enforced && !constraint.deferrable), 'PUBLIC_IDENTIFIER_UNIQUENESS_DIFFERS');
    const sequence = sequenceForColumn(after, { schema: 'public', name }, 'public_id');
    requireCondition(sequence.schema === 'public' && sequence.name === `${name}_public_id_seq`
      && sequence.type === 'bigint' && sequence.start === '1' && sequence.increment === '1'
      && sequence.minimum === '1' && sequence.maximum === '9223372036854775807' && sequence.cache === '1'
      && sequence.cycle === false, 'PUBLIC_IDENTIFIER_SEQUENCE_SHAPE_DIFFERS');
  }
  const sourceLedgerSequence = sequenceForColumn(before, ledgerTable, 'id');
  const targetLedgerSequence = sequenceForColumn(after, ledgerTable, 'id');
  requireCondition(equal(sourceLedgerSequence, targetLedgerSequence) && sourceLedgerSequence.increment === '1'
    && sourceLedgerSequence.cache === '1' && sourceLedgerSequence.cycle === false, 'PUBLIC_IDENTIFIER_LEDGER_SEQUENCE_UNSUPPORTED');
  return { schema: sourceLedgerSequence.schema, name: sourceLedgerSequence.name,
    minimum: sourceLedgerSequence.minimum, maximum: sourceLedgerSequence.maximum };
}

function profileBody(profile) {
  const { profileDigest, ...body } = profile;
  return body;
}

function validateProfile(profile) {
  requireCondition(profile?.formatVersion === 1 && profile.profile === PUBLIC_IDENTIFIER_PROFILE
    && typeof profile.profileDigest === 'string' && digest(profileBody(profile)) === profile.profileDigest, 'PUBLIC_IDENTIFIER_PROFILE_CHANGED');
  validateHistory(profile.history);
  requireCondition(equal(assertReferenceShape(profile.schemaBefore, profile.schemaAfter), profile.ledgerSequence), 'PUBLIC_IDENTIFIER_PROFILE_CHANGED');
}

/** Both references must be actual fresh-DB audits made with the normal migrator:
 * first the fixed 0072 prefix, then the full fixed history. No snapshot-to-DDL
 * reconstruction or schema-wide exclusions are accepted as the target model. */
export function createPublicIdentifierProfile({ history, referenceBefore, referenceAfter }) {
  validateHistory(history);
  assertLedger(referenceBefore, history.entries.slice(0, PUBLIC_IDENTIFIER_SOURCE_LENGTH), 'PUBLIC_IDENTIFIER_REFERENCE_PREFIX_DIFFERS');
  assertLedger(referenceAfter, history.entries, 'PUBLIC_IDENTIFIER_REFERENCE_TARGET_DIFFERS');
  compareDatabaseLocale(referenceBefore.connection.server, referenceAfter.connection.server);
  assertFreshEmptyTargets(referenceBefore);
  assertFreshEmptyTargets(referenceAfter);
  const schemaBefore = schemaStructure(referenceBefore.schema);
  const schemaAfter = schemaStructure(referenceAfter.schema);
  const ledgerSequence = assertReferenceShape(schemaBefore, schemaAfter);
  const body = { formatVersion: 1, profile: PUBLIC_IDENTIFIER_PROFILE, history: structuredClone(history),
    referenceServer: structuredClone(referenceAfter.connection.server), schemaBefore, schemaAfter, ledgerSequence };
  return { ...body, profileDigest: digest(body) };
}

async function rowFingerprint(sql, table, source, projection) {
  const hash = createHash('sha256');
  let count = 0n;
  for await (const rows of sql`SELECT encode(sha256(convert_to((${projection})::text, 'UTF8')), 'hex') COLLATE "C" AS value
    FROM ${source} record ORDER BY value`.cursor(256)) {
    for (const row of rows) {
      const bytes = Buffer.from(row.value);
      hash.update(String(bytes.length)).update(':').update(bytes).update('\n');
      count++;
    }
  }
  return { ...table, rows: count.toString(), digest: hash.digest('hex') };
}

/** Read in the same repeatable-read, read-only transaction as the target audit.
 * No nextval/setval or table writes occur. Returned counts/digests are private. */
export async function inspectPublicIdentifierTransition(sql, profile) {
  validateProfile(profile);
  const [transaction] = await sql`SELECT current_setting('transaction_isolation') AS isolation,
    current_setting('transaction_read_only') AS read_only, current_setting('row_security') AS row_security`;
  requireCondition(transaction.isolation === 'repeatable read' && transaction.read_only === 'on'
    && transaction.row_security === 'off', 'PUBLIC_IDENTIFIER_READ_ONLY_SNAPSHOT_REQUIRED');
  const [access] = await sql`SELECT count(*)::text AS inaccessible FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE ((n.nspname = 'public' AND c.relname IN ('held_events','matches'))
        OR (n.nspname = 'drizzle' AND c.relname = '__drizzle_migrations'))
      AND (row_security_active(c.oid) OR NOT has_table_privilege(c.oid, 'SELECT'))`;
  requireCondition(access.inaccessible === '0', 'UNFILTERED_SELECT_REQUIRED');
  const projectedTables = [];
  const publicIdentifiers = [];
  for (const name of targets) {
    const table = { schema: 'public', name };
    projectedTables.push(await rowFingerprint(sql, table, relation(sql, table), sql`to_jsonb(record) - 'public_id'`));
    const [assignment] = await sql`SELECT count(*)::text AS rows, count(DISTINCT public_id)::text AS distinct_values,
      count(*) FILTER (WHERE public_id IS NULL)::text AS null_values,
      count(*) FILTER (WHERE public_id IS DISTINCT FROM expected_id)::text AS incorrect_values,
      coalesce(max(public_id), 0)::text AS maximum
      FROM (SELECT public_id, row_number() OVER (ORDER BY id COLLATE "C") AS expected_id FROM ${relation(sql, table)}) numbered`;
    const sequence = { schema: 'public', name: `${name}_public_id_seq` };
    const [sequenceState] = await sql`SELECT last_value::text AS last_value, is_called FROM ${relation(sql, sequence)}`;
    const ownership = await sql`SELECT d.deptype::text AS dependency, a.attidentity::text AS identity
      FROM pg_class s JOIN pg_namespace sn ON sn.oid = s.relnamespace
      JOIN pg_depend d ON d.classid = 'pg_class'::regclass AND d.objid = s.oid
        AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('i','a')
      JOIN pg_class t ON t.oid = d.refobjid JOIN pg_namespace tn ON tn.oid = t.relnamespace
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
      WHERE sn.nspname = 'public' AND s.relname = ${sequence.name}
        AND tn.nspname = 'public' AND t.relname = ${name} AND a.attname = 'public_id'`;
    publicIdentifiers.push({ table, assignment, sequence: { ...sequence, ...sequenceState }, ownership: Array.from(ownership) });
  }
  const ledgerPrefix = await rowFingerprint(sql, ledgerTable,
    sql`(SELECT * FROM ${relation(sql, ledgerTable)} ORDER BY id LIMIT ${PUBLIC_IDENTIFIER_SOURCE_LENGTH})`, sql`to_jsonb(record)`);
  const ledgerTail = await sql`SELECT record.id::text AS id, record.hash, record.created_at::text AS created_at
    FROM ${relation(sql, ledgerTable)} record ORDER BY record.id
    OFFSET ${PUBLIC_IDENTIFIER_SOURCE_LENGTH} LIMIT ${PUBLIC_IDENTIFIER_TAIL.length + 1}`;
  return { formatVersion: 1, profile: profile.profile, profileDigest: profile.profileDigest,
    algorithm: rowAlgorithm, projectedTables, ledgerPrefix, ledgerTail: Array.from(ledgerTail), publicIdentifiers };
}

/** Validate only this exact expansion. Existing ledger rows are included in
 * preservation; only the five expected appends and their serial advancement
 * differ. Every other old sequence and every complete structural object stays. */
export function comparePublicIdentifierTransition({ before, after, transition, profile }) {
  validateProfile(profile);
  assertLedger(before, profile.history.entries.slice(0, PUBLIC_IDENTIFIER_SOURCE_LENGTH), 'PUBLIC_IDENTIFIER_SOURCE_LEDGER_DIFFERS');
  assertLedger(after, profile.history.entries, 'PUBLIC_IDENTIFIER_TARGET_LEDGER_DIFFERS');
  compareDatabaseLocale(profile.referenceServer, before.connection.server);
  compareDatabaseLocale(before.connection.server, after.connection.server);
  requireCondition(equal(schemaStructure(before.schema), profile.schemaBefore), 'PUBLIC_IDENTIFIER_SOURCE_SCHEMA_DIFFERS');
  requireCondition(equal(schemaStructure(after.schema), profile.schemaAfter), 'PUBLIC_IDENTIFIER_TARGET_SCHEMA_DIFFERS');
  requireCondition(before.rows?.algorithm === rowAlgorithm && after.rows?.algorithm === rowAlgorithm
    && transition?.algorithm === rowAlgorithm && transition.formatVersion === 1
    && transition.profile === profile.profile && transition.profileDigest === profile.profileDigest, 'PUBLIC_IDENTIFIER_TRANSITION_MISMATCH');
  const expectedTables = profile.schemaBefore.tables.filter(table => ['r', 'p', 'm'].includes(table.kind) && !table.isPartition).map(key);
  requireCondition(equal(before.rows.tables.map(key), expectedTables)
    && equal(before.rows.sequences.map(key), profile.schemaBefore.sequences.map(key))
    && equal(after.rows.sequences.map(key), profile.schemaAfter.sequences.map(key)), 'PUBLIC_IDENTIFIER_FINGERPRINT_INCOMPLETE');
  requireCondition(equal(before.rows.tables.map(key), after.rows.tables.map(key))
    && equal(transition.projectedTables.map(key), targets.map(name => key({ schema: 'public', name }))), 'PUBLIC_IDENTIFIER_SAVED_TABLES_DIFFER');
  requireCondition(transition.publicIdentifiers.length === targets.length, 'PUBLIC_IDENTIFIER_ASSIGNMENT_DIFFERS');
  for (const table of before.rows.tables) {
    const afterTable = entryByName(after.rows.tables, table, 'PUBLIC_IDENTIFIER_SAVED_TABLES_DIFFER');
    if (table.schema === 'public' && targets.includes(table.name)) {
      const projected = entryByName(transition.projectedTables, table, 'PUBLIC_IDENTIFIER_SAVED_ROWS_DIFFER');
      requireCondition(equal(projected, table) && afterTable.rows === table.rows, 'PUBLIC_IDENTIFIER_SAVED_ROWS_DIFFER');
    } else if (key(table) === key(ledgerTable)) {
      requireCondition(equal(transition.ledgerPrefix, table), 'PUBLIC_IDENTIFIER_LEDGER_PREFIX_ROWS_DIFFER');
      requireCondition(BigInt(afterTable.rows) === BigInt(table.rows) + BigInt(PUBLIC_IDENTIFIER_TAIL.length), 'PUBLIC_IDENTIFIER_TARGET_LEDGER_DIFFERS');
    } else requireCondition(equal(afterTable, table), 'PUBLIC_IDENTIFIER_SAVED_ROWS_DIFFER');
  }
  const expectedSequenceNames = [...before.rows.sequences.map(key), ...targets.map(name => key({ schema: 'public', name: `${name}_public_id_seq` }))].sort();
  requireCondition(equal(after.rows.sequences.map(key).sort(), expectedSequenceNames), 'PUBLIC_IDENTIFIER_SEQUENCE_SET_DIFFERS');
  const sourceLedgerSequence = entryByName(before.rows.sequences, profile.ledgerSequence, 'PUBLIC_IDENTIFIER_LEDGER_SEQUENCE_UNSUPPORTED');
  requireCondition(typeof sourceLedgerSequence.is_called === 'boolean' && /^-?[0-9]+$/.test(sourceLedgerSequence.last_value), 'PUBLIC_IDENTIFIER_LEDGER_SEQUENCE_UNSUPPORTED');
  const firstNewLedgerId = BigInt(sourceLedgerSequence.last_value) + (sourceLedgerSequence.is_called ? 1n : 0n);
  const lastNewLedgerId = firstNewLedgerId + BigInt(PUBLIC_IDENTIFIER_TAIL.length - 1);
  requireCondition(firstNewLedgerId >= BigInt(profile.ledgerSequence.minimum)
    && lastNewLedgerId <= BigInt(profile.ledgerSequence.maximum), 'PUBLIC_IDENTIFIER_LEDGER_SEQUENCE_EXHAUSTED');
  requireCondition(equal(transition.ledgerTail, PUBLIC_IDENTIFIER_TAIL.map((entry, index) => ({
    id: (firstNewLedgerId + BigInt(index)).toString(), hash: entry.hash, created_at: entry.created_at,
  }))), 'PUBLIC_IDENTIFIER_LEDGER_APPEND_DIFFERS');
  for (const sequence of before.rows.sequences) {
    const target = entryByName(after.rows.sequences, sequence, 'PUBLIC_IDENTIFIER_SEQUENCE_SET_DIFFERS');
    if (key(sequence) === key(profile.ledgerSequence)) {
      requireCondition(equal(target, { ...sequence, last_value: lastNewLedgerId.toString(), is_called: true }), 'PUBLIC_IDENTIFIER_LEDGER_SEQUENCE_DIFFERS');
    } else requireCondition(equal(target, sequence), 'PUBLIC_IDENTIFIER_EXISTING_SEQUENCE_DIFFERS');
  }
  for (const name of targets) {
    const values = transition.publicIdentifiers.filter(value => key(value.table) === key({ schema: 'public', name }));
    requireCondition(values.length === 1, 'PUBLIC_IDENTIFIER_ASSIGNMENT_DIFFERS');
    const { assignment, sequence, ownership } = values[0];
    const source = entryByName(before.rows.tables, { schema: 'public', name }, 'PUBLIC_IDENTIFIER_SAVED_TABLES_DIFFER');
    requireCondition(assignment.rows === source.rows && assignment.distinct_values === source.rows
      && assignment.null_values === '0' && assignment.incorrect_values === '0' && assignment.maximum === source.rows, 'PUBLIC_IDENTIFIER_ASSIGNMENT_DIFFERS');
    requireCondition(equal(ownership, [{ dependency: 'i', identity: 'a' }]), 'PUBLIC_IDENTIFIER_SEQUENCE_OWNERSHIP_DIFFERS');
    requireCondition(BigInt(assignment.maximum) < 9223372036854775807n
      && sequence.last_value === (BigInt(assignment.maximum) + 1n).toString() && sequence.is_called === false,
      'PUBLIC_IDENTIFIER_SEQUENCE_NOT_ALIGNED');
    requireCondition(equal(sequence, entryByName(after.rows.sequences, sequence, 'PUBLIC_IDENTIFIER_SEQUENCE_SET_DIFFERS')), 'PUBLIC_IDENTIFIER_SEQUENCE_STATE_DIFFERS');
  }
  return { profile: profile.profile, checks: { sourceSchema: true, targetSchema: true, savedRows: true,
    existingLedgerRows: true, expectedLedgerAppend: true, deterministicPublicIds: true, sequences: true } };
}
