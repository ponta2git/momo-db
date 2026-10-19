import assert from 'node:assert/strict';
import test from 'node:test';
import { runAction } from '../scripts/migration/run.mjs';

test('retired final rehearsal manifests are rejected before accessing any resource or changing state', async () => {
  const save = () => assert.fail('a retired run must not be saved');
  for (const finalFreeze of [{ stopEpoch: 1 }, null, false]) {
    const manifest = Object.freeze({ finalFreeze, state: 'prepared' });
    for (const action of ['inspect', 'snapshot', 'restore', 'rehearse', 'verify',
      'recover-rehearsal', 'application-role', 'status', 'cleanup']) {
      await assert.rejects(runAction(action, manifest, undefined, undefined, save),
        { code: 'FINAL_REHEARSAL_RETIRED' });
      assert.equal(manifest.state, 'prepared');
    }
  }
});

test('ordinary rehearsal status does not require retired freeze evidence', async () => {
  const manifest = Object.freeze({ state: 'prepared' });
  await runAction('status', manifest, '/unused-rehearsal-fixture', undefined,
    () => assert.fail('status must not mutate the run'));
  assert.equal(manifest.state, 'prepared');
});
