import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expectedMigrationHistory, migrationHistoryMatches } from "./check-migration-history.mjs";
import { errorCode, PreflightConfigError, withVerifiedMigrationTarget } from "./migration-target.mjs";

const baselineTag = "0072_repository_query_indexes";

export function expectedCutoverBaseline(directory = "./drizzle") {
  const journal = JSON.parse(readFileSync(resolve(directory, "meta/_journal.json"), "utf8"));
  const index = journal.entries?.findIndex((entry) => entry.tag === baselineTag);
  if (index !== 72) {
    throw new Error("The cutover baseline is not migration 0072 in this commit.");
  }
  return expectedMigrationHistory(directory).slice(0, index + 1);
}

export function cutoverBaselineMatches(expected, actual) {
  return migrationHistoryMatches(expected, actual) &&
    actual.every((entry, index) => Number(entry.id) === index + 1);
}

async function main() {
  try {
    const expected = expectedCutoverBaseline();
    await withVerifiedMigrationTarget(async (sql) => {
      const actual = await sql`select id, hash, created_at from drizzle.__drizzle_migrations order by id`;
      if (!cutoverBaselineMatches(expected, actual)) {
        throw new PreflightConfigError(
          "Cutover baseline check failed: the target migration ledger is not exactly 0000-0072."
        );
      }
    });
    console.log("Cutover baseline check passed: target ledger is exactly 0000-0072.");
  } catch (error) {
    if (error instanceof PreflightConfigError) {
      console.error(error.message);
    } else {
      console.error(`Cutover baseline check failed (code: ${errorCode(error)}). Keep writers stopped and inspect the target without applying migrations.`);
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
