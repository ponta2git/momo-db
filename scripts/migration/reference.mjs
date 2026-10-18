import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { assertOwned, createDatabase, databaseState, localUrl } from './local.mjs';
import { requireCondition } from './files.mjs';

export const referenceDatabase = 'momo_rehearsal_reference';

// This is a disposable schema oracle, not another production mutation entry.
// The copied journal selects an unchanged historical prefix, just as migration
// regression fixtures do. The repository SQL/metadata is never rewritten.
export async function createMigrationReferences({ manifest, directory, repository, prefixLength,
  beforeMutation, capture, migrateTarget }) {
  await assertOwned(manifest);
  requireCondition(await databaseState(manifest, referenceDatabase) === 'missing', 'EXISTING_REFERENCE_REQUIRES_FRESH_RUN');
  const journal = JSON.parse(await readFile(join(repository, 'drizzle/meta/_journal.json'), 'utf8'));
  requireCondition(Number.isSafeInteger(prefixLength) && prefixLength > 0 && prefixLength < journal.entries.length,
    'REFERENCE_PREFIX_REQUIRED');
  await createDatabase(manifest, referenceDatabase, undefined, { beforeMutation });
  const folder = await mkdtemp(join(directory, 'reference-history-'));
  let client;
  try {
    await cp(join(repository, 'drizzle'), folder, { recursive: true });
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, prefixLength) }), { mode: 0o600 });
    await assertOwned(manifest);
    await beforeMutation();
    client = postgres(localUrl(manifest, referenceDatabase), { max: 1, prepare: false,
      onnotice: () => {}, connection: { application_name: 'momo-db-rehearsal-reference' } });
    await migrate(drizzle(client), { migrationsFolder: folder });
    await client.end(); client = undefined;
    const referenceBefore = await capture(referenceDatabase);
    await migrateTarget(localUrl(manifest, referenceDatabase));
    const referenceAfter = await capture(referenceDatabase);
    return { referenceBefore, referenceAfter };
  } finally {
    if (client) await client.end({ timeout: 1 }).catch(() => {});
    await rm(folder, { recursive: true, force: true });
  }
}
