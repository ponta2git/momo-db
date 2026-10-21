import test from 'node:test';
import assert from 'node:assert/strict';
import { guardedApply, configurationDigest } from '../scripts/migration/cutover-guard.mjs';

const candidate = 'a'.repeat(40);
function fixture() {
  const time = Date.now();
  const source = {
    connection: {
      ledger: Array.from({ length: 73 }, (_, index) => ({ hash: String(index), created_at: String(index) })),
      server: { encoding: 'UTF8', collation: 'C.UTF-8', ctype: 'C.UTF-8', localeProvider: 'b',
        locale: 'C.UTF-8', icuRules: null, collationVersion: '1', actualCollationVersion: '1' },
    },
    role: 'owner', rolesDigest: 'b'.repeat(64), locationIdentity: 'c'.repeat(64), schema: { tables: [] },
    rows: { algorithm: 'sha256-row-multiset-v2', tables: [{ name: 'fixture', rows: '1', digest: 'd'.repeat(64) }],
      sequences: [{ name: 'fixture_id_seq', last_value: '1', is_called: true }] },
  };
  const actual = ['api', 'worker', 'summit'].map(id => ({ id, instance_id: `instance-${id}`,
    state: 'stopped', config: { restart: { policy: 'no' }, services: [], env: { FIXTURE: '1' } } }));
  const evidence = { formatVersion: 1, kind: 'final-cutover-evidence', candidate,
    profile: 'canonical-identities-retired-slots-v1', refs: { db: candidate, summit: candidate, result: candidate },
    frozenAt: new Date(time - 3000).toISOString(), validatedAt: new Date(time - 1000).toISOString(),
    expiresAt: new Date(time + 60000).toISOString(),
    backup: { capturedAt: new Date(time - 2000).toISOString(), restoredAndRead: true,
      archiveDigest: 'd'.repeat(64), restoredReportDigest: 'e'.repeat(64) },
    finalData: { passed: true, path: 'full-rehearsal', reportDigest: 'f'.repeat(64) },
    source, machines: actual.map(item => ({ consumer: item.id, app: `fixture-${item.id}`, id: item.id,
      instanceId: item.instance_id, configDigest: configurationDigest(item.config) })) };
  return { evidence, actual };
}

test('SQL follows two live stopped-Machine observations and complete source comparison', async () => {
  const { evidence, actual } = fixture();
  const events = [];
  await guardedApply({ evidence, candidate,
    observeMachines: async () => { events.push('machines'); return actual; },
    inspectSource: async () => { events.push('source'); return evidence.source; },
    migrate: async () => { events.push('sql'); }, record: async value => { events.push(value.state); } });
  assert.deepEqual(events, ['machines', 'source', 'machines', 'sql-starting', 'sql',
    'sql-returned-success-needs-postcomparison']);
});

test('changed row, sequence, schema, role, target/partial ledger, or host prevents SQL', async () => {
  for (const mutate of [
    source => { source.rows.tables[0].digest = 'changed'; },
    source => { source.rows.sequences[0].last_value = '2'; },
    source => { source.schema.tables.push({ name: 'unexpected' }); },
    source => { source.role = 'different'; },
    source => { source.rolesDigest = 'changed'; },
    source => { source.connection.ledger.push({ hash: 'target', created_at: '74' }); },
    source => { source.connection.ledger.pop(); },
    source => { source.locationIdentity = 'changed'; },
    source => { source.connection.server.locale = 'C'; },
  ]) {
    const { evidence, actual } = fixture();
    const source = structuredClone(evidence.source);
    mutate(source);
    await assert.rejects(guardedApply({ evidence, candidate, observeMachines: async () => actual,
      inspectSource: async () => source, migrate: () => assert.fail('SQL must not execute'), record: async () => {} }));
  }
});

test('restart, config drift, extra Machine or expired/incomplete backup fails closed', async () => {
  for (const change of [
    ({ actual }) => { actual[0].state = 'started'; },
    ({ actual }) => { actual[0].instance_id = 'new-boot'; },
    ({ actual }) => { actual[0].config.restart.policy = 'always'; },
    ({ actual }) => { actual.push(actual[0]); },
    ({ evidence }) => { evidence.expiresAt = '2000-01-01T00:00:00Z'; },
    ({ evidence }) => { evidence.backup.restoredAndRead = false; },
    ({ evidence }) => { evidence.finalData.passed = false; },
    ({ evidence }) => { evidence.candidate = 'b'.repeat(40); },
  ]) {
    const input = fixture(); change(input);
    await assert.rejects(guardedApply({ evidence: input.evidence, candidate,
      observeMachines: async () => input.actual, inspectSource: async () => input.evidence.source,
      migrate: () => assert.fail('SQL must not execute'), record: async () => {} }));
  }
});

test('Machine restarted during inventory is rejected and unknown SQL result is never retried', async () => {
  const { evidence, actual } = fixture();
  let calls = 0;
  await assert.rejects(guardedApply({ evidence, candidate,
    observeMachines: async () => { calls++; return calls === 1 ? actual : actual.map(m => ({ ...m, state: 'started' })); },
    inspectSource: async () => evidence.source, migrate: () => assert.fail('SQL must not execute'),
    record: async () => {} }));
  const states = [];
  let attempts = 0;
  await assert.rejects(guardedApply({ evidence, candidate, observeMachines: async () => actual,
    inspectSource: async () => evidence.source, migrate: async () => { attempts++; throw new Error('network lost'); },
    record: async result => { states.push(result.state); } }), /SQL_RESULT_UNKNOWN_DO_NOT_RETRY/);
  assert.equal(attempts, 1);
  assert.deepEqual(states, ['sql-starting', 'sql-result-unknown-read-only-classification-required']);
});
