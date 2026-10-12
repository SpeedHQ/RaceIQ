interface MigrationIdentity {
  version: number;
  name: string;
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
    if (expected && expected.name !== stored.name) {
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
