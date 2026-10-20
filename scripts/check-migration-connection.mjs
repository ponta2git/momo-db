import { errorCode, PreflightConfigError, withVerifiedMigrationTarget } from "./migration-target.mjs";

try {
  await withVerifiedMigrationTarget();
  console.log("Migration database preflight passed.");
} catch (error) {
  if (error instanceof PreflightConfigError) {
    console.error(error.message);
  } else {
    console.error(
      `Migration database preflight failed (code: ${errorCode(error)}). ` +
        "Verify that the CI Actions DIRECT_URL secret targets the current Neon production branch."
    );
  }
  process.exitCode = 1;
}
