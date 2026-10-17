import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { inspectSchema, inspectIdentifierValues } from '../scripts/migration/inventory.mjs';
import { createTestClient } from './notification-fixtures.mjs';
import { docker, username } from './migration-fixtures.mjs';

async function withDatabase(run) {
  const name = 'momo_db_test_inventory_' + randomUUID().replaceAll('-', '').slice(0, 12);
  docker(['createdb', '-U', username, name]);
  const db = createTestClient(name);
  try { return await run(db, name); }
  finally {
    await db.end();
    docker(['dropdb', '-U', username, name]);
  }
}

const canonical = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const upper = canonical.toUpperCase();
const compact = '{a0ee-bc999c0b4ef8bb6d6bb9bd380a11}';

async function fixture(db) {
  await db.unsafe(`
    CREATE SCHEMA inventory;
    CREATE TYPE inventory.status AS ENUM ('open', 'sealed');
    CREATE DOMAIN inventory.legacy_id AS text CHECK (VALUE <> '');
    CREATE TABLE inventory.parent (
      id text NOT NULL,
      revision integer NOT NULL DEFAULT 1,
      status inventory.status NOT NULL DEFAULT 'open',
      public_id bigint GENERATED ALWAYS AS IDENTITY,
      external_id inventory.legacy_id,
      payload jsonb,
      PRIMARY KEY (id, revision),
      UNIQUE (public_id),
      CONSTRAINT positive_revision CHECK (revision > 0)
    );
    CREATE INDEX parent_open_idx ON inventory.parent (lower(id)) INCLUDE (revision) WHERE status = 'open';
    CREATE TABLE inventory.child_simple (id text PRIMARY KEY, parent_id text, parent_revision integer);
    CREATE TABLE inventory.child_full (id text PRIMARY KEY, parent_id text, parent_revision integer);
    INSERT INTO inventory.parent (id) VALUES ('legacy-parent');
    INSERT INTO inventory.child_simple VALUES
      ('valid', 'legacy-parent', 1), ('missing', 'missing-parent', 1),
      ('partial-null', 'legacy-parent', NULL), ('all-null', NULL, NULL);
    INSERT INTO inventory.child_full SELECT * FROM inventory.child_simple;
    ALTER TABLE inventory.child_simple ADD CONSTRAINT parent_fk FOREIGN KEY (parent_id, parent_revision)
      REFERENCES inventory.parent (id, revision) MATCH SIMPLE NOT VALID;
    ALTER TABLE inventory.child_full ADD CONSTRAINT parent_fk FOREIGN KEY (parent_id, parent_revision)
      REFERENCES inventory.parent (id, revision) MATCH FULL NOT VALID;
    CREATE FUNCTION inventory.guard_parent() RETURNS trigger LANGUAGE plpgsql
      SET search_path = pg_catalog, inventory AS $$ BEGIN RETURN NEW; END $$;
    CREATE TRIGGER parent_guard BEFORE UPDATE ON inventory.parent FOR EACH ROW EXECUTE FUNCTION inventory.guard_parent();
    CREATE VIEW inventory.parent_view AS SELECT id FROM inventory.parent;
    CREATE SCHEMA "quoted.schema";
    CREATE TABLE "quoted.schema"."odd.table" (
      "entity.id" text PRIMARY KEY,
      discord_user_id text,
      worker_id text,
      validation_contract_id text,
      layout_family text,
      payload jsonb,
      native_uuid uuid,
      nullable_id text
    );
  `);
  for (const value of [canonical, upper, compact, '123', 'legacy-id', canonical + '\n']) {
    await db`INSERT INTO "quoted.schema"."odd.table"
      ("entity.id", discord_user_id, worker_id, validation_contract_id, layout_family, payload, native_uuid)
      VALUES (${value}, '1234567890123456789', 'worker:1', 'schema-v4', 'momotetsu_2',
        '{"entityId":"legacy-id","precise":9007199254740993.0001}'::jsonb, ${canonical}::uuid)`;
  }
}

