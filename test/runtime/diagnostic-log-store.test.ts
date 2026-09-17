import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
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
});
