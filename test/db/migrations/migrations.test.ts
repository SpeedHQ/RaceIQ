import { getTableName, type SQL } from "drizzle-orm";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { getTableConfig, SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { migrations } from "../../../server/db/migrations";
import * as schema from "../../../server/db/schema";

/**
 * Validates that migrations.ts produces a DB schema matching the Drizzle schema.
 * Catches drift where schema.ts is updated but no migration is added.
 */

type ColInfo = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};
type IndexListInfo = {
  name: string;
  unique: number;
  origin: string;
  partial: number;
};
type IndexColumnInfo = { seqno: number; name: string | null };
type ForeignKeyInfo = {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
};
type ExpectedColumn = {
  name: string;
  type: string;
  notNull: boolean;
  primary: boolean;
  defaultValue?: string;
};
type ExpectedIndex = {
  name: string;
  columns: string[];
  unique: boolean;
  partial: boolean;
  named: boolean;
};
type ExpectedForeignKey = {
  name: string;
  columns: string[];
  foreignTable: string;
  foreignColumns: string[];
  onUpdate: string;
  onDelete: string;
};
type ExpectedTable = {
  columns: Map<string, ExpectedColumn>;
  indexes: ExpectedIndex[];
  foreignKeys: ExpectedForeignKey[];
};
type ExpectedSchema = Map<string, ExpectedTable>;
type ActualIndex = Omit<ExpectedIndex, "named"> & { origin: string };
type ActualForeignKey = Omit<ExpectedForeignKey, "name">;

const sqliteDialect = new SQLiteSyncDialect();

// SQLite cannot add this historical FK with ALTER TABLE. schema.ts documents
// type-level intent, while migration v25 deliberately leaves runtime enforcement absent.
const SCHEMA_ONLY_FOREIGN_KEYS = new Set([
  "laps_experiment_id_experiments_id_fk",
]);

// CHECK constraints have no normalized PRAGMA surface. These checks intentionally
// live only in migration DDL because Drizzle text refinements and numeric TS types
// do not emit equivalent SQLite constraints. Keep this list explicit when adding
// migration-only checks; named race_events checks declared in schema.ts are not listed.
const MIGRATION_ONLY_CHECKS = [
  "driver_profile_runs.status domain",
  "race_events.evidence_kind domain",
  "race_events.confidence domain",
  "race_events.quality_state domain",
  "session_runs.run_kind domain",
  "session_runs.status domain",
  "session_runs.opening_phase domain",
  "session_runs.timeline_epoch nonnegative",
  "session_runs.opening_sequence nonnegative",
  "session_runs.opening_event_order nonnegative",
  "session_runs.opening_confidence domain",
  "session_runs.opening_evidence_kind domain",
  "session_runs.closing_confidence domain",
  "session_runs.closing_evidence_kind domain",
  "session_runs.closing boundary completeness",
  "session_runs.source time order",
  "session_runs.start_track_distance_pct range",
  "session_runs.end_track_distance_pct range",
] as const;

function applyMigrations(db: Database) {
  for (const migration of migrations) {
    for (const sql of migration.sql) {
      try {
        db.exec(sql);
      } catch (error) {
        // Match production runner: repeated ADD COLUMN statements are
        // intentionally tolerated so merged v36/v37 histories converge.
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("duplicate column name")) throw error;
      }
    }
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function getTableColumns(db: Database, table: string): Map<string, ColInfo> {
  const columns = db.query(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as ColInfo[];
  return new Map(columns.map((column) => [column.name, column]));
}

function getTableNames(db: Database): string[] {
  const rows = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  return rows.map((row) => row.name).sort();
}

function hasWrappingParentheses(value: string): boolean {
  if (!value.startsWith("(") || !value.endsWith(")")) return false;
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote) {
        if (value[index + 1] === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth === 0 && index < value.length - 1) return false;
  }
  return depth === 0;
}

function normalizeDefault(value: string | null): string | null {
  if (value == null) return null;
  let normalized = value.trim();
  while (hasWrappingParentheses(normalized)) normalized = normalized.slice(1, -1).trim();
  if (
    normalized.length >= 2 &&
    ((normalized.startsWith("'") && normalized.endsWith("'")) ||
      (normalized.startsWith('"') && normalized.endsWith('"')))
  ) {
    const quote = normalized[0];
    const body = normalized.slice(1, -1).replaceAll(`${quote}${quote}`, quote);
    return `text:${body}`;
  }
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) {
    return `number:${Number(normalized)}`;
  }
  return `sql:${normalized.replace(/\s+/g, " ").toLowerCase()}`;
}

