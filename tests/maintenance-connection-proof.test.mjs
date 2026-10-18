import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionProof } from '../scripts/maintenance/connection-proof.mjs';

const ledger = [{ hash: 'a'.repeat(64), created_at: '1730000000000' }, { hash: 'b'.repeat(64), created_at: '1730000000001' }];

test('connection proof binds the actual database and full ledger independently of credential and pooler spelling', () => {
  const direct = connectionProof('postgresql://role:secret@ep-fixture.example.neon.tech/configured', 'actual', ledger);
  assert.deepEqual(connectionProof('postgresql://another@ep-fixture-pooler.example.neon.tech:5432/ignored', 'actual', ledger), direct);
  assert.notEqual(connectionProof('postgresql://role@ep-fixture.example.neon.tech/actual', 'recovery', ledger).targetFingerprint, direct.targetFingerprint);
  assert.notEqual(connectionProof('postgresql://role@other.example.neon.tech/actual', 'actual', ledger).targetFingerprint, direct.targetFingerprint);
  assert.notEqual(connectionProof('postgresql://role@ep-fixture.example.neon.tech/actual', 'actual', ledger.toReversed()).ledgerFingerprint, direct.ledgerFingerprint);
  assert.notEqual(connectionProof('postgresql://role@ep-fixture.example.neon.tech/actual', 'actual', [ledger[0]]).ledgerFingerprint, direct.ledgerFingerprint);
  assert.notEqual(connectionProof('postgresql://role@host-pooler.example.test/actual', 'actual', ledger).targetFingerprint,
    connectionProof('postgresql://role@host.example.test/actual', 'actual', ledger).targetFingerprint);
  assert.equal(JSON.stringify(direct).includes('secret'), false);
  for (const invalid of [[], [{ hash: 'a'.repeat(64), created_at: 1730000000000 }], [{ hash: 'bad', created_at: '1' }]]) {
    assert.throws(() => connectionProof('postgresql://localhost/fixture', 'fixture', invalid), { code: 'INVALID_DATABASE_PROOF_LEDGER' });
  }
});
