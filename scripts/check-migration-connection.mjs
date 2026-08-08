import postgres from "postgres";

class PreflightConfigError extends Error {}

function readDirectUrl() {
  const value = process.env.DIRECT_URL;
  if (!value) {
    throw new PreflightConfigError(
      "Migration database preflight failed: DIRECT_URL is not configured."
    );
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new PreflightConfigError(
      "Migration database preflight failed: DIRECT_URL is not a valid URL."
    );
  }

  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new PreflightConfigError(
      "Migration database preflight failed: DIRECT_URL must use the postgres protocol."
    );
  }

  if (parsed.hostname.includes("-pooler.")) {
    throw new PreflightConfigError(
      "Migration database preflight failed: DIRECT_URL must use a Neon direct endpoint, not a pooled endpoint."
    );
  }

  return value;
}

function errorCode(error) {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z0-9_]+$/.test(error.code)
  ) {
    return error.code;
  }

  return "UNKNOWN";
}

let sql;

try {
  const directUrl = readDirectUrl();
  sql = postgres(directUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 2
  });

  await sql`select 1 as connection_check`;
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
} finally {
  if (sql) {
    try {
      await sql.end({ timeout: 1 });
    } catch {
      // The original connectivity result is the actionable signal. Never print connection details.
    }
  }
}
