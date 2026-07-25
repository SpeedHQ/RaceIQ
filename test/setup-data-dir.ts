/**
 * Test preload — wired via bunfig.toml `[test].preload`, so it runs for EVERY
 * `bun test` invocation, including bare `bun test path/to/one.test.ts` that
 * bypasses the package.json `test` script.
 *
 * Why this exists: several suites do unconditional wipes (e.g.
 * `db.delete(tuningSessions)` in test/tuning-sessions.test.ts). Without
 * DATA_DIR set, server/data-dir.ts falls back to USER_DATA_DIR — the real
 * user DB — and those wipes destroy live tuning sessions.
 */
import { afterAll } from "bun:test";
import { resolve } from "node:path";

const TEST_DATA_DIR = resolve(import.meta.dir, "..", ".data-test");

if (!process.env.DATA_DIR) {
  process.env.DATA_DIR = TEST_DATA_DIR;
}

/**
 * Global teardown. `bun test` runs every suite in ONE process, and the libsql
 * client / pipeline maintenance interval are module-level singletons shared by
 * all of them. Closing either from a per-suite `afterAll` yanks the DB out from
 * under every file that runs later (with an in-memory DB that means the schema
 * itself disappears). So it happens exactly once, here, after the whole run —
 * otherwise those handles keep the process alive and the runner appears to hang
 * on whichever suite happened to finish last.
 *
 * Imports are dynamic and failure-tolerant: a run that never touched these
 * modules has nothing to tear down and must not pay to load them.
 */
afterAll(async () => {
  try {
    const { stopMaintenanceTasks } = await import("../server/pipeline");
    stopMaintenanceTasks();
  } catch {
    // pipeline never loaded — nothing to stop
  }
  try {
    const { client } = await import("../server/db/index");
    client.close();
  } catch {
    // db never loaded — nothing to close
  }
});
