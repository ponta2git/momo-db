import postgres from "postgres";

export class PreflightConfigError extends Error {}

const databaseName = "neondb";

export function readMigrationTarget(env = process.env) {
  if (!env.DIRECT_URL) {
    throw new PreflightConfigError(
      "Migration database preflight failed: DIRECT_URL is not configured."
    );
  }

  let parsed;
  try {
    parsed = new URL(env.DIRECT_URL);
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

  const expectedHost = env.MOMO_DB_EXPECTED_DIRECT_HOST?.toLowerCase();
  if (!expectedHost || !/^[a-z0-9.-]+$/.test(expectedHost)) {
    throw new PreflightConfigError(
      "Migration database preflight failed: MOMO_DB_EXPECTED_DIRECT_HOST is not configured as a hostname."
    );
  }

  if (parsed.hostname !== expectedHost) {
    throw new PreflightConfigError(
      "Migration database preflight failed: DIRECT_URL does not target the approved direct endpoint."
    );
  }

  if (parsed.pathname !== `/${databaseName}`) {
    throw new PreflightConfigError(
      "Migration database preflight failed: DIRECT_URL does not target the approved database."
    );
  }

  return env.DIRECT_URL;
}

export async function verifyMigrationTarget(sql) {
  const [result] = await sql`select current_database() as database_name`;
  if (result?.database_name !== databaseName) {
    throw new PreflightConfigError(
      "Migration database preflight failed: the connected database is not the approved database."
    );
  }
}

export async function withVerifiedMigrationTarget(check = async () => {}) {
  const directUrl = readMigrationTarget();
  const sql = postgres(directUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 2,
    connection: { statement_timeout: 10000, application_name: "momo-db-migration-preflight" },
  });

  try {
    await sql`set default_transaction_read_only = on`;
    await verifyMigrationTarget(sql);
    await check(sql);
  } finally {
    try {
      await sql.end({ timeout: 1 });
    } catch {
      // The original result is the actionable signal. Never print connection details.
    }
  }
}

export function errorCode(error) {
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
