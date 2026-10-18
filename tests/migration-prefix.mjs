import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

// Historical migration tests exercise the final text-ID generation explicitly.
// Fresh full-history and canonical cutover gates are separate tests.
export const legacyIdentityLastIndex = 82;
export const legacyIdentityMigrationCount = legacyIdentityLastIndex + 1;
export async function withMigrationPrefix(lastIndex, run) {
  const folder = mkdtempSync(join(tmpdir(), 'momo-db-reviewed-prefix-'));
  try {
    cpSync('./drizzle', folder, { recursive: true });
    const path = join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(path, 'utf8'));
    journal.entries = journal.entries.filter(entry => entry.idx <= lastIndex);
    writeFileSync(path, JSON.stringify(journal));
    return await run(folder);
  } finally { rmSync(folder, { recursive: true, force: true }); }
}
export const migrateThrough = (db, lastIndex) => withMigrationPrefix(lastIndex,
  folder => migrate(drizzle(db), { migrationsFolder: folder }));
export const migrateLegacy = db => migrateThrough(db, legacyIdentityLastIndex);
