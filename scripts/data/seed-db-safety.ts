import { client } from "../../server/db/index";
import { SEED_MARKER } from "./seed-db-options";

export async function countRows(table: string): Promise<number> {
  const result = await client.execute(`SELECT COUNT(*) AS count FROM ${table}`);
  return Number(result.rows[0]?.count ?? 0);
}

export async function seedRowCount(): Promise<number> {
  const result = await client.execute({
    sql: `SELECT
      (SELECT COUNT(*) FROM sessions WHERE notes LIKE ?) +
      (SELECT COUNT(*) FROM experiments WHERE notes LIKE ?) +
      (SELECT COUNT(*) FROM tunes WHERE source = ?) AS count`,
    args: [`%${SEED_MARKER}%`, `%${SEED_MARKER}%`, SEED_MARKER],
  });
  return Number(result.rows[0]?.count ?? 0);
}

export async function assertSafeTarget(force: boolean): Promise<void> {
  const seeded = await seedRowCount();
  if (seeded > 0) return;
  const counts = await Promise.all(["sessions", "laps", "tunes", "experiments"].map(countRows));
  const userRows = counts.reduce((sum, count) => sum + count, 0);
  if (userRows > 0 && !force) {
    throw new Error("Refusing to seed a database containing user data. Use DATA_DIR for a disposable database or pass --force.");
  }
}
