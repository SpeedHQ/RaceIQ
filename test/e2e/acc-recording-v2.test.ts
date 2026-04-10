import { describe, test, expect } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { parseDumpV2 } from "../helpers/parse-dump-v2";

const RECORDINGS_DIR = "test/artifacts/laps";

describe("ACC recording v2", () => {
  describe("acc-2026-04-10T02-59-28-972Z.bin", () => {
    const recordingFile = "acc-2026-04-10T02-59-28-972Z.bin";
    const recording = join(RECORDINGS_DIR, recordingFile);

    test("discards phantom partial lap and keeps 3 full valid laps", async () => {
      if (!existsSync(recording)) {
        console.log(`Recording not found: ${recordingFile}`);
        return;
      }

      const { laps, carModel, trackName } = await parseDumpV2("acc", recording);

      console.log(`v2 detected ${laps.length} lap(s)`);
      for (const l of laps) {
        const mins = Math.floor(l.lapTime / 60);
        const secs = (l.lapTime % 60).toFixed(3);
        const valid = l.isValid ? "valid" : `invalid (${l.invalidReason ?? "unknown"})`;
        console.log(`  Lap ${l.lapNumber}: ${mins}:${secs.padStart(6, "0")} ${valid}`);
      }

      // Session metadata
      expect(carModel).toBe("mclaren_720s_gt3_evo");
      expect(trackName).toBe("brands_hatch");

      // v2 should discard the phantom partial lap and persist exactly 3 full valid laps
      const validLaps = laps.filter((l) => l.isValid);
      expect(validLaps.length).toBe(3);

      // Lap numbering should start at 0
      expect(validLaps[0].lapNumber).toBe(0);
      expect(validLaps[1].lapNumber).toBe(1);
      expect(validLaps[2].lapNumber).toBe(2);

      // Lap times should match peak CurrentLap from raw frame analysis (±1 second tolerance
      // to absorb frame-level jitter between the sampled peak and the true crossing moment)
      expect(validLaps[0].lapTime).toBeCloseTo(90.375, 0);
      expect(validLaps[1].lapTime).toBeCloseTo(88.120, 0);
      expect(validLaps[2].lapTime).toBeCloseTo(89.277, 0);

      // Sector times are OK to be null for ACC in v2 right now (see Task 5 concerns)
      // — we don't assert on them here.
    }, { timeout: 30000 });
  });
});
