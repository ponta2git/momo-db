import { sql } from "drizzle-orm";
import { check } from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

// Shared CHECK expressions for analysis headers and artifact resources.
// Table definitions and constraint names remain in the domain modules.
type SeriesAnalysisScopeColumns = {
  scopeKey: AnyPgColumn;
  scopeKind: AnyPgColumn;
  seasonMasterId: AnyPgColumn;
  mapMasterId: AnyPgColumn;
};

type SeriesAnalysisChunkColumns = {
  payload: AnyPgColumn;
  encodedBytes: AnyPgColumn;
  decodedBytes: AnyPgColumn;
  itemCount: AnyPgColumn;
  nestingDepth: AnyPgColumn;
  checksum: AnyPgColumn;
};

export function checkSeriesAnalysisScope(
  name: string,
  table: SeriesAnalysisScopeColumns
) {
  return check(
    name,
    sql`(${table.scopeKind} = 'overall' AND ${table.seasonMasterId} IS NULL AND ${table.mapMasterId} IS NULL AND ${table.scopeKey} = 'overall') OR (${table.scopeKind} = 'season' AND ${table.seasonMasterId} IS NOT NULL AND ${table.mapMasterId} IS NULL AND ${table.scopeKey} = 'season:' || ${table.seasonMasterId}) OR (${table.scopeKind} = 'map' AND ${table.seasonMasterId} IS NULL AND ${table.mapMasterId} IS NOT NULL AND ${table.scopeKey} = 'map:' || ${table.mapMasterId}) OR (${table.scopeKind} = 'season_map' AND ${table.seasonMasterId} IS NOT NULL AND ${table.mapMasterId} IS NOT NULL AND ${table.scopeKey} = 'season_map:' || ${table.seasonMasterId} || ':' || ${table.mapMasterId})`
  );
}

export function checkSeriesAnalysisChunk(
  name: string,
  table: SeriesAnalysisChunkColumns
) {
  return check(
    name,
    sql`${table.encodedBytes} >= 2 AND ${table.encodedBytes} = octet_length(${table.payload}) AND ${table.decodedBytes} = ${table.encodedBytes} AND ${table.itemCount} >= 0 AND ${table.nestingDepth} BETWEEN 1 AND 64 AND ${table.checksum} ~ '^sha256:[0-9a-f]{64}$'`
  );
}

export function checkSeriesAnalysisValidationContract(name: string, column: AnyPgColumn) {
  return check(
    name,
    sql`${column} IS NULL OR ${column} ~ '^[a-z0-9][a-z0-9._-]{0,127}$'`
  );
}

export function checkSeriesAnalysisValidationSchema(
  name: string,
  artifactSchemaVersion: AnyPgColumn,
  validationContractId: AnyPgColumn
) {
  return check(
    name,
    sql`(${validationContractId} IS DISTINCT FROM 'series-analysis-artifact-v2-full-validation-v1' OR ${artifactSchemaVersion} = 2)
      AND (${validationContractId} IS DISTINCT FROM 'series-analysis-artifact-v3-full-validation-v1' OR ${artifactSchemaVersion} = 3)
      AND (${validationContractId} IS DISTINCT FROM 'series-analysis-artifact-v4-full-validation-v1' OR ${artifactSchemaVersion} = 4)
      AND (${validationContractId} IS DISTINCT FROM 'series-analysis-artifact-v5-full-validation-v1' OR ${artifactSchemaVersion} = 5)
      AND (${validationContractId} IS DISTINCT FROM 'series-analysis-artifact-v6-full-validation-v1' OR ${artifactSchemaVersion} = 6)`
  );
}
