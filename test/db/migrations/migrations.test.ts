import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrations } from "../../../server/db/migrations";
import * as schema from "../../../server/db/schema";

/**
 * Validates that migrations.ts produces a DB schema matching the Drizzle schema.
 * Catches drift where schema.ts is updated but no migration is added.
 */

type ColInfo = { name: string; type: string; notnull: number; dflt_value: string | null };
type IdxInfo = { name: string; sql: string | null };

function applyMigrations(db: Database) {
  for (const m of migrations) {
    for (const sql of m.sql) {
      try {
        db.exec(sql);
      } catch (error) {
        // Match the production runner: repeated ADD COLUMN statements are
        // intentionally tolerated so the merged v36/v37 histories converge.
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("duplicate column name")) throw error;
      }
    }
  }
}

function getTableColumns(db: Database, table: string): Map<string, ColInfo> {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as ColInfo[];
  return new Map(cols.map((c) => [c.name, c]));
}

function getTableNames(db: Database): string[] {
  const rows = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  return rows.map((r) => r.name).sort();
}

describe("migrations match schema", () => {
  // Map from Drizzle schema table definitions to expected table names
  const expectedTables: Record<string, Record<string, { columnName: string }>> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (value && typeof value === "object" && Symbol.for("drizzle:Name") in value) {
      const tableName = (value as any)[Symbol.for("drizzle:Name")];
      const columns: Record<string, { columnName: string }> = {};
      for (const [colKey, colVal] of Object.entries((value as any)[Symbol.for("drizzle:Columns")] ?? {})) {
        columns[colKey] = { columnName: (colVal as any).name };
      }
      expectedTables[tableName] = columns;
    }
  }

  test("all schema tables exist after migrations", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const tables = getTableNames(db);

    for (const tableName of Object.keys(expectedTables)) {
      expect(tables).toContain(tableName);
    }
    db.close();
  });

  test("all schema columns exist after migrations", () => {
    const db = new Database(":memory:");
    applyMigrations(db);

    const missing: string[] = [];
    for (const [tableName, columns] of Object.entries(expectedTables)) {
      const dbCols = getTableColumns(db, tableName);
      for (const col of Object.values(columns)) {
        if (!dbCols.has(col.columnName)) {
          missing.push(`${tableName}.${col.columnName}`);
        }
      }
    }

    if (missing.length > 0) {
      throw new Error(
        `Schema/migration drift detected! These columns are in schema.ts but not in migrations.ts:\n` +
        missing.map((m) => `  - ${m}`).join("\n") +
        `\n\nAdd a new migration to migrations.ts for these columns.`
      );
    }
    db.close();
  });

  test("migrations apply cleanly in order", () => {
    const db = new Database(":memory:");
    // Should not throw
    expect(() => applyMigrations(db)).not.toThrow();
    db.close();
  });
});
