import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { resolveDataDir } from "../server/data-dir";
import { isNewer } from "../server/version-compare";

describe("resolveDataDir", () => {
  let originalDataDir: string | undefined;

  beforeEach(() => {
    originalDataDir = process.env.DATA_DIR;
  });

  afterEach(() => {
    if (originalDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = originalDataDir;
    }
  });

  test("returns DATA_DIR env var when set", () => {
    process.env.DATA_DIR = "/custom/path";
    expect(resolveDataDir()).toBe("/custom/path");
  });

  test("throws instead of returning the real user data dir under test", () => {
    delete process.env.DATA_DIR;
    // Safety net: tests wipe tables unconditionally, so handing back the real
    // USER_DATA_DIR would destroy live data. Must fail loudly, not fall back.
    expect(() => resolveDataDir()).toThrow(/refusing to return the real user data dir/);
  });
});

describe("isNewer", () => {
  test("1.2.3 is newer than 1.2.2", () => {
    expect(isNewer("1.2.3", "1.2.2")).toBe(true);
  });

  test("1.3.0 is newer than 1.2.9", () => {
    expect(isNewer("1.3.0", "1.2.9")).toBe(true);
  });

  test("2.0.0 is newer than 1.9.9", () => {
    expect(isNewer("2.0.0", "1.9.9")).toBe(true);
  });

  test("same version is not newer", () => {
    expect(isNewer("1.2.3", "1.2.3")).toBe(false);
  });

  test("older version is not newer", () => {
    expect(isNewer("1.2.1", "1.2.3")).toBe(false);
  });
});
