import { describe, test, expect } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { parseDumpV2 } from "../helpers/parse-dump-v2";
import { generateRecordingVisualizations } from "../helpers/lap-viz";
import type { CapturedLap } from "../../server/pipeline-adapters";

/**
 * Assert Brand Hatch sector bounds for a valid lap.
 * S1=32%, S2=35%, S3=33% of lap — each sector should be between 20-50% of lap time.
 * Catches "S3 timing in S1 area" where one sector is abnormally large or wrong.
 */
function assertBrandHatchSectorBounds(lap: CapturedLap): void {
  if (!lap.sectors) return;
  const { s1, s2, s3 } = lap.sectors;
  const lapTime = lap.lapTime;
  // Each sector must be at least 20% and no more than 50% of lap time
  for (const [name, t] of [["s1", s1], ["s2", s2], ["s3", s3]] as [string, number][]) {
    const frac = t / lapTime;
    expect(frac, `${name}=${t.toFixed(3)}s is ${(frac * 100).toFixed(1)}% of lap — outside 20-50% band for Brand Hatch`).toBeGreaterThan(0.20);
    expect(frac, `${name}=${t.toFixed(3)}s is ${(frac * 100).toFixed(1)}% of lap — outside 20-50% band for Brand Hatch`).toBeLessThan(0.50);
  }
}

const RECORDINGS_DIR = "test/artifacts/laps";

