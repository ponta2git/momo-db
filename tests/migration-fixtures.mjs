import { spawnSync } from 'node:child_process';

// Callers create/drop randomly named test databases in an explicitly selected
// disposable container. createTestClient also guards the database name and host.
const container = process.env.MOMO_DB_TEST_CONTAINER;
export const username = process.env.MOMO_DB_TEST_USER ?? 'postgres';

if (!container || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container)) {
  throw new Error('Set MOMO_DB_TEST_CONTAINER to the disposable local PostgreSQL test container.');
}

export function docker(args, input) {
  const result = spawnSync('docker', ['exec', ...(input ? ['-i'] : []), container, ...args], {
    input, maxBuffer: 32 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`Disposable database command failed: ${args[0]} (${result.status})`, { cause: result.error });
  }
  return result.stdout;
}

export async function snapshotDatabase(db, tables) {
  tables ??= (await db`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`)
    .map(row => row.tablename);
  const rows = {};
  for (const table of tables) {
    // Account ordering must stay stable when is_admin is replaced by role.
    const values = table === 'momo_login_accounts'
      ? await db`SELECT to_jsonb(record) AS value FROM ${db(table)} record ORDER BY id`
      : await db`SELECT to_jsonb(record) AS value FROM ${db(table)} record ORDER BY to_jsonb(record)::text`;
    rows[table] = values.map(row => row.value);
  }
  return {
    rows,
    history: [...await db`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`]
  };
}

export function expectedLoginAccountRoles(accounts) {
  return accounts.map(({ is_admin, ...account }) => {
    if (typeof is_admin !== 'boolean') throw new Error('Expected a legacy account with a boolean is_admin');
    return { ...account, role: is_admin ? 'admin' : 'user' };
  });
}

// Only the two new columns may differ; retain every legacy value and row order.
export function expectedPublicIdentifierRows(rows) {
  const expected = { ...rows };
  for (const table of ['held_events', 'matches']) {
    if (!expected[table]) continue;
    const ids = expected[table].map(row => {
      if (Object.hasOwn(row, 'public_id')) throw new Error('Expected rows before public identifier expansion');
      return row.id;
    }).sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
    const numbers = new Map(ids.map((id, index) => [id, index + 1]));
    expected[table] = expected[table].map(row => ({ ...row, public_id: numbers.get(row.id) }));
  }
  return expected;
}

// These older snapshot fixtures use JSON numbers for small counters. The new
// dedicated fencing migration tests compare SQL text/fingerprints for i64 bounds.
export function expectedFencingCounterRows(rows) {
  if (!rows.series_analysis_jobs) return rows;
  const integer = value => {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('Unsafe fixture counter');
    return value == null ? 0n : BigInt(value);
  };
  if (rows.worker_execution_slots?.length !== 1) throw new Error('Expected the retained global execution slot');
  const global = integer(rows.worker_execution_slots[0].fencing_token);
  const attempts = new Map();
  for (const attempt of rows.series_analysis_job_attempts ?? []) {
    const token = integer(attempt.fencing_token);
    if (token > (attempts.get(attempt.job_id) ?? 0n)) attempts.set(attempt.job_id, token);
  }
  return { ...rows, series_analysis_jobs: rows.series_analysis_jobs.map(row => {
    if (Object.hasOwn(row, 'fencing_counter')) throw new Error('Expected rows before fencing counter expansion');
    const seed = [0n, global, integer(row.lease_fencing_token), attempts.get(row.id) ?? 0n]
      .reduce((maximum, value) => value > maximum ? value : maximum);
    if (seed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Use the precise fencing fixture for i64 values');
    return { ...row, fencing_counter: Number(seed) };
  }) };
}

// The scheduler tail removes only transport tables; historical terminal inputs
// remain absent rather than being fabricated during schema expansion.
export const retiredQueueTables = ['ocr_queue_outbox', 'series_analysis_queue_outbox'];
export function expectedJobSchedulerRows(rows) {
  const expected = { ...rows };
  for (const table of retiredQueueTables) delete expected[table];
  if (expected.ocr_jobs) expected.ocr_jobs = expected.ocr_jobs.map(({ queue_schema_version, ...job }) => {
    if (!['succeeded', 'failed', 'cancelled'].includes(job.status)) {
      throw new Error('Nonterminal OCR needs an explicit cutover expectation');
    }
    return { ...job, input_snapshot: null, failure_retry_count: 0, lease_recovery_count: 0 };
  });
  return expected;
}
