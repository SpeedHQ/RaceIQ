import { describe, test, expect } from "bun:test";
import type { LapSavedNotification } from "../../server/lap-detector";
import { parseDump } from "../helpers/parse-dump";
import { assertSectorTimesMatchLapTime, assertLapTimesProper, assertLapSavedNotificationsExist, assertCommonLapValidations } from "../helpers/lap-assertions";
import { generateRecordingVisualizations } from "../helpers/lap-viz";
import { existsSync } from "fs";
import { join } from "path";

const RECORDINGS_DIR = "test/artifacts/laps";

function getRecording(filename: string): string | null {
  const recordingPath = join(RECORDINGS_DIR, filename);
  return existsSync(recordingPath) ? recordingPath : null;
}

describe("ACC recording", () => {
  describe("acc-2026-04-10T02-59-28-972Z.bin", () => {
    const recordingFile = "acc-2026-04-10T02-59-28-972Z.bin";

    test("detects laps correctly", async () => {
      const recording = getRecording(recordingFile);
      if (!recording) {
        console.log(`Recording not found: ${recordingFile}`);
        return;
      }

      console.log(`Using: ${recording}`);
      const { laps, sessions, carModel, trackName, wsNotifications, rawPackets } = await parseDump("acc", recording);
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

      // Session metadata
      expect(carModel).toBe("mclaren_720s_gt3_evo");
      expect(trackName).toBe("brands_hatch");

      // Common lap validations: lap count, metadata, packets, timing, sectors, notifications
      assertCommonLapValidations(laps, wsNotifications, { expectedLapCount: 5 });

      // Detailed notification checks (ACC-specific)
      const lapSavedNotifications = wsNotifications.filter(
        (n): n is LapSavedNotification => n.type === "lap-saved"
      );
      // assertCommonLapValidations already asserts lapSavedNotifications.length matches completed laps

      // First notification should be for lap 0 (invalid)
      expect(lapSavedNotifications[0].lapNumber).toBe(0);
      expect(lapSavedNotifications[0].isValid).toBe(false);

      // Second notification should be for lap 1 (valid) — first valid lap, becomes the best lap
      expect(lapSavedNotifications[1].lapNumber).toBe(1);
      expect(lapSavedNotifications[1].isValid).toBe(true);
      expect(lapSavedNotifications[1].lapTime).toBeGreaterThan(0);
      // Best lap is now set to lap 1's time (first valid lap establishes the baseline)
      expect(lapSavedNotifications[1].estimatedBestLapTime).toBe(lapSavedNotifications[1].lapTime);

      // Third notification should be for lap 2 (valid)
      expect(lapSavedNotifications[2].lapNumber).toBe(2);
      expect(lapSavedNotifications[2].isValid).toBe(true);
      expect(lapSavedNotifications[2].lapTime).toBeGreaterThan(0);

      // Fourth notification should be for lap 3 (valid)
      expect(lapSavedNotifications[3].lapNumber).toBe(3);
      expect(lapSavedNotifications[3].isValid).toBe(true);
      expect(lapSavedNotifications[3].lapTime).toBeGreaterThan(0);

      // Lap 0: joining lap — invalid
      expect(laps[0].isValid).toBe(false);
      expect(laps[0].invalidReason).toBe("outlap");

      // Lap 1: valid lap with sectors
      expect(laps[1].isValid).toBe(true);
      expect(laps[1].sectors).not.toBe(null);
      expect(laps[1].sectors?.s1).toBeGreaterThan(0);
      expect(laps[1].sectors?.s2).toBeGreaterThan(0);
      expect(laps[1].sectors?.s3).toBeGreaterThan(0);
      assertSectorTimesMatchLapTime(laps[1]);
      assertLapTimesProper(laps[1].packets, laps[1].lapTime);

      // Lap 2: valid lap with sectors
      expect(laps[2].isValid).toBe(true);
      expect(laps[2].sectors).not.toBe(null);
      expect(laps[2].sectors?.s1).toBeGreaterThan(0);
      expect(laps[2].sectors?.s2).toBeGreaterThan(0);
      expect(laps[2].sectors?.s3).toBeGreaterThan(0);
      assertSectorTimesMatchLapTime(laps[2]);
      assertLapTimesProper(laps[2].packets, laps[2].lapTime);

      // Lap 3: valid lap with sectors
      expect(laps[3].isValid).toBe(true);
      expect(laps[3].sectors).not.toBe(null);
      expect(laps[3].sectors?.s1).toBeGreaterThan(0);
      expect(laps[3].sectors?.s2).toBeGreaterThan(0);
      expect(laps[3].sectors?.s3).toBeGreaterThan(0);
      assertSectorTimesMatchLapTime(laps[3]);
      assertLapTimesProper(laps[3].packets, laps[3].lapTime);

      // Lap 4: recording cut off mid-lap — incomplete
      expect(laps[4].isValid).toBe(false);
      expect(laps[4].invalidReason).toBe("incomplete");

      // Session state: verify all laps belong to same session
      // Note: sessions array may have multiple entries due to internal state boundaries (e.g., distance-reset),
      // but all persisted laps should belong to the first session
      const firstSessionId = laps[0].sessionId;
      const uniqueSessionIds = new Set(laps.map((l) => l.sessionId));
      expect(uniqueSessionIds.size).toBe(1); // All laps in same session
      expect(Array.from(uniqueSessionIds)[0]).toBe(firstSessionId);

      // Verify all 5 laps are in that one session
      const sessionLaps = laps.filter((l) => l.sessionId === firstSessionId);
      expect(sessionLaps.length).toBe(5);
      expect(sessionLaps.map((l) => l.lapNumber)).toEqual([0, 1, 2, 3, 4]);

      await generateRecordingVisualizations(recordingFile, laps, rawPackets);
      console.log(`[Visualizations] Generated for ${laps.length} laps`);
    }, { timeout: 30000 });
  });
});
