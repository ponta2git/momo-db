import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';

export function expectedMigrationHistory(directory = './drizzle') {
  const journal = JSON.parse(readFileSync(resolve(directory, 'meta/_journal.json'), 'utf8'));
  if (!Array.isArray(journal.entries) || journal.entries.length === 0) {
    throw new Error('Migration history is missing.');
  }
  let previous = -1;
  return journal.entries.map((entry, index) => {
    if (entry.idx !== index || !Number.isSafeInteger(entry.when) || entry.when <= previous ||
        typeof entry.tag !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(entry.tag)) {
      throw new Error('Migration history is invalid.');
    }
    previous = entry.when;
    return {
      hash: createHash('sha256').update(readFileSync(resolve(directory, `${entry.tag}.sql`))).digest('hex'),
      created_at: String(entry.when),
    };
  });
}

export function migrationHistoryMatches(expected, actual) {
  return expected.length > 0 && expected.length === actual.length &&
    expected.every((entry, index) => entry.hash === actual[index].hash &&
      entry.created_at === String(actual[index].created_at));
}

export async function verifyMigrationHistory(sql, directory = './drizzle') {
  const expected = expectedMigrationHistory(directory);
  const actual = await sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`;
  if (!migrationHistoryMatches(expected, actual)) {
    throw new Error('Applied migration history does not match this commit.');
  }
}

async function main() {
  let sql;
  try {
    if (!process.env.DIRECT_URL) throw new Error('Migration database is not configured.');
    sql = postgres(process.env.DIRECT_URL, {
      max: 1, prepare: false, connect_timeout: 10, idle_timeout: 2,
      connection: { statement_timeout: 10000, application_name: 'momo-db-history-check' },
    });
    await verifyMigrationHistory(sql);
    console.log('Applied migration hashes and timestamps match this commit.');
  } catch {
    // The driver may include connection details. Publish only a bounded failure.
    console.error('Migration history verification failed. Keep consumers stopped and inspect the selected migration commit.');
    process.exitCode = 1;
  } finally {
    if (sql) await sql.end({ timeout: 1 }).catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
