/**
 * Test preload — wired via bunfig.toml `[test].preload`, so it runs for EVERY
 * `bun test` invocation, including bare single-file runs.
 *
 * Each process owns an isolated temporary database unless the suite runner
 * explicitly supplies RACEIQ_TEST_DATA_DIR. Never use an inherited DATA_DIR:
 * test maintenance may delete captures missing from the test database.
 */
import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

async function setupDataDir() {
  const releaseEnvironment = await Bun.file(resolve(import.meta.dir, "../..", ".env.development")).text();
for (const line of releaseEnvironment.split(/\r?\n/)) {
  const separator = line.indexOf("=");
  if (separator < 1) continue;
  const name = line.slice(0, separator);
  if (!["RACEIQ_FEATURE_F1_EXPERIMENTS", "RACEIQ_FEATURE_IRACING_ADAPTER"].includes(name)) continue;
  process.env[name] = line.slice(separator + 1);
}

// Each Bun process gets its own database. The suite runner passes its isolated
// directory explicitly; standalone `bun test` runs allocate one here.
const ownsTestDataDir = !process.env.RACEIQ_TEST_DATA_DIR;
const TEST_DATA_DIR = ownsTestDataDir
  ? mkdtempSync(resolve(tmpdir(), "raceiq-test-"))
  : resolve(process.env.RACEIQ_TEST_DATA_DIR!);
process.env.RACEIQ_TEST_MODE = "1";
process.env.DATA_DIR = TEST_DATA_DIR;

mkdirSync(process.env.DATA_DIR, { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) {
  try {
    rmSync(resolve(process.env.DATA_DIR, `test.db${suffix}`), {
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
  }
}
// Start each run from valid settings, even after an interrupted test left
// behind an intentionally invalid fixture value in an explicit test directory.
writeFileSync(resolve(process.env.DATA_DIR, "settings.json"), "{}\n");

/**
 * Run DB setup (PRAGMAs, migrations, backfills) exactly once, before any suite
 * loads. This import MUST stay dynamic and MUST stay below the DATA_DIR
 * assignment above — server/db/index.ts resolves its data directory at import
 * time, so hoisting it to a static import would bind the real user DB path.
 *
 * Bun awaits the preload module, so suites only start once the DB is ready.
 * This is the one place a top-level await on DB setup is safe: it is a single
 * controlled entry point, not something every importer of `db` pays for.
 */
const { initDb } = await import("../../server/db/index");
await initDb();

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
    const { stopMaintenanceTasks } = await import("../../server/telemetry/live-pipeline");
    stopMaintenanceTasks();
  } catch {
    // pipeline never loaded — nothing to stop
  }
  try {
    const { client } = await import("../../server/db/index");
    client.close();
  } catch {
    // db never loaded — nothing to close
  }
  if (ownsTestDataDir) rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});
}

if (process.env.RACEIQ_UNIT_TESTS !== "1") await setupDataDir();
