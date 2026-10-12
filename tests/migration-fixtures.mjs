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
