import { describe, test, expect } from "bun:test";
import { parseDump } from "./helpers/parse-dump";
import { existsSync, readdirSync } from "fs";
import { join } from "path";

const RECORDINGS_DIR = "test/artifacts/laps";

function getRecording(filename: string): string | null {
  const recordingPath = join(RECORDINGS_DIR, filename);
  return existsSync(recordingPath) ? recordingPath : null;
}

describe("ACC recording", () => {
  describe("acc-2026-04-09T18-56-49-633Z.bin", () => {
    const recordingFile = "acc-2026-04-09T18-56-49-633Z.bin";

    test("detects laps correctly", async () => {
      const recording = getRecording(recordingFile);
      if (!recording) {
        console.log(`Recording not found: ${recordingFile}`);
        return;
      }

      console.log(`Using: ${recording}`);
      const { laps, sessions, carModel, trackName } = await parseDump("acc", recording);
      console.log(`Detected ${laps.length} lap(s)`);
      for (const lap of laps) {
        const mins = Math.floor(lap.lapTime / 60);
        const secs = (lap.lapTime % 60).toFixed(3);
        console.log(
          `  Lap ${lap.lapNumber}: ${mins}:${secs.padStart(6, "0")} valid=${lap.isValid}${lap.invalidReason ? ` (${lap.invalidReason})` : ""}`
        );
      }

      expect(laps.length).toBe(4);

      // Session metadata
      expect(carModel).toBe("mclaren_720s_gt3_evo");
      expect(trackName).toBe("brands_hatch");

      // Lap 0: joining lap — invalid
      expect(laps[0].isValid).toBe(false);
      expect(laps[0].invalidReason).toBe("telemetry distance too short");

      // Lap 1: first full lap — valid
      expect(laps[1].isValid).toBe(true);

      // Lap 2: second full lap — valid
      expect(laps[2].isValid).toBe(true);

      // Lap 3: recording cut off mid-lap — incomplete
      expect(laps[3].isValid).toBe(false);
      expect(laps[3].invalidReason).toBe("incomplete");
    });
  });
});
