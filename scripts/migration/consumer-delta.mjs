import { isDeepStrictEqual } from 'node:util';
import { requireCondition as check } from './files.mjs';

// Expectations are fixed before the operation and contain exact row values.
// No table-, timestamp-, or expiry-wide exclusions are supported.
function indexed(rows) {
  check(Array.isArray(rows), 'CONSUMER_ROWS_REQUIRED');
  const result = new Map();
  for (const row of rows) {
    check(row && typeof row.key === 'string' && row.key.length > 0 &&
      row.values && typeof row.values === 'object' && !Array.isArray(row.values) &&
      !result.has(row.key), 'CONSUMER_ROW_INVALID');
    result.set(row.key, row.values);
  }
  return result;
}

export function compareConsumerDelta(before, after, expected) {
  check(before && after && Array.isArray(expected), 'CONSUMER_DELTA_INPUT_REQUIRED');
  const tables = Object.keys(before).sort();
  check(isDeepStrictEqual(tables, Object.keys(after).sort()), 'CONSUMER_TABLE_SET_CHANGED');
  const permitted = new Map();
  for (const change of expected) {
    check(change && tables.includes(change.table) && typeof change.key === 'string' &&
      ['insert', 'update', 'delete'].includes(change.operation), 'CONSUMER_EXPECTATION_INVALID');
    const key = JSON.stringify([change.table, change.key]);
    check(!permitted.has(key), 'CONSUMER_EXPECTATION_DUPLICATED');
    check((change.operation === 'insert' ? change.before === null : change.before !== null && typeof change.before === 'object') &&
      (change.operation === 'delete' ? change.after === null : change.after !== null && typeof change.after === 'object'),
    'CONSUMER_EXPECTATION_VALUES_REQUIRED');
    permitted.set(key, change);
  }
  let matched = 0;
  for (const table of tables) {
    const oldRows = indexed(before[table]);
    const newRows = indexed(after[table]);
    for (const key of new Set([...oldRows.keys(), ...newRows.keys()])) {
      const oldValue = oldRows.get(key) ?? null;
      const newValue = newRows.get(key) ?? null;
      if (isDeepStrictEqual(oldValue, newValue)) { continue; }
      const wanted = permitted.get(JSON.stringify([table, key]));
      const operation = oldValue === null ? 'insert' : newValue === null ? 'delete' : 'update';
      check(wanted?.operation === operation && isDeepStrictEqual(wanted.before, oldValue) &&
        isDeepStrictEqual(wanted.after, newValue), 'CONSUMER_UNEXPECTED_DELTA');
      matched++;
    }
  }
  check(matched === permitted.size, 'CONSUMER_EXPECTED_DELTA_MISSING');
  return { passed: true, changedRows: matched, tables: tables.length };
}