function expectedDefault(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return `text:${value}`;
  if (typeof value === "boolean") return `number:${value ? 1 : 0}`;
  if (typeof value === "number" || typeof value === "bigint") return `number:${String(value)}`;
  return normalizeDefault(sqliteDialect.sqlToQuery(value as SQL).sql) ?? undefined;
}

function normalizeAction(action: string | undefined): string {
  return (action ?? "NO ACTION").replaceAll("_", " ").toUpperCase();
}

function indexColumnName(column: unknown): string {
  if (column && typeof column === "object" && "name" in column && typeof column.name === "string") {
    return column.name;
  }
  throw new Error("Drizzle index contains an expression unsupported by PRAGMA index_info parity");
}

function collectExpectedSchema(): ExpectedSchema {
  const expected: ExpectedSchema = new Map();
  for (const value of Object.values(schema)) {
    if (!value || typeof value !== "object" || !(Symbol.for("drizzle:Name") in value)) continue;
    const config = getTableConfig(value as Parameters<typeof getTableConfig>[0]);
    const primaryColumns = new Set(
      config.primaryKeys.flatMap((primaryKey) => primaryKey.columns.map((column) => column.name)),
    );
    const columns = new Map(
      config.columns.map((column) => [
        column.name,
        {
          name: column.name,
          type: column.getSQLType().trim().replace(/\s+/g, " ").toUpperCase(),
          notNull: column.notNull,
          primary: column.primary || primaryColumns.has(column.name),
          defaultValue: expectedDefault(column.default),
        },
      ]),
    );
    const indexes: ExpectedIndex[] = [
      ...config.indexes.map((index) => ({
        name: index.config.name ?? `${config.name}_${index.config.columns.map(indexColumnName).join("_")}_idx`,
        columns: index.config.columns.map(indexColumnName),
        unique: Boolean(index.config.unique),
        partial: index.config.where != null,
        named: true,
      })),
      ...config.uniqueConstraints.map((index) => ({
        name: index.getName() ?? `${config.name}_${index.columns.map((column) => column.name).join("_")}_unique`,
        columns: index.columns.map((column) => column.name),
        unique: true,
        partial: false,
        named: false,
      })),
      ...config.primaryKeys.map((index) => ({
        name: index.getName() ?? `${config.name}_${index.columns.map((column) => column.name).join("_")}_pk`,
        columns: index.columns.map((column) => column.name),
        unique: true,
        partial: false,
        named: false,
      })),
      ...config.columns
        .filter((column) => column.isUnique)
        .map((column) => ({
          name: column.uniqueName ?? `${config.name}_${column.name}_unique`,
          columns: [column.name],
          unique: true,
          partial: false,
          named: false,
        })),
    ];
    const foreignKeys = config.foreignKeys
      .filter((foreignKey) => !SCHEMA_ONLY_FOREIGN_KEYS.has(foreignKey.getName()))
      .map((foreignKey): ExpectedForeignKey => {
        const reference = foreignKey.reference();
        return {
          name: foreignKey.getName(),
          columns: reference.columns.map((column) => column.name),
          foreignTable: getTableName(reference.foreignTable),
          foreignColumns: reference.foreignColumns.map((column) => column.name),
          onUpdate: normalizeAction(foreignKey.onUpdate),
          onDelete: normalizeAction(foreignKey.onDelete),
        };
      });
    expected.set(config.name, { columns, indexes, foreignKeys });
  }
  return expected;
}

const EXPECTED_SCHEMA = collectExpectedSchema();

function getActualIndexes(db: Database, table: string): ActualIndex[] {
  const indexes = db.query(`PRAGMA index_list(${quoteIdentifier(table)})`).all() as IndexListInfo[];
  return indexes.map((index) => {
    const columns = db.query(`PRAGMA index_info(${quoteIdentifier(index.name)})`).all() as IndexColumnInfo[];
    columns.sort((left, right) => left.seqno - right.seqno);
    return {
      name: index.name,
      columns: columns.map((column) => column.name ?? "<expression>"),
      unique: index.unique === 1,
      partial: index.partial === 1,
      origin: index.origin,
    };
  });
}

