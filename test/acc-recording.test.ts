import { describe, test, expect } from "bun:test";
import { parseDump } from "./helpers/parse-dump";
import { assertSectorTimesMatchLapTime, assertLapTimesProper } from "./helpers/lap-assertions";
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
        const sectorStr = lap.sectors
          ? `s1=${lap.sectors.s1.toFixed(3)} s2=${lap.sectors.s2.toFixed(3)} s3=${lap.sectors.s3.toFixed(3)}`
          : "no sectors";
        console.log(
          `  Lap ${lap.lapNumber}: ${mins}:${secs.padStart(6, "0")} valid=${lap.isValid}${lap.invalidReason ? ` (${lap.invalidReason})` : ""} [${sectorStr}]`
        );
      }

      expect(laps.length).toBe(4);

      // Session metadata
      expect(carModel).toBe("mclaren_720s_gt3_evo");
      expect(trackName).toBe("brands_hatch");

      // Lap 0: joining lap — invalid
      expect(laps[0].isValid).toBe(false);
      expect(laps[0].invalidReason).toBe("telemetry distance too short");

      // Lap 1: first full lap — valid with sectors
      expect(laps[1].isValid).toBe(true);
      expect(laps[1].sectors).not.toBe(null);
      expect(laps[1].sectors?.s1).toBeGreaterThan(0);
      expect(laps[1].sectors?.s2).toBeGreaterThan(0);
      expect(laps[1].sectors?.s3).toBeGreaterThan(0);
      assertSectorTimesMatchLapTime(laps[1]);
      assertLapTimesProper(laps[1].packets, laps[1].lapTime);

      // Lap 2: second full lap — valid (sectors may be null in some cases)
      expect(laps[2].isValid).toBe(true);
      assertLapTimesProper(laps[2].packets, laps[2].lapTime);
      if (laps[2].sectors) {
        expect(laps[2].sectors.s1).toBeGreaterThan(0);
        expect(laps[2].sectors.s2).toBeGreaterThan(0);
        expect(laps[2].sectors.s3).toBeGreaterThan(0);
        assertSectorTimesMatchLapTime(laps[2]);
      }

      // Lap 3: recording cut off mid-lap — incomplete
      expect(laps[3].isValid).toBe(false);
      expect(laps[3].invalidReason).toBe("incomplete");
    });
  });
});