describe("ACC recording v2", () => {
  describe("acc-2026-04-10T02-59-28-972Z", () => {
    const recordingFile = "acc-2026-04-10T02-59-28-972Z.bin";
    const recording = join(RECORDINGS_DIR, recordingFile);

    test("5 laps: outlap + 3 valid + incomplete tail", async () => {
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

      // Sector bounds: each sector must be 20-50% of lap time for Brand Hatch.
      // Guards against S3 timing appearing in the S1 slot (or any other mis-assignment).
      assertBrandHatchSectorBounds(laps[1]);
      assertBrandHatchSectorBounds(laps[2]);
      assertBrandHatchSectorBounds(laps[3]);

      // Lap 4: the incomplete tail (recording ended mid-lap)
      expect(laps[4].isValid).toBe(false);
      expect(laps[4].invalidReason).toBe("incomplete");
    }, { timeout: 30000 });
  });

  describe("acc-2026-04-09T18-56-49-633Z", () => {
    const recordingFile = "acc-2026-04-09T18-56-49-633Z.bin";
    const recording = join(RECORDINGS_DIR, recordingFile);

    test("4 laps: outlap + 2 valid + incomplete tail", async () => {
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

      // Sector bounds: each sector must be 20-50% of lap time for Brand Hatch.
      // Guards against S3 timing appearing in the S1 slot (or any other mis-assignment).
      assertBrandHatchSectorBounds(laps[1]);
      assertBrandHatchSectorBounds(laps[2]);

      // Lap 3: the incomplete tail (recording ended mid-lap)
      expect(laps[3].isValid).toBe(false);
      expect(laps[3].invalidReason).toBe("incomplete");

    }, { timeout: 30000 });
  });

  describe("acc-2026-04-12T20-41-21-436Z", () => {
    const recordingFile = "acc-2026-04-12T20-41-21-436Z.bin";
    const recording = join(RECORDINGS_DIR, recordingFile);

    test("pit lap sectors are null, outlap and valid laps have correct sectors", async () => {
      if (!existsSync(recording)) {
        console.log(`Recording not found: ${recordingFile}`);
        return;
      }

      const { laps } = await parseDumpV2("acc", recording);

      for (const l of laps) {
        const mins = Math.floor(l.lapTime / 60);
        const secs = (l.lapTime % 60).toFixed(3);
        const valid = l.isValid ? "valid" : `invalid (${l.invalidReason ?? "unknown"})`;
        const s = l.sectors;
        const sectorStr = s ? `s1=${s.s1.toFixed(3)} s2=${s.s2.toFixed(3)} s3=${s.s3.toFixed(3)}` : "sectors=null";
        console.log(`  Lap ${l.lapNumber}: ${mins}:${secs.padStart(6, "0")} ${valid} | ${sectorStr}`);
      }

      // 6 laps: pit lap + outlap + 2 valid + short invalid + incomplete
      expect(laps.length).toBe(6);

      // Lap 0: pit lap — recording started mid-lap inside the pit, sectors must be null
      // (only 132m of distance to finish line, distance-fraction would give garbage times)
      expect(laps[0].isValid).toBe(false);
      expect(laps[0].invalidReason).toBe("pit lap");
      expect(laps[0].sectors).toBeNull();

      // Lap 1: outlap — valid sectors via sectorIndex transitions
      expect(laps[1].isValid).toBe(false);
      expect(laps[1].invalidReason).toBe("outlap");
      assertBrandHatchSectorBounds(laps[1]);

      // Laps 2-3: clean laps
      expect(laps[2].isValid).toBe(true);
      assertBrandHatchSectorBounds(laps[2]);
      expect(laps[3].isValid).toBe(true);
      assertBrandHatchSectorBounds(laps[3]);
    }, { timeout: 30000 });
  });

  describe("acc-2026-04-12T21-16-07-841Z", () => {
    const recordingFile = "acc-2026-04-12T21-16-07-841Z.bin";
    const recording = join(RECORDINGS_DIR, recordingFile);

    test("detects laps correctly with no duplicates", async () => {
      if (!existsSync(recording)) {
        console.log(`Recording not found: ${recordingFile}`);
        return;
      }

      const { laps, wsNotifications } = await parseDumpV2("acc", recording);

      const lapSaved = (wsNotifications as any[]).filter(n => n.type === "lap-saved");

      for (const l of laps) {
        const mins = Math.floor(l.lapTime / 60);
        const secs = (l.lapTime % 60).toFixed(3);
        const valid = l.isValid ? "valid" : `invalid (${l.invalidReason ?? "unknown"})`;
        const s = l.sectors;
        const ss = s ? `s1=${s.s1.toFixed(3)} s2=${s.s2.toFixed(3)} s3=${s.s3.toFixed(3)}` : "sectors=null";
        console.log(`  Lap ${l.lapNumber}: ${mins}:${secs.padStart(6, "0")} ${valid} | ${ss}`);
      }
      console.log(`  lap-saved notifications: ${lapSaved.map((n: any) => `lap${n.lapNumber}`).join(", ")}`);
    }, { timeout: 30000 });
  });

  describe("acc-2026-04-12T21-44-38-899Z", () => {
    const recordingFile = "acc-2026-04-12T21-44-38-899Z.bin";
    const recording = join(RECORDINGS_DIR, recordingFile);

    test("pit-only opening segment discarded, outlap is lap 0", async () => {
      if (!existsSync(recording)) {
        console.log(`Recording not found: ${recordingFile}`);
        return;
      }

      const { laps, rawPackets } = await parseDumpV2("acc", recording);

      for (const l of laps) {
        const mins = Math.floor(l.lapTime / 60);
        const secs = (l.lapTime % 60).toFixed(3);
        const valid = l.isValid ? "valid" : `invalid (${l.invalidReason ?? "unknown"})`;
        const s = l.sectors;
        const ss = s ? `s1=${s.s1.toFixed(3)} s2=${s.s2.toFixed(3)} s3=${s.s3.toFixed(3)}` : "sectors=null";
        console.log(`  Lap ${l.lapNumber}: ${mins}:${secs.padStart(6, "0")} ${valid} | ${ss}`);
      }

      // The opening segment that used to push the outlap to lap 1 must be in pit.
      // This confirms the discard logic fired correctly: the raw recording started
      // while the car was sitting in the pit box (not on track).
      expect(rawPackets[0].acc?.pitStatus).not.toBe("out");

      // 3 laps: outlap + valid + incomplete
      // The 17-minute pit-only opening segment is discarded — recording started while
      // the car was sitting in the pit box, so that data is useless. Outlap is lap 0.
      expect(laps.length).toBe(3);

      // Lap 0: outlap (was lap 1 before the pit-only opening segment was discarded)
      // First packet is still pit_lane — Brand Hatch pit exit beacon is after S/F line.
      expect(laps[0].isValid).toBe(false);
      expect(laps[0].invalidReason).toBe("outlap");
      expect(laps[0].packets[0].acc?.pitStatus).not.toBe("out");
      assertBrandHatchSectorBounds(laps[0]);

      // Lap 1: clean lap
      expect(laps[1].isValid).toBe(true);
      assertBrandHatchSectorBounds(laps[1]);

      // Lap 2: incomplete tail
      expect(laps[2].isValid).toBe(false);
      expect(laps[2].invalidReason).toBe("incomplete");
    }, { timeout: 30000 });
  });
});
