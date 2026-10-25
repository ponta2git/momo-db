import assert from "node:assert/strict";
import test from "node:test";
import { PreflightConfigError, readMigrationTarget, verifyMigrationTarget } from "../scripts/migration-target.mjs";

const directUrl = "postgresql://owner:never-log-this@ep-production.example/neondb?sslmode=require";
const target = {
  DIRECT_URL: directUrl,
  MOMO_DB_EXPECTED_DIRECT_HOST: "ep-production.example",
};

test("migration target requires the approved direct host and database without leaking the URL", () => {
  assert.equal(readMigrationTarget(target), directUrl);
  for (const candidate of [
    { ...target, MOMO_DB_EXPECTED_DIRECT_HOST: undefined },
    { ...target, MOMO_DB_EXPECTED_DIRECT_HOST: "ep-other.example" },
    { ...target, DIRECT_URL: directUrl.replace("ep-production", "ep-production-pooler") },
    { ...target, DIRECT_URL: directUrl.replace("/neondb", "/other_db") },
  ]) {
    assert.throws(() => readMigrationTarget(candidate), (error) => {
      assert.ok(error instanceof PreflightConfigError);
      assert.doesNotMatch(error.message, /never-log-this|ep-production\.example/);
      return true;
    });
  }
});

test("migration target verifies the database reported by the server", async () => {
  await verifyMigrationTarget(async () => [{ database_name: "neondb" }]);
  await assert.rejects(
    verifyMigrationTarget(async () => [{ database_name: "other_db" }]),
    PreflightConfigError
  );
});
