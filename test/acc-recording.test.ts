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
      const { laps, sessions, carModel, trackName, wsNotifications } = await parseDump("acc", recording);
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

      // WebSocket events: should have lap-saved notifications for each completed lap (lap 3 is incomplete, no notification)
      const lapSavedNotifications = wsNotifications.filter((n) => n.type === "lap-saved");
      expect(lapSavedNotifications.length).toBe(3); // One notification per completed lap

      // First notification should be for lap 0 (invalid)
      expect(lapSavedNotifications[0].type).toBe("lap-saved");
      expect((lapSavedNotifications[0] as any).lapNumber).toBe(0);
      expect((lapSavedNotifications[0] as any).isValid).toBe(false);

      // Second notification should be for lap 1 (valid)
      expect(lapSavedNotifications[1].type).toBe("lap-saved");
      expect((lapSavedNotifications[1] as any).lapNumber).toBe(1);
      expect((lapSavedNotifications[1] as any).isValid).toBe(true);
      expect((lapSavedNotifications[1] as any).lapTime).toBeGreaterThan(0);

      // Third notification should be for lap 2 (valid)
      expect(lapSavedNotifications[2].type).toBe("lap-saved");
      expect((lapSavedNotifications[2] as any).lapNumber).toBe(2);
      expect((lapSavedNotifications[2] as any).isValid).toBe(true);

      // Lap 2 should have estimated best lap time available (from lap 1, which was faster)
      expect((lapSavedNotifications[2] as any).estimatedBestLapTime).toBeGreaterThan(0);
      // Best lap time should be from lap 1 (100.34s is better than lap 2's 101.767s)
      expect((lapSavedNotifications[2] as any).estimatedBestLapTime).toBeLessThan((lapSavedNotifications[2] as any).lapTime);

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
