import { describe, test, expect } from "bun:test";
import { isMastraSignalMigrationRequiredError } from "../server/ai/agents";

describe("isMastraSignalMigrationRequiredError", () => {
  test("matches duckdb migration error id", () => {
    const err = new Error("id: MASTRA_STORAGE_DUCKDB_MIGRATION_REQUIRED_SIGNAL_TABLES");
    expect(isMastraSignalMigrationRequiredError(err)).toBe(true);
  });

  test("matches duckdb migration banner text", () => {
    const err = new Error("MIGRATION REQUIRED: DuckDB observability signal tables need signal IDs");
    expect(isMastraSignalMigrationRequiredError(err)).toBe(true);
  });

  test("does not match unrelated errors", () => {
    expect(isMastraSignalMigrationRequiredError(new Error("boom"))).toBe(false);
    expect(isMastraSignalMigrationRequiredError("boom")).toBe(false);
  });
});
