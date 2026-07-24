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
import { resolve } from "node:path";

const TEST_DATA_DIR = resolve(import.meta.dir, "..", ".data-test");

if (!process.env.DATA_DIR) {
  process.env.DATA_DIR = TEST_DATA_DIR;
}
