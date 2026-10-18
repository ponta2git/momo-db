import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { algorithm, namespace, entityNamespaces, canonicalUuid, canonicalIdentity, nameBasedUuid8, buildIdentityMapping } from '../scripts/identity/canonical.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/canonical-identities-v1.json', import.meta.url), 'utf8'));
const contract = JSON.parse(readFileSync(new URL('../docs/contracts/canonical-identities-v1.json', import.meta.url), 'utf8'));

test('frozen mapping agrees with independent RFC SHA-256 UUIDv8 and shared cross-language vectors', () => {
  assert.equal(algorithm, fixture.algorithm);
  assert.equal(namespace, fixture.namespace);
  assert.deepEqual(entityNamespaces, fixture.entityNamespaces);
  const reference = fixture.rfcVector;
  assert.equal(nameBasedUuid8(reference.namespace, Buffer.from(reference.name, 'utf8')), reference.expected);
  for (const value of fixture.cases) assert.equal(canonicalIdentity(value.entity, value.legacy), value.canonical);
});

test('existing UUID bits survive every accepted four-digit separator boundary without version restrictions', () => {
  const groups = ['0011', '2233', '4455', '6677', '8899', 'aabb', 'ccdd', 'eeff'];
  for (let mask = 0; mask < 128; mask++) {
    const text = groups.map((group, index) => (index && (mask & (1 << (index - 1))) ? '-' : '') + group).join('');
    for (const value of [text, text.toUpperCase(), `{${text}}`, `{${text.toUpperCase()}}`]) {
      assert.equal(canonicalUuid(value), '00112233-4455-6677-8899-aabbccddeeff');
      assert.equal(canonicalIdentity('members', value), '00112233-4455-6677-8899-aabbccddeeff');
    }
  }
  assert.equal(canonicalUuid('00000000000000000000000000000000'), '00000000-0000-0000-0000-000000000000');
  assert.equal(canonicalUuid('ffffffffffffffffffffffffffffffff'), 'ffffffff-ffff-ffff-ffff-ffffffffffff');
});

test('non-UUID identities preserve entity, whitespace and Unicode distinctions', () => {
  const values = [
    canonicalIdentity('members', 'same'), canonicalIdentity('matches', 'same'),
    canonicalIdentity('members', ' same'), canonicalIdentity('members', 'same '),
    canonicalIdentity('members', 'SAME'), canonicalIdentity('members', 'é'),
    canonicalIdentity('members', 'e\u0301'), canonicalIdentity('members', ''),
    canonicalIdentity('members', '00112233-4455-6677-8899-aabbccddeeff\n'),
  ];
  assert.equal(new Set(values).size, values.length);
  for (const value of values) assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.equal(canonicalIdentity('series_analysis_jobs', 'fixture-job'), canonicalIdentity('series_analysis_jobs', 'fixture-job'));
});

test('malformed UUID syntax is never trimmed and invalid UTF-8 or entity input fails closed', () => {
  for (const value of [null, 1, {}, ' 00112233-4455-6677-8899-aabbccddeeff',
    '00112233-4455-6677-8899-aabbccddeeff\n', '00112233--4455-6677-8899-aabbccddeeff',
    '{00112233-4455-6677-8899-aabbccddeeff', '00112233-4455-6677-8899-aabbccddeeff}',
    '001122334-4556677-8899-aabbccddeeff', '00112233-4455-6677-8899-aabbccddeefg']) {
    assert.equal(canonicalUuid(value), null);
  }
  for (const value of [null, 1, {}, 'a\0b', '\ud800', '\udc00']) {
    assert.throws(() => canonicalIdentity('members', value), { message: 'INVALID_LEGACY_ID' });
  }
  for (const entity of ['member', 'members ', '', null, '__proto__']) {
    assert.throws(() => canonicalIdentity(entity, 'fixture'), { message: 'UNKNOWN_ENTITY_NAMESPACE' });
  }
  assert.throws(() => nameBasedUuid8('invalid', Buffer.from('fixture')), { message: 'INVALID_NAMESPACE' });
});

test('both alternate UUID spellings and an assigned UUID colliding with an existing UUID stop mapping', () => {
  assert.throws(() => buildIdentityMapping('members', [
    '00112233-4455-6677-8899-aabbccddeeff', '{00112233445566778899AABBCCDDEEFF}',
  ]), { message: 'CANONICAL_ID_COLLISION' });
  assert.throws(() => buildIdentityMapping('members', [
    'fixture-member', '4f6d54e9-7de8-873c-a464-b510c2945ef0',
  ]), { message: 'CANONICAL_ID_COLLISION' });
  const mapping = buildIdentityMapping('members', ['fixture-member', 'fixture-member', 'other-member']);
  assert.equal(mapping.size, 2);
  assert.equal(mapping.get('fixture-member'), fixture.cases[0].canonical);
  assert.notEqual(buildIdentityMapping('matches', ['fixture-member']).get('fixture-member'), mapping.get('fixture-member'));
});

test('schema-only column contract covers the complete reviewed snapshot and all retained scalar aliases', () => {
  const snapshot = JSON.parse(readFileSync(new URL('../drizzle/meta/0080_snapshot.json', import.meta.url), 'utf8'));
  const actual = Object.values(snapshot.tables).flatMap(table => Object.values(table.columns)
    .map(column => `${table.name}.${column.name}:${column.type}:${!column.notNull}`)).sort();
  const listed = contract.columns.map(column => `${column.table}.${column.column}:${column.sourceType}:${column.nullable}`).sort();
  assert.deepEqual(listed, actual);
  assert.equal(new Set(contract.columns.map(column => `${column.table}.${column.column}`)).size, listed.length);
  assert.equal(contract.algorithm, algorithm);
  assert.equal(contract.namespace, namespace);
  assert.deepEqual([...contract.mutableEntities, ...contract.anchoredEntities].sort(), [...entityNamespaces].sort());
  for (const column of contract.columns) {
    if (['canonical_reference', 'canonical_retained_reference', 'polymorphic_reference'].includes(column.policy)
      && column.sourceForeignKeys.length === 0) {
      assert.equal(column.legacyColumn, `legacy_${column.column}`);
      const alias = contract.newLegacyColumns.find(value => value.table === column.table && value.column === column.legacyColumn);
      assert.equal(alias?.type, 'text');
      assert.equal(alias?.nullable, column.nullable);
    }
    if (['frozen_storage', 'notification', 'encoded_reference', 'replay_legacy'].includes(column.policy)) {
      assert.equal(column.targetType, column.sourceType);
      assert.equal(column.legacyColumn, null);
    }
  }
});
