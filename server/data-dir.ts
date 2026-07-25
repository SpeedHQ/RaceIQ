import { USER_DATA_DIR } from "./paths";

/** True when running under `bun test` (Bun sets NODE_ENV=test automatically). */
const IS_TEST = process.env.NODE_ENV === "test" || !!process.env.BUN_TEST;

/**
 * Resolves the data directory for RaceIQ.
 * Delegates to USER_DATA_DIR from paths.ts.
 */
export function resolveDataDir(): string {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;

  // Safety net: tests perform unconditional table wipes. If a test run ever
  // reaches here, DATA_DIR was not set and we would hand back the real user
  // DB — fail loudly instead of silently destroying live data.
  if (IS_TEST) {
    throw new Error(
      "resolveDataDir(): refusing to return the real user data dir under test. " +
        "DATA_DIR is unset — check that bunfig.toml `[test].preload` includes " +
        "./test/setup-data-dir.ts, or set DATA_DIR explicitly.",
    );
  }

  return USER_DATA_DIR;
}
