import assert from 'node:assert/strict';
import test from 'node:test';
import { expectedMigrationHistory, migrationHistoryMatches } from '../scripts/check-migration-history.mjs';

test('history verification rejects missing, extra, reordered, rewritten and mistimed migrations', () => {
  const expected = expectedMigrationHistory();
  const actual = expected.map((entry) => ({ ...entry }));
  assert.equal(migrationHistoryMatches(expected, actual), true);
  assert.equal(migrationHistoryMatches(expected, actual.slice(1)), false);
  assert.equal(migrationHistoryMatches(expected, [...actual, actual[0]]), false);
  assert.equal(migrationHistoryMatches(expected, [...actual].reverse()), false);
  assert.equal(migrationHistoryMatches(expected, actual.map((entry, index) => index ? entry : { ...entry, hash: '0'.repeat(64) })), false);
  assert.equal(migrationHistoryMatches(expected, actual.map((entry, index) => index ? entry : { ...entry, created_at: '1' })), false);
});
