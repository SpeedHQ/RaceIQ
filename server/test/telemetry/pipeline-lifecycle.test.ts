import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

test("idle pipeline observers and maintenance do not require application feature composition", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "raceiq-idle-pipeline-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import { isSessionActive, lapDetector, flushSessionRecorder, flushSessionRecorderBuffer, stopMaintenanceTasks } from "./server/telemetry/live-pipeline";
      import { raceStrategyRuntime } from "./server/telemetry/race-strategy-ports";
      import { closeDb } from "./server/db/index";
      const snapshot = () => ({ active: isSessionActive(), session: lapDetector.session,
        fuel: lapDetector.fuelHistory, tires: lapDetector.tireWearHistory });
      const before = snapshot();
      await lapDetector.snapshotIncompleteLap();
      await lapDetector.finalizeCurrentSession();
      await flushSessionRecorder();
      flushSessionRecorderBuffer();
      // Exercise the real maintenance clock in an independent application runtime;
      // the parent test's fake timers cannot advance this process.
      await Bun.sleep(5_200);
      const after = snapshot();
      let unregistered = false;
      try { raceStrategyRuntime(); } catch { unregistered = true; }
      stopMaintenanceTasks();
      closeDb();
      console.log(JSON.stringify({ before, after, unregistered }));
    `], {
      cwd: resolve(import.meta.dir, "../../.."),
      env: { ...process.env, DATA_DIR: directory, RACEIQ_TEST_DATA_DIR: directory, RACEIQ_TEST_MODE: "1", RACEIQ_SETUP_HOME: resolve(directory, "setup-home") },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(code, stdout + stderr).toBe(0);
    const result = JSON.parse(stdout.trim());
    const idle = { active: false, session: null, fuel: [], tires: [] };
    expect(result).toEqual({ before: idle, after: idle, unregistered: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
