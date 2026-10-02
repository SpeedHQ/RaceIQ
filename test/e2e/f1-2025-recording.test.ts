import { describe, test, expect } from "bun:test";
import type { LapSavedNotification } from "../../server/lap-detection/types"
import { parseDump } from "../support/recordings/parse-dump";
import { assertLapTimesProper, assertValidLapHasSectors } from "../support/laps/assertions";
import { generateRecordingVisualizations } from "../support/laps/visualizations";
import { getRecordingFixture } from "../support/recordings/fixtures";
import { parseSessionLapsBatchedForTest } from "../../server/db/telemetry-replay-storage";

describe("F1-2025 recording", () => {
  describe("f1-2025-2026-04-09T21-34-10-190Z", () => {
    const recordingFile = "f1-2025-2026-04-09T21-34-10-190Z.bin.gz";

    test("detects laps correctly", async () => {
      const recording = getRecordingFixture(recordingFile);
      if (!recording) throw new Error(`Required recording not found: ${recordingFile}`);

      console.log(`Using: ${recording}`);
      const { laps, carModel, trackName, wsNotifications } = await parseDump("f1-2025", recording);
      console.log(`Detected ${laps.length} lap(s)`);
      for (const lap of laps) {
        const mins = Math.floor(lap.lapTime / 60);
        const secs = (lap.lapTime % 60).toFixed(3);
        const sectorStr = lap.sectors
          ? lap.sectors.map((time, index) => `s${index + 1}=${time.toFixed(3)}`).join(" ")
          : "no sectors";
        console.log(
          `  Lap ${lap.lapNumber}: ${mins}:${secs.padStart(6, "0")} valid=${lap.isValid}${lap.invalidReason ? ` (${lap.invalidReason})` : ""} [${sectorStr}]`
        );
      }

      // Note: carModel and trackName are extracted from telemetry, not from dump metadata for F1-2025
      // (they're always null in parseDump for non-ACC games)
      console.log(`Car: ${carModel}, Track: ${trackName}`);

      // Committed fixture must produce at least one lap; zero laps is a failed pipeline.
      expect(laps.length).toBeGreaterThan(0);

      // Check WebSocket notifications exist for completed laps
      const lapSavedNotifications = wsNotifications.filter(
        (n): n is LapSavedNotification => n.type === "lap-saved"
      );
      console.log(`Received ${lapSavedNotifications.length} lap-saved notification(s)`);

      // Verify all laps have valid session IDs
      for (const lap of laps) {
        expect(lap.sessionId).toBeTruthy();
        expect(lap.lapNumber).toBeGreaterThanOrEqual(0);
        expect(lap.isValid).toBeDefined();
      }

      // Verify packets exist for each lap
      for (const lap of laps) {
        expect(lap.packets.length).toBeGreaterThan(0);
        // Only check lap times for valid laps (skip incomplete/invalid ones)
        if (lap.isValid) {
          assertLapTimesProper(lap.packets, lap.lapTime);
          assertValidLapHasSectors(lap);
          expect(lap.sectors).toHaveLength(3);
        }
      }

      // Analysis replays selected lap ranges from the capture using the byte
      // offsets/frame counts persisted by the live detector.
      const indexedLaps = laps.filter(
        (lap) => lap.rawByteOffset != null && lap.rawFrameCount > 0,
      );
      const selectedLaps = [indexedLaps[0], indexedLaps[indexedLaps.length - 1]]
        .filter((lap, index, selected) => lap && selected.indexOf(lap) === index);
      const replayed = await parseSessionLapsBatchedForTest(
        {
          rawFile: recording,
          source: null,
          gameId: "f1-2025",
          carOrdinal: 0,
          trackOrdinal: 0,
        },
        selectedLaps.map((lap, index) => ({
          id: index + 1,
          rawByteOffset: lap.rawByteOffset!,
          rawFrameCount: lap.rawFrameCount,
        })),
      );
      for (const [index, lap] of selectedLaps.entries()) {
        expect(replayed.get(index + 1)?.length).toBe(lap.packets.length);
      }

      // Debug: show coordinate ranges and large jumps for each lap
      for (const lap of laps) {
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
      }

      // Regenerate SVG + GIF visualizations for this recording
      if (wsNotifications.length > 0) {
        const { rawPackets } = await parseDump("f1-2025", recording);
        await generateRecordingVisualizations(recordingFile, laps, rawPackets);
        console.log(`[Visualizations] Generated for ${laps.length} laps`);
      }
    }, 120000);
  });
});
