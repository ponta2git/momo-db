import { customType } from "drizzle-orm/pg-core";

// Internal PostgreSQL column types; not part of the package export surface.
export const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType() {
    return "bytea";
  }
});
