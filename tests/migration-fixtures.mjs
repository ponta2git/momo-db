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
