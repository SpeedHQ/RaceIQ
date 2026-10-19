import type { Client } from "@libsql/client/sqlite3";

interface MigrationIdentity {
  version: number;
  name: string;
}

export async function relocateMigrationHistory(
  client: Client,
  relocations: readonly { name: string; oldVersions: readonly number[]; version: number }[],
): Promise<void> {
  const tx = await client.transaction("write");
  try {
    for (const migration of relocations) {
      const oldVersions = migration.oldVersions.join(",");
      const previous = await tx.execute({
        sql: `SELECT version FROM schema_migrations WHERE version IN (${oldVersions}) AND name = ?`,
        args: [migration.name],
      });
      if (!previous.rows.length) continue;
      const existing = await tx.execute({ sql: "SELECT name FROM schema_migrations WHERE version = ?", args: [migration.version] });
      if (existing.rows.length && existing.rows[0]!.name !== migration.name) {
        throw new Error(`Migration history relocation conflict for "${migration.name}"`);
      }
      await tx.execute({
        sql: `INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
          SELECT ?, name, applied_at FROM schema_migrations
          WHERE version IN (${oldVersions}) AND name = ? ORDER BY version DESC LIMIT 1`,
        args: [migration.version, migration.name],
      });
      await tx.execute({
        sql: `DELETE FROM schema_migrations WHERE version IN (${oldVersions}) AND name = ?`,
        args: [migration.name],
      });
    }
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}
/** Select upgrades only after verifying that each stored version has the same identity. */
export function pendingMigrations<T extends MigrationIdentity>(
  migrations: readonly T[],
  applied: readonly MigrationIdentity[],
): T[] {
  const byVersion = new Map<number, T>();
  for (const migration of migrations) {
    if (byVersion.has(migration.version)) {
      throw new Error(`Duplicate migration version v${migration.version}`);
    }
    byVersion.set(migration.version, migration);
  }
  const appliedVersions = new Set<number>();
  for (const stored of applied) {
    const expected = byVersion.get(stored.version);
    if (!expected) {
      throw new Error(
        `Migration history conflict at v${stored.version}: database has "${stored.name}", ` +
        `this build does not recognize that migration version. Use the matching build or restore a compatible database. ` +
        `For disposable development data, back up and reset the database.`,
      );
    }
    if (expected.name !== stored.name) {
      throw new Error(
        `Migration history conflict at v${stored.version}: database has "${stored.name}", ` +
        `this build expects "${expected.name}". Use the matching build or restore a compatible database. ` +
        `For disposable development data, back up and reset the database.`,
      );
    }
    appliedVersions.add(stored.version);
  }
  return migrations.filter((migration) => !appliedVersions.has(migration.version))
    .sort((a, b) => a.version - b.version);
}