test('read-only inventory preserves schema shape, private identifier evidence and composite FK semantics', async t => {
  await withDatabase(async (db, sourceName) => {
    await fixture(db);
    const { schema, audit } = await db.begin('isolation level repeatable read read only', async sql => {
      const schema = await inspectSchema(sql);
      return { schema, audit: await inspectIdentifierValues(sql, schema) };
    });
    await t.test('catalog details include defaults, constraints, expression indexes, functions and triggers', () => {
      const parent = schema.tables.find(table => table.schema === 'inventory' && table.name === 'parent');
      assert.deepEqual(parent.primaryKey.columns, ['id', 'revision']);
      assert.equal(parent.columns.find(column => column.name === 'revision').default, '1');
      assert.equal(parent.columns.find(column => column.name === 'revision').nullable, false);
      assert.equal(parent.columns.find(column => column.name === 'public_id').identity, 'a');
      assert.equal(parent.columns.find(column => column.name === 'external_id').baseTypeName, 'text');
      assert.ok(parent.checks.some(check => check.name === 'positive_revision'));
      assert.ok(parent.uniqueConstraints.some(key => key.columns.includes('public_id')));
      assert.ok(parent.indexes.some(index => index.expressions === 'lower(id)' && index.predicate.includes('open')));
      assert.equal(parent.triggers[0].functionName, 'guard_parent');
      assert.ok(schema.functions.find(fn => fn.name === 'guard_parent').settings.includes('search_path=pg_catalog, inventory'));
      assert.equal(schema.sequences.find(sequence => sequence.ownedByColumn === 'public_id').increment, '1');
      assert.deepEqual(schema.types.find(type => type.name === 'status').labels, ['open', 'sealed']);
      assert.ok(schema.tables.find(table => table.name === 'parent_view').definition.includes('SELECT id'));
      assert.doesNotThrow(() => JSON.stringify({ schema, audit }));
    });
    await t.test('UUID grammar and canonical collisions retain every spelling without converting values', () => {
      const column = audit.columns.find(column => column.schema === 'quoted.schema' && column.column === 'entity.id');
      assert.deepEqual(column.counts, { rows: '6', nulls: '0', distinctValues: '6', uuidValues: '3', nonUuidValues: '3', nonCanonicalUuidValues: '2', numericLegacyValues: '1' });
      assert.deepEqual(column.canonicalCollisions, [{ canonical, values: [
        { value: upper, count: '1' }, { value: canonical, count: '1' }, { value: compact, count: '1' }
      ] }]);
      assert.deepEqual(column.nonUuidValues.map(value => value.value), ['123', canonical + '\n', 'legacy-id']);
      assert.equal(audit.columns.find(column => column.column === 'native_uuid').counts.uuidValues, '6');
      assert.equal(audit.columns.find(column => column.column === 'nullable_id').counts.nulls, '6');
      assert.ok(audit.blockers.some(blocker => blocker.reason === 'canonical-uuid-collision'));
    });
    await t.test('semantic, external, embedded and immutable candidates require explicit classification', () => {
      assert.equal(audit.complete, false);
      assert.ok(audit.columns.every(column => column.classification === 'unresolved'));
      assert.ok(audit.unresolved.find(column => column.column === 'discord_user_id').reasons.includes('external-identifier-candidate'));
      assert.ok(audit.unresolved.find(column => column.column === 'worker_id').reasons.includes('semantic-text-candidate'));
      assert.ok(audit.unresolved.find(column => column.column === 'layout_family').reasons.includes('semantic-text-candidate'));
      assert.ok(audit.unresolved.find(column => column.column === 'payload').reasons.includes('embedded-reference-candidate'));
    });
    await t.test('orphan detection respects MATCH SIMPLE and MATCH FULL partial nulls', () => {
      const simple = audit.references.find(reference => reference.table === 'child_simple');
      const full = audit.references.find(reference => reference.table === 'child_full');
      assert.equal(simple.orphanRows, '1');
      assert.deepEqual(simple.orphanValues, [{ values: ['missing-parent', '1'], count: '1' }]);
      assert.equal(full.orphanRows, '2');
      assert.deepEqual(full.orphanValues.map(orphan => orphan.values), [['legacy-parent', null], ['missing-parent', '1']]);
    });
    await t.test('custom-format restore produces the same schema inventory despite different OIDs', async () => {
      const backup = docker(['pg_dump', '-U', username, '--format=custom', sourceName]);
      await withDatabase(async (copy, copyName) => {
        docker(['pg_restore', '-U', username, '--exit-on-error', '-d', copyName], backup);
        const restored = await copy.begin('isolation level repeatable read read only', sql => inspectSchema(sql));
        assert.deepEqual(restored, schema);
      });
      const [row] = await db`SELECT payload::text AS payload FROM "quoted.schema"."odd.table" LIMIT 1`;
      assert.ok(row.payload.includes('9007199254740993.0001'));
    });
  });
});

test('identifier audit fails closed when row-level security hides fixture rows', async () => {
  const role = 'momo_inventory_reader_' + randomUUID().replaceAll('-', '').slice(0, 12);
  try {
    await withDatabase(async db => {
      await db.unsafe(`CREATE ROLE ${role}; CREATE TABLE hidden (id text PRIMARY KEY);
        INSERT INTO hidden VALUES ('hidden-id'); ALTER TABLE hidden ENABLE ROW LEVEL SECURITY;
        GRANT SELECT ON hidden TO ${role}`);
      const schema = await inspectSchema(db);
      await assert.rejects(db.begin('read only', async sql => {
        await sql.unsafe(`SET LOCAL ROLE ${role}`);
        return inspectIdentifierValues(sql, schema);
      }), /unfiltered SELECT access/);
    });
  } finally {
    docker(['psql', '-U', username, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', `DROP ROLE IF EXISTS ${role}`]);
  }
});

test('inventory covers the current migration history without approving implicit ID conversions', async () => {
  await withDatabase(async db => {
    await migrate(drizzle(db), { migrationsFolder: './drizzle' });
    await db.begin('isolation level repeatable read read only', async sql => {
      const schema = await inspectSchema(sql);
      const audit = await inspectIdentifierValues(sql, schema);
      assert.ok(schema.tables.some(table => table.schema === 'drizzle' && table.name === '__drizzle_migrations'));
      assert.ok(schema.tables.some(table => table.name === 'discord_notifications'));
      assert.ok(schema.functions.some(fn => fn.name === 'guard_series_analysis_artifact_publication'));
      assert.ok(audit.unresolved.some(column => column.schema === 'drizzle' && column.reasons.includes('migration-ledger-must-remain-unchanged')));
      assert.ok(audit.references.length > 0);
      assert.ok(audit.references.every(reference => reference.status === 'consistent'));
      assert.equal(audit.complete, false);
    });
  });
});
