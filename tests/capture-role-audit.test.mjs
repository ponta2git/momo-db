import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../scripts/migration/files.mjs';
import { validateConsumerObservations } from '../scripts/migration/capture-role-audit.mjs';

const now = Date.parse('2026-10-20T00:00:00Z');
const ledger = [{ hash: 'fixture', created_at: '1' }];
const source = { connection: { server: { database: 'neondb' }, ledgerDigest: digest(ledger) } };
const observations = ['api', 'worker', 'summit'].map(consumer => ({
  report: { formatVersion: 1, consumer, database: 'neondb', role: 'fixture-owner', ledger,
    readOnly: true, mode: 'maintenance', observedAt: new Date(now - 1000).toISOString(),
    machine: { id: consumer, bootId: `boot-${consumer}`, imageDigest: `sha256:${'a'.repeat(64)}` } },
  machine: { id: consumer, state: 'started', startedAt: now - 2000, imageDigest: `sha256:${'a'.repeat(64)}` },
}));

test('requires three fresh process reports tied to the observed provider boot and image', () => {
  assert.equal(validateConsumerObservations(observations, source, now).length, 3);
  for (const mutate of [
    value => value.pop(),
    value => { value[0].report.consumer = 'worker'; },
    value => { value[0].report.database = 'other'; },
    value => { value[0].report.ledger = []; },
    value => { value[0].report.readOnly = false; },
    value => { value[0].machine.startedAt = now; },
    value => { value[0].machine.state = 'stopped'; },
    value => { value[0].machine.imageDigest = `sha256:${'b'.repeat(64)}`; },
  ]) {
    const input = structuredClone(observations);
    mutate(input);
    assert.throws(() => validateConsumerObservations(input, source, now));
  }
  assert.throws(() => validateConsumerObservations(observations, source, now + 300000));
});

test('Rust object key order does not change the canonical ledger identity', () => {
  const input = structuredClone(observations);
  input[1].report.ledger = [{ created_at: '1', hash: 'fixture' }];
  assert.equal(validateConsumerObservations(input, source, now).length, 3);
});

test('existing runtime correlation cannot masquerade as a self-report or omit socket evidence', () => {
  const input = structuredClone(observations);
  for (const item of input) {
    item.report.mode = 'existing-runtime-correlated';
    item.report.helperIsApplicationProcess = false;
    item.machine.instanceId = item.report.machine.bootId;
    item.machine.startedAt = now - 86400000;
    item.runtime = { sameInstanceBeforeAndAfter: true, sameConfigBeforeAndAfter: true,
      processSocketToConfiguredDatabase: true, poolCorrelation: 'shared-pgbouncer-with-process-socket',
      configurationDigest: 'a'.repeat(64), processEvidenceDigest: 'b'.repeat(64), logsDigest: 'c'.repeat(64) };
  }
  assert.equal(validateConsumerObservations(input, source, now).length, 3);
  input[0].runtime.processSocketToConfiguredDatabase = false;
  assert.throws(() => validateConsumerObservations(input, source, now));
});
