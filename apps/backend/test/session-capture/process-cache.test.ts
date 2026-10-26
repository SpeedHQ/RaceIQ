import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { initServerGameAdapters } from "../../src/games/init";

let restore: (() => void) | undefined;
afterEach(() => restore?.());

test("process cache refreshes after successful and failed tasklist calls", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-process-cache-"));
  const script = join(directory, process.platform === "win32" ? "tasklist.cmd" : "tasklist");
  const modeFile = join(directory, "mode");
  writeFileSync(modeFile, "running");
  if (process.platform === "win32") {
    writeFileSync(script, `@echo off\r\nset /p mode=<"%RACEIQ_TEST_TASKLIST_MODE%"\r\nif "%mode%"=="running" echo "raceiqfake.exe","42"\r\nif "%mode%"=="absent" echo "other.exe","42"\r\nif "%mode%"=="failed" exit /b 1\r\n`);
  } else {
    writeFileSync(script, `#!/bin/sh\ncase "$(cat "$RACEIQ_TEST_TASKLIST_MODE")" in\n  running) printf '"raceiqfake.exe","42"\\n' ;;\n  absent) printf '"other.exe","42"\\n' ;;\n  failed) exit 1 ;;\nesac\n`);
    chmodSync(script, 0o755);
  }
  const oldPath = process.env.PATH;
  const oldModeFile = process.env.RACEIQ_TEST_TASKLIST_MODE;
  process.env.PATH = `${directory}${delimiter}${oldPath ?? ""}`;
  process.env.RACEIQ_TEST_TASKLIST_MODE = modeFile;
  restore = () => {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldModeFile === undefined) delete process.env.RACEIQ_TEST_TASKLIST_MODE;
    else process.env.RACEIQ_TEST_TASKLIST_MODE = oldModeFile;
    rmSync(directory, { recursive: true, force: true });
    restore = undefined;
  };

  // Load after PATH points at the isolated tasklist fixture; registry seeds its cache on import.
  initServerGameAdapters();
  const registry = await import("@raceiq/backend-core/games/registry");
  const gameId = "ac-evo";
  const originalAdapter = registry.getServerGame(gameId);
  registry.registerServerGame({ ...originalAdapter, processNames: ["raceiqfake.exe"] });
  const restoreEnvironment = restore;
  restore = () => {
    registry.registerServerGame(originalAdapter);
    restoreEnvironment?.();
  };
  const waitFor = async (expected: "running" | "absent" | "unknown"): Promise<void> => {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      registry.refreshProcessCache();
      // This integration test waits for real child_process callbacks from the fake tasklist executable.
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (registry.getGameProcessStatus(gameId) === expected) return;
    }
    expect(registry.getGameProcessStatus(gameId)).toBe(expected);
  };

  try {
    await waitFor("running");
    writeFileSync(modeFile, "absent");
    await waitFor("absent");
    writeFileSync(modeFile, "failed");
    await waitFor("unknown");
    writeFileSync(modeFile, "running");
    await waitFor("running");
  } finally {
    restore?.();
  }
});
