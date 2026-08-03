import { describe, test, expect } from "bun:test";
import type { LapSavedNotification } from "../../server/lap-detection/types"
import { parseDump } from "../helpers/parse-dump";
import { assertLapTimesProper, assertValidLapHasSectors } from "../helpers/lap-assertions";
import { generateRecordingVisualizations } from "../helpers/lap-viz";
import { existsSync } from "fs";
import { join } from "path";

const RECORDINGS_DIR = "test/artifacts/sessions";

function getRecording(filename: string): string | null {
  const recordingPath = join(RECORDINGS_DIR, filename);
  return existsSync(recordingPath) ? recordingPath : null;
}

describe("FM-2023 recording", () => {
  describe("fm-2023-2026-04-09T21-53-00-102Z", () => {
    const recordingFile = "fm-2023-2026-04-09T21-53-00-102Z.bin.gz";

    test("replays telemetry without inventing a completed lap", async () => {
      const recording = getRecording(recordingFile);
      if (!recording) throw new Error(`Required recording not found: ${recordingFile}`);

      console.log(`Using: ${recording}`);
      const { laps, carModel, trackName, wsNotifications, rawPackets } = await parseDump("fm-2023", recording);
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

      // Note: carModel and trackName are extracted from telemetry, not from dump metadata for FM-2023
      // (they're always null in parseDump for non-ACC games)
      console.log(`Car: ${carModel}, Track: ${trackName}`);

      expect(rawPackets.length).toBeGreaterThan(0);
      expect(laps).toHaveLength(0);

      // Check WebSocket notifications exist for completed laps
      const lapSavedNotifications = wsNotifications.filter(
        (n): n is LapSavedNotification => n.type === "lap-saved"
      );
      expect(lapSavedNotifications).toHaveLength(0);

      // Verify all laps have valid session IDs
      for (const lap of laps) {
        expect(lap.sessionId).toBeTruthy();
        expect(lap.lapNumber).toBeGreaterThanOrEqual(0);
        expect(lap.isValid).toBeDefined();
      }

      // Verify packets exist for each lap
      for (const lap of laps) {
        expect(lap.packets.length).toBeGreaterThan(0);
        if (lap.isValid) {
          assertValidLapHasSectors(lap);
        }
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
        const { rawPackets } = await parseDump("fm-2023", recording);
        await generateRecordingVisualizations(recordingFile, laps, rawPackets);
        console.log(`[Visualizations] Generated for ${laps.length} laps`);
      }
    }, { timeout: 30000 });
  });

  describe("fm-2023-2026-04-09T21-55-03-186Z", () => {
    const recordingFile = "fm-2023-2026-04-09T21-55-03-186Z.bin.gz";

    test("detects laps correctly", async () => {
      const recording = getRecording(recordingFile);
      if (!recording) throw new Error(`Required recording not found: ${recordingFile}`);

      console.log(`Using: ${recording}`);
      const { laps, sessions, carModel, trackName, wsNotifications } = await parseDump("fm-2023", recording);
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

      // Note: carModel and trackName are extracted from telemetry, not from dump metadata for FM-2023
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
        if (lap.isValid) {
          assertLapTimesProper(lap.packets, lap.lapTime);
          assertValidLapHasSectors(lap);
        }
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
        const { rawPackets } = await parseDump("fm-2023", recording);
        await generateRecordingVisualizations(recordingFile, laps, rawPackets);
        console.log(`[Visualizations] Generated for ${laps.length} laps`);
      }
    }, { timeout: 30000 });
  });
});
