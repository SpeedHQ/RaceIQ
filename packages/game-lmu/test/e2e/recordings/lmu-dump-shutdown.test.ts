import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readLMUFrames } from "@raceiq/capture-formats/lmu/dump";
import { decodeLMUSourceFrame } from "@raceiq/capture-formats/lmu/source-frame";
import { LMU_TELEMETRY } from "@raceiq/capture-formats/lmu/layout";
import { killAndWait, removeProcessDirectory } from "@raceiq/backend/test-support/process";
import { fixturePath } from "../../support/fixtures";

let dataDir: string | null = null;
let server: ChildProcess | null = null;
afterEach(async () => {
  if (server) {
    await killAndWait(server, "SIGINT");
    server = null;
  }
  if (dataDir) {
    await removeProcessDirectory(dataDir);
    dataDir = null;
  }
});
  for (const ending of ["interrupt", "early-interrupt", "client-failure"] as const) {
    test(`managed LMU dump finalizes count and saved path on ${ending}`, async () => {
      dataDir = mkdtempSync(join(tmpdir(), "raceiq-lmu-managed-close-"));
      const fixture = fixturePath("lmu-dump-launcher.ts");
      server = spawn(process.execPath, ["run", fixture, ...(ending === "client-failure" ? ["--client-failure"] : [])], {
        env: { ...process.env, DATA_DIR: dataDir },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      let output = "";
      const ready = Promise.withResolvers<void>();
      const marker = ending === "early-interrupt" ? "[E2E] Dump launcher ready" : "[E2E] LMU dump admitted 32 frames:";
      // This deadline bounds a separate process; runner fake timers cannot advance its startup.
      const timeout = setTimeout(() => ready.reject(new Error(`LMU launcher did not become ready:\n${output}`)), 20_000);
      server.stdout!.on("data", chunk => {
        output += String(chunk);
        if (output.includes(marker)) ready.resolve();
      });
      server.stderr!.on("data", chunk => { output += String(chunk); });
      const exited = Promise.withResolvers<number | null>();
      server.once("exit", code => { exited.resolve(code); if (ending !== "client-failure" && !output.includes(marker)) ready.reject(new Error(`Launcher exited ${code}:\n${output}`)); });
      try {
        if (ending === "client-failure") {
          expect(await exited.promise).toBe(7);
        } else {
          await ready.promise;
          await killAndWait(server, "SIGINT");
          expect(server.exitCode).toBe(0);
        }
        server = null;
        const files = readdirSync(dataDir).filter(file => file.endsWith(".bin"));
        expect(files).toHaveLength(1);
        const file = join(dataDir, files[0]!);
        const bytes = readFileSync(file);
        const frames = readLMUFrames(file).map(frame => decodeLMUSourceFrame(frame)!);
        expect(bytes.readUInt32LE(12)).toBe(frames.length);
        if (ending === "interrupt") {
          expect(frames.map(frame => frame.telemetry.readDoubleLE(LMU_TELEMETRY.engineRpm))).toEqual(Array.from({ length: 32 }, (_, index) => 5100 + index));
          expect(frames.map(frame => frame.telemetry.readDoubleLE(LMU_TELEMETRY.elapsedTime))).toEqual(Array.from({ length: 32 }, (_, index) => index + 1));
        }
        expect(output).toContain(`[LMU Recorder] Saved ${frames.length} frames to ${file}`);
        expect(output).not.toContain("shutdown failed");
      } finally { clearTimeout(timeout); }
    }, 40_000);
  }
