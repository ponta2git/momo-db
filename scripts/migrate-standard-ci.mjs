import { expectedMigrationHistory } from './check-migration-history.mjs';
import { withVerifiedMigrationTarget } from './migration-target.mjs';
import { command } from './migration/process.mjs';
import { requireCondition as check, RehearsalError } from './migration/files.mjs';

try {
  const expected = expectedMigrationHistory();
  await withVerifiedMigrationTarget(async sql => {
    const rows = await sql`SELECT hash, created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY id`;
    check(rows.length <= expected.length && rows.every((row, index) =>
      row.hash === expected[index].hash && row.created_at === String(expected[index].created_at)),
    'UNKNOWN_HISTORY_DO_NOT_APPLY');
    // This tail retires legacy identities and worker slots. A normal push must
    // never apply it even if an old approval is clicked during the cutover.
    check(!(rows.length < 96 && expected.length >= 96), 'BREAKING_TAIL_REQUIRES_PROTECTED_CUTOVER');
  });
  await command('pnpm', ['exec', 'drizzle-kit', 'migrate']);
} catch (error) {
  console.error(error instanceof RehearsalError ? error.code : 'STANDARD_MIGRATION_FAILED_DETAILS_WITHHELD');
  process.exitCode = 1;
}
