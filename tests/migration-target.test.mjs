import assert from "node:assert/strict";
import test from "node:test";
import { expectedCutoverBaseline, cutoverBaselineMatches } from "../scripts/check-cutover-baseline.mjs";
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

test("cutover guard accepts exactly the committed 0000-0072 ledger", () => {
  const expected = expectedCutoverBaseline();
  const actual = expected.map((entry, index) => ({ id: index + 1, ...entry }));
  assert.equal(expected.length, 73);
  assert.equal(cutoverBaselineMatches(expected, actual), true);
  assert.equal(cutoverBaselineMatches(expected, actual.slice(0, -1)), false);
  assert.equal(cutoverBaselineMatches(expected, [...actual, actual[0]]), false);
  assert.equal(cutoverBaselineMatches(expected, actual.map((entry, index) => index === 72 ? { ...entry, hash: "0".repeat(64) } : entry)), false);
  assert.equal(cutoverBaselineMatches(expected, actual.map((entry, index) => index === 10 ? { ...entry, id: 99 } : entry)), false);
});
