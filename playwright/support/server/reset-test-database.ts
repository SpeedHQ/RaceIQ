import { rmSync } from "node:fs";
import { join } from "node:path";

const DATABASE_FILES = [
  "app.db",
  "app.db-wal",
  "app.db-shm",
  "app.db.dashboard-access",
  "test.db",
  "test.db-wal",
  "test.db-shm",
  "test.db.dashboard-access",
  "chat-memory.db",
  "chat-memory.db-wal",
  "chat-memory.db-shm",
];

export function resetTestDatabase(dataDir: string): void {
  const segments = dataDir.split(/[\\/]+/);
  if (!segments.some((segment) => segment.includes("test-data"))) {
    throw new Error(`Refusing to delete database outside a test-data directory: "${dataDir}"`);
  }
  for (const file of DATABASE_FILES) rmSync(join(dataDir, file), { force: true });
}
