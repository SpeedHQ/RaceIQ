import { describe, test, expect } from "bun:test";
import type { LapSavedNotification } from "../../server/lap-detector";
import { parseDump } from "../helpers/parse-dump";
import { assertSectorTimesMatchLapTime, assertLapTimesProper } from "../helpers/lap-assertions";
import { generateLapSvg } from "../helpers/lap-svg";
import { generateLapGif } from "../helpers/lap-gif";
import { existsSync, readdirSync } from "fs";
import { join } from "path";

const RECORDINGS_DIR = "test/artifacts/laps";
const OUTPUT_DIR = "test/e2e/output";

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
      const lapSavedNotifications = wsNotifications.filter(
        (n): n is LapSavedNotification => n.type === "lap-saved"
      );
      expect(lapSavedNotifications.length).toBe(3); // One notification per completed lap

      // First notification should be for lap 0 (invalid)
      expect(lapSavedNotifications[0].lapNumber).toBe(0);
      expect(lapSavedNotifications[0].isValid).toBe(false);

      // Second notification should be for lap 1 (valid) — first valid lap, becomes the best lap
      expect(lapSavedNotifications[1].lapNumber).toBe(1);
      expect(lapSavedNotifications[1].isValid).toBe(true);
      expect(lapSavedNotifications[1].lapTime).toBeGreaterThan(0);
      // Best lap is now set to lap 1's time (first valid lap establishes the baseline)
      expect(lapSavedNotifications[1].estimatedBestLapTime).toBe(lapSavedNotifications[1].lapTime);

      // Third notification should be for lap 2 (valid) — best lap now established from lap 1
      expect(lapSavedNotifications[2].lapNumber).toBe(2);
      expect(lapSavedNotifications[2].isValid).toBe(true);
      // Best lap time should be from lap 1 (its time becomes the new best)
      expect(lapSavedNotifications[2].estimatedBestLapTime).toBe(lapSavedNotifications[1].lapTime);
      // Lap 2 is slower than lap 1
      expect(lapSavedNotifications[2].lapTime).toBeGreaterThan(lapSavedNotifications[2].estimatedBestLapTime);

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

      // Session state: verify all laps belong to same session
      // Note: sessions array may have multiple entries due to internal state boundaries (e.g., distance-reset),
      // but all persisted laps should belong to the first session
      const firstSessionId = laps[0].sessionId;
      const uniqueSessionIds = new Set(laps.map((l) => l.sessionId));
      expect(uniqueSessionIds.size).toBe(1); // All laps in same session
      expect(Array.from(uniqueSessionIds)[0]).toBe(firstSessionId);

      // Verify all 4 laps are in that one session
      const sessionLaps = laps.filter((l) => l.sessionId === firstSessionId);
      expect(sessionLaps.length).toBe(4);
      expect(sessionLaps.map((l) => l.lapNumber)).toEqual([0, 1, 2, 3]);

      // Generate SVG visualizations for each lap
      console.log(`[SVG] Generating lap visualizations in ${OUTPUT_DIR}`);
      // Extract recording filename without path and extension
      const recordingBaseName = recordingFile.replace(/\.bin$/, "");
      for (const lap of laps) {
        // Debug: show coordinate ranges
        let minX = lap.packets[0].PositionX;
        let maxX = lap.packets[0].PositionX;
        let minZ = lap.packets[0].PositionZ;
        let maxZ = lap.packets[0].PositionZ;
        for (const p of lap.packets) {
          minX = Math.min(minX, p.PositionX);
          maxX = Math.max(maxX, p.PositionX);
          minZ = Math.min(minZ, p.PositionZ);
          maxZ = Math.max(maxZ, p.PositionZ);
        }
        console.log(
          `[SVG] Lap ${lap.lapNumber}: X(${minX.toFixed(1)}-${maxX.toFixed(1)}) Z(${minZ.toFixed(1)}-${maxZ.toFixed(1)})`
        );

        // Find large jumps between packets (potential pit exit or glitches)
        let maxJump = 0;
        let maxJumpIdx = -1;
        for (let i = 1; i < lap.packets.length; i++) {
          const prev = lap.packets[i - 1];
          const curr = lap.packets[i];
          const dx = curr.PositionX - prev.PositionX;
          const dz = curr.PositionZ - prev.PositionZ;
          const distance = Math.sqrt(dx * dx + dz * dz);
          if (distance > maxJump) {
            maxJump = distance;
            maxJumpIdx = i;
          }
        }
        if (maxJump > 10) {
          console.log(`  → Largest jump: ${maxJump.toFixed(1)} units at packet ${maxJumpIdx}`);
        }

        generateLapSvg(lap.packets, lap.lapNumber, OUTPUT_DIR, recordingBaseName);
        console.log(`[SVG] Generated ${recordingBaseName}-lap-${lap.lapNumber}.svg`);

        await generateLapGif(lap.packets, lap.lapNumber, OUTPUT_DIR, recordingBaseName);
        console.log(`[GIF] Generated ${recordingBaseName}-lap-${lap.lapNumber}.gif`);
      }
    });
  });
});