function getActualForeignKeys(db: Database, table: string): ActualForeignKey[] {
  const rows = db.query(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`).all() as ForeignKeyInfo[];
  const groups = new Map<number, ForeignKeyInfo[]>();
  for (const row of rows) {
    const group = groups.get(row.id) ?? [];
    group.push(row);
    groups.set(row.id, group);
  }
  return [...groups.values()].map((group) => {
    group.sort((left, right) => left.seq - right.seq);
    return {
      columns: group.map((row) => row.from),
      foreignTable: group[0].table,
      foreignColumns: group.map((row) => row.to),
      onUpdate: normalizeAction(group[0].on_update),
      onDelete: normalizeAction(group[0].on_delete),
    };
  });
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function getTableParityIssues(db: Database, expectedNames: Iterable<string> = EXPECTED_SCHEMA.keys()): string[] {
  const expected = new Set(expectedNames);
  const actual = new Set(getTableNames(db));
  const issues: string[] = [];
  for (const table of [...expected].sort()) {
    if (!actual.has(table)) issues.push(`table ${table}: present in schema.ts but missing from migrations.ts`);
  }
  for (const table of [...actual].sort()) {
    if (!expected.has(table)) issues.push(`table ${table}: present in migrations.ts but absent from schema.ts`);
  }
  return issues;
}

function formatIndex(index: ExpectedIndex | ActualIndex): string {
  return `${index.unique ? "UNIQUE " : ""}INDEX (${index.columns.join(", ")}) partial=${index.partial}`;
}

function formatForeignKey(foreignKey: ExpectedForeignKey | ActualForeignKey): string {
  return `(${foreignKey.columns.join(", ")}) -> ${foreignKey.foreignTable}(${foreignKey.foreignColumns.join(", ")}) ON UPDATE ${foreignKey.onUpdate} ON DELETE ${foreignKey.onDelete}`;
}

function getSchemaParityIssues(db: Database, expected: ExpectedSchema = EXPECTED_SCHEMA): string[] {
  const issues = getTableParityIssues(db, expected.keys());
  const actualTables = new Set(getTableNames(db));
  for (const [tableName, table] of expected) {
    if (!actualTables.has(tableName)) continue;
    const actualColumns = getTableColumns(db, tableName);
    for (const column of table.columns.values()) {
      const actual = actualColumns.get(column.name);
      if (!actual) {
        issues.push(`column ${tableName}.${column.name}: present in schema.ts but missing from migrations.ts`);
        continue;
      }
      const actualType = actual.type.trim().replace(/\s+/g, " ").toUpperCase();
      if (actualType !== column.type) {
        issues.push(`column ${tableName}.${column.name}: type expected ${column.type}, got ${actualType || "<empty>"}`);
      }
      const actualNotNull = actual.notnull === 1 || actual.pk > 0;
      if (actualNotNull !== column.notNull) {
        issues.push(`column ${tableName}.${column.name}: notnull expected ${column.notNull}, got ${actualNotNull}`);
      }
      const actualPrimary = actual.pk > 0;
      if (actualPrimary !== column.primary) {
        issues.push(`column ${tableName}.${column.name}: primary expected ${column.primary}, got ${actualPrimary}`);
      }
      if (column.defaultValue !== undefined) {
        const actualDefault = normalizeDefault(actual.dflt_value);
        if (actualDefault !== column.defaultValue) {
          issues.push(`column ${tableName}.${column.name}: default expected ${column.defaultValue}, got ${actualDefault ?? "<none>"}`);
        }
      }
    }
    for (const columnName of actualColumns.keys()) {
      if (!table.columns.has(columnName)) {
        issues.push(`column ${tableName}.${columnName}: present in migrations.ts but absent from schema.ts`);
      }
    }

    const actualIndexes = getActualIndexes(db, tableName);
    for (const expectedIndex of table.indexes) {
      const actualIndex = expectedIndex.named
        ? actualIndexes.find((index) => index.name === expectedIndex.name)
        : actualIndexes.find(
            (index) =>
              index.unique === expectedIndex.unique &&
              index.partial === expectedIndex.partial &&
              sameStrings(index.columns, expectedIndex.columns),
          );
      if (
        !actualIndex ||
        actualIndex.unique !== expectedIndex.unique ||
        actualIndex.partial !== expectedIndex.partial ||
        !sameStrings(actualIndex.columns, expectedIndex.columns)
      ) {
        issues.push(
          `index ${tableName}.${expectedIndex.name}: expected ${formatIndex(expectedIndex)}, got ${actualIndex ? `${actualIndex.name} ${formatIndex(actualIndex)}` : "missing"}`,
        );
      }
    }

    const actualForeignKeys = getActualForeignKeys(db, tableName);
    for (const expectedForeignKey of table.foreignKeys) {
      const actualForeignKey = actualForeignKeys.find(
        (foreignKey) =>
          sameStrings(foreignKey.columns, expectedForeignKey.columns) &&
          foreignKey.foreignTable === expectedForeignKey.foreignTable &&
          sameStrings(foreignKey.foreignColumns, expectedForeignKey.foreignColumns),
      );
      if (
        !actualForeignKey ||
        actualForeignKey.onUpdate !== expectedForeignKey.onUpdate ||
        actualForeignKey.onDelete !== expectedForeignKey.onDelete
      ) {
        issues.push(
          `foreign key ${tableName}.${expectedForeignKey.name}: expected ${formatForeignKey(expectedForeignKey)}, got ${actualForeignKey ? formatForeignKey(actualForeignKey) : "missing"}`,
        );
      }
    }
  }
  return issues;
}

function assertNoParityIssues(issues: readonly string[]): void {
  if (issues.length === 0) return;
  throw new Error(
    `Schema/migration drift detected:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`,
  );
}

describe("migrations match schema", () => {
  test("schema and migration tables match in both directions", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    assertNoParityIssues(getTableParityIssues(db));
    db.close();
  });

  test("reports a migration-only table", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    db.exec("CREATE TABLE migration_only_fixture (id INTEGER PRIMARY KEY)");
    expect(getTableParityIssues(db)).toContain(
      "table migration_only_fixture: present in migrations.ts but absent from schema.ts",
    );
    db.close();
  });

  test("column, default, index, and foreign-key semantics match", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    assertNoParityIssues(getSchemaParityIssues(db));
    db.close();
  });

  test("reports actionable DDL semantic mismatches", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE parents (id INTEGER PRIMARY KEY);
      CREATE TABLE fixture_records (
        id TEXT PRIMARY KEY,
        parent_id INTEGER NOT NULL DEFAULT 9,
        FOREIGN KEY (parent_id) REFERENCES parents(id)
      );
      CREATE INDEX wrong_parent_idx ON fixture_records(parent_id);
    `);
    const expected: ExpectedSchema = new Map([
      [
        "parents",
        {
          columns: new Map([
            ["id", { name: "id", type: "INTEGER", notNull: true, primary: true }],
          ]),
          indexes: [],
          foreignKeys: [],
        },
      ],
      [
        "fixture_records",
        {
          columns: new Map([
            ["id", { name: "id", type: "INTEGER", notNull: true, primary: true }],
            [
              "parent_id",
              {
                name: "parent_id",
                type: "INTEGER",
                notNull: true,
                primary: false,
                defaultValue: "number:0",
              },
            ],
          ]),
          indexes: [
            {
              name: "expected_parent_idx",
              columns: ["parent_id"],
              unique: false,
              partial: false,
              named: true,
            },
          ],
          foreignKeys: [
            {
              name: "fixture_records_parent_fk",
              columns: ["parent_id"],
              foreignTable: "parents",
              foreignColumns: ["id"],
              onUpdate: "NO ACTION",
              onDelete: "CASCADE",
            },
          ],
        },
      ],
    ]);

    const issues = getSchemaParityIssues(db, expected);
    expect(() => assertNoParityIssues(issues)).toThrow("Schema/migration drift detected");
    expect(issues).toContain("column fixture_records.id: type expected INTEGER, got TEXT");
    expect(issues).toContain("column fixture_records.parent_id: default expected number:0, got number:9");
    expect(issues).toContain(
      "index fixture_records.expected_parent_idx: expected INDEX (parent_id) partial=false, got missing",
    );
    expect(issues).toContain(
      "foreign key fixture_records.fixture_records_parent_fk: expected (parent_id) -> parents(id) ON UPDATE NO ACTION ON DELETE CASCADE, got (parent_id) -> parents(id) ON UPDATE NO ACTION ON DELETE NO ACTION",
    );
    db.close();
  });

  test("documents migration-only CHECK constraints outside PRAGMA parity", () => {
    expect(MIGRATION_ONLY_CHECKS).toContain("driver_profile_runs.status domain");
    expect(MIGRATION_ONLY_CHECKS).toContain("race_events.evidence_kind domain");
    expect(MIGRATION_ONLY_CHECKS).toContain("session_runs.closing boundary completeness");
  });

  test("migrations apply cleanly in order", () => {
    const db = new Database(":memory:");
    expect(() => applyMigrations(db)).not.toThrow();
    db.close();
  });
});
