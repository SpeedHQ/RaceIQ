import { describe, test, expect } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { parseDumpV2 } from "../helpers/parse-dump-v2";
import { generateRecordingVisualizations } from "../helpers/lap-viz";

const RECORDINGS_DIR = "test/artifacts/laps";

describe("ACC recording v2", () => {
  describe("acc-2026-04-10T02-59-28-972Z.bin", () => {
    const recordingFile = "acc-2026-04-10T02-59-28-972Z.bin";
    const recording = join(RECORDINGS_DIR, recordingFile);

    test("saves 5 laps with 3 valid (joining + 3 real + incomplete)", async () => {
      if (!existsSync(recording)) {
        console.log(`Recording not found: ${recordingFile}`);
        return;
      }

      const { laps, carModel, trackName, rawPackets } = await parseDumpV2("acc", recording);

      console.log(`v2 detected ${laps.length} lap(s)`);
      for (const l of laps) {
        const mins = Math.floor(l.lapTime / 60);
        const secs = (l.lapTime % 60).toFixed(3);
        const valid = l.isValid ? "valid" : `invalid (${l.invalidReason ?? "unknown"})`;
        console.log(`  Lap ${l.lapNumber}: ${mins}:${secs.padStart(6, "0")} ${valid}`);
      }

      await generateRecordingVisualizations(recordingFile, laps, rawPackets);

      // Session metadata
      expect(carModel).toBe("mclaren_720s_gt3_evo");
      expect(trackName).toBe("brands_hatch");

      // v2 emits 5 laps: joining (invalid) + 3 real (valid) + incomplete (invalid)
      expect(laps.length).toBe(5);
      const validLaps = laps.filter((l) => l.isValid);
      expect(validLaps.length).toBe(3);

      // Lap 0: the joining lap (recording started mid-lap, also from pit)
      expect(laps[0].isValid).toBe(false);
      expect(laps[0].invalidReason).toBe("outlap");
      // Confirms the recording data itself has pit status on lap 0 start —
      // the joining-lap check wins over the pit-lap check here because it
      // fires first, but the underlying packet state should still show pit.
      expect(laps[0].packets[0].acc?.pitStatus).not.toBe("out");

      // Laps 1-3: the three real laps (valid, all on track)
      expect(laps[1].isValid).toBe(true);
      expect(laps[1].packets[0].acc?.pitStatus).toBe("out");
      expect(laps[2].isValid).toBe(true);
      expect(laps[2].packets[0].acc?.pitStatus).toBe("out");
      expect(laps[3].isValid).toBe(true);
      expect(laps[3].packets[0].acc?.pitStatus).toBe("out");

      // Lap times match peak CurrentLap from raw frame analysis (±1s tolerance)
      expect(laps[1].lapTime).toBeCloseTo(90.375, 0);
      expect(laps[2].lapTime).toBeCloseTo(88.120, 0);
      expect(laps[3].lapTime).toBeCloseTo(89.277, 0);

      // Lap 4: the incomplete tail (recording ended mid-lap)
      expect(laps[4].isValid).toBe(false);
      expect(laps[4].invalidReason).toBe("incomplete");
    }, { timeout: 30000 });
  });

  describe("acc-2026-04-09T18-56-49-633Z.bin", () => {
    const recordingFile = "acc-2026-04-09T18-56-49-633Z.bin";
    const recording = join(RECORDINGS_DIR, recordingFile);

    test("saves 4 laps with 2 valid (joining + 2 real + incomplete)", async () => {
      if (!existsSync(recording)) {
        console.log(`Recording not found: ${recordingFile}`);
        return;
      }

      const { laps, carModel, trackName, rawPackets } = await parseDumpV2("acc", recording);

      console.log(`v2 detected ${laps.length} lap(s)`);
      for (const l of laps) {
        const mins = Math.floor(l.lapTime / 60);
        const secs = (l.lapTime % 60).toFixed(3);
        const valid = l.isValid ? "valid" : `invalid (${l.invalidReason ?? "unknown"})`;
        console.log(`  Lap ${l.lapNumber}: ${mins}:${secs.padStart(6, "0")} ${valid}`);
      }

      await generateRecordingVisualizations(recordingFile, laps, rawPackets);

      // Session metadata
      expect(carModel).toBe("mclaren_720s_gt3_evo");
      expect(trackName).toBe("brands_hatch");

      // v2 emits 4 laps: joining (invalid) + 2 real (valid) + incomplete (invalid)
      expect(laps.length).toBe(4);
      const validLaps = laps.filter((l) => l.isValid);
      expect(validLaps.length).toBe(2);

      // Lap 0: the joining lap (recording started mid-lap, also from pit)
      expect(laps[0].isValid).toBe(false);
      expect(laps[0].invalidReason).toBe("outlap");
      // Confirms the recording data has pit status on lap 0 start
      expect(laps[0].packets[0].acc?.pitStatus).not.toBe("out");

      // Laps 1-2: the two real laps (valid with sectors)
      expect(laps[1].isValid).toBe(true);
      expect(laps[1].sectors).not.toBe(null);
      expect(laps[1].sectors?.s1).toBeGreaterThan(0);
      expect(laps[1].sectors?.s2).toBeGreaterThan(0);
      expect(laps[1].sectors?.s3).toBeGreaterThan(0);

      expect(laps[2].isValid).toBe(true);
      expect(laps[2].sectors).not.toBe(null);
      expect(laps[2].sectors?.s1).toBeGreaterThan(0);
      expect(laps[2].sectors?.s2).toBeGreaterThan(0);
      expect(laps[2].sectors?.s3).toBeGreaterThan(0);

      // Lap times match peak CurrentLap from v2's reset detection (±1s tolerance)
      expect(laps[1].lapTime).toBeCloseTo(100.312, 0);
      expect(laps[2].lapTime).toBeCloseTo(101.750, 0);

      // Lap 3: the incomplete tail (recording ended mid-lap)
      expect(laps[3].isValid).toBe(false);
      expect(laps[3].invalidReason).toBe("incomplete");
    }, { timeout: 30000 });
  });
});
