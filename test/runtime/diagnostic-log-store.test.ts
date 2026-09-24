import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDiagnosticLogStore } from "../../server/runtime/diagnostic-log-store";

describe("diagnostic log store", () => {
  test("preserves restart markers and oversized lines", () => {
    const directory = mkdtempSync(join(tmpdir(), "raceiq-log-"));
    let clock = Date.parse("2026-01-01T00:00:00.000Z");
    const store = createDiagnosticLogStore({ directory, now: () => clock, maxFileBytes: 32 });
    store.startRun(); store.write("first\n"); store.write("x".repeat(64) + "\n");
    clock += 1_000;
    createDiagnosticLogStore({ directory, now: () => clock, maxFileBytes: 32 }).startRun();
    const text = createDiagnosticLogStore({ directory, now: () => clock, maxFileBytes: 32 }).readRetainedText();
    expect(text).toContain("RaceIQ started");
    expect(text).toContain("first");
    expect(text).toContain("x".repeat(64));
  });

  test("retains more than 64 rotations across restarts and prunes only expired files", () => {
    const directory = mkdtempSync(join(tmpdir(), "raceiq-retention-"));
    const clock = Date.now();
    const options = { directory, now: () => clock, maxFileBytes: 32 };
    try {
      const store = createDiagnosticLogStore(options);
      store.write("recent-sentinel\n");
      for (let i = 0; i < 66; i++) store.write(`rotation-${i}-${"x".repeat(32)}\n`);
      expect(store.readRetainedText()).toContain("recent-sentinel");
      const rotatedPaths = readdirSync(directory)
        .filter((name) => name !== "raceiq.log")
        .map((name) => join(directory, name));
      const recent = rotatedPaths[0];
      const expired = rotatedPaths[1];
      utimesSync(recent, new Date(clock - 24 * 60 * 60 * 1000), new Date(clock - 24 * 60 * 60 * 1000));
      utimesSync(expired, new Date(clock - 26 * 60 * 60 * 1000), new Date(clock - 26 * 60 * 60 * 1000));
      const restarted = createDiagnosticLogStore(options);
      restarted.startRun();
      expect(existsSync(recent)).toBe(true);
      expect(existsSync(expired)).toBe(false);
      expect(restarted.readRetainedText()).toContain("rotation-65-");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
