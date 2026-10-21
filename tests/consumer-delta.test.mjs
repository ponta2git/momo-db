import test from 'node:test';
import assert from 'node:assert/strict';
import { compareConsumerDelta } from '../scripts/migration/consumer-delta.mjs';

const row = (key, values) => ({ key, values });
const before = {
  jobs: [row('j1', { status: 'running', fence: '2', payload: 'kept' })],
  publications: [],
  leases: [row('expired-owned', { expiresAt: '2026-01-01' }), row('expired-other', { expiresAt: '2026-01-01' })],
};
const after = {
  jobs: [row('j1', { status: 'published', fence: '2', payload: 'kept' }), row('j2', { status: 'queued', fence: '0', payload: 'new' })],
  publications: [row('p1', { job: 'j1', revision: '1' })],
  leases: [before.leases[1]],
};
const expected = [
  { table: 'jobs', key: 'j1', operation: 'update', before: before.jobs[0].values, after: after.jobs[0].values },
  { table: 'jobs', key: 'j2', operation: 'insert', before: null, after: after.jobs[1].values },
  { table: 'publications', key: 'p1', operation: 'insert', before: null, after: after.publications[0].values },
  { table: 'leases', key: 'expired-owned', operation: 'delete', before: before.leases[0].values, after: null },
];
test('accepts exact new rows, publication and explicitly owned expired deletion', () => {
  assert.deepEqual(compareConsumerDelta(before, after, expected), { passed: true, changedRows: 4, tables: 3 });
});
for (const [name, mutate] of [
  ['unrelated column changed', value => { value.jobs[0].values.payload = 'lost'; }],
  ['missing retained row', value => { value.jobs.shift(); }],
  ['extra row', value => { value.jobs.push(row('extra', { status: 'queued' })); }],
  ['unrelated expired deletion', value => { value.leases = []; }],
  ['missing expected publication', value => { value.publications = []; }],
  ['duplicate row key', value => { value.jobs.push(value.jobs[0]); }],
]) {
  test(`rejects ${name}`, () => {
    const value = structuredClone(after);
    mutate(value);
    assert.throws(() => compareConsumerDelta(before, value, expected));
  });
}
