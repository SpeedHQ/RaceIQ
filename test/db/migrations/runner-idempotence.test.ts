import { describe, test, expect } from "bun:test";
import { migrations } from "../../../server/db/migrations";
import {
  bootstrap,
  getAppliedVersions,
  newClient,
  runMigrations,
} from "../../support/db/migrations";

describe("migration runner e2e", () => {
  test("fresh DB advances to latest in one pass", async () => {
    const client = newClient();
    await bootstrap(client);

    const applied = await runMigrations(client);
    expect(applied).toBe(migrations.length);

    const versions = await getAppliedVersions(client);
    const expected = migrations.map((m) => m.version).sort((a, b) => a - b);
    expect(versions).toEqual(expected);

    client.close();
  });

  test("re-running runner on up-to-date DB is a no-op", async () => {
    const client = newClient();
    await bootstrap(client);
    await runMigrations(client);

    const second = await runMigrations(client);
    expect(second).toBe(0);

    const third = await runMigrations(client);
    expect(third).toBe(0);

    client.close();
  });

  test("resumes from partially-migrated state", async () => {
    if (migrations.length < 2) return;

    const client = newClient();
    await bootstrap(client);

    // Apply only the first half manually, then let the runner finish.
    const cutoff = Math.floor(migrations.length / 2);
    const head = [...migrations].sort((a, b) => a.version - b.version).slice(0, cutoff);

    await client.execute("PRAGMA foreign_keys = OFF");
    for (const m of head) {
      for (const sql of m.sql) await client.execute(sql);
      await client.execute({
        sql: "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
        args: [m.version, m.name],
      });
    }
    await client.execute("PRAGMA foreign_keys = ON");

    const remaining = await runMigrations(client);
    expect(remaining).toBe(migrations.length - cutoff);

    const versions = await getAppliedVersions(client);
    expect(versions).toEqual(migrations.map((m) => m.version).sort((a, b) => a - b));

    client.close();
  });

  test("each migration applies in its own transaction without errors", async () => {
    const client = newClient();
    await bootstrap(client);

    await client.execute("PRAGMA foreign_keys = OFF");
    const ordered = [...migrations].sort((a, b) => a.version - b.version);
    for (const m of ordered) {
      await client.execute("BEGIN");
      try {
        for (const sql of m.sql) {
          try {
            await client.execute(sql);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!msg.includes("duplicate column name")) throw err;
          }
        }
        await client.execute("COMMIT");
      } catch (err) {
        await client.execute("ROLLBACK");
        throw new Error(`Migration v${m.version} (${m.name}) failed: ${(err as Error).message}`);
      }
    }
    await client.execute("PRAGMA foreign_keys = ON");

    client.close();
  });

  test("migration versions are unique and monotonic", () => {
    const versions = migrations.map((m) => m.version);
    const unique = new Set(versions);
    expect(unique.size).toBe(versions.length);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
  });
});
