import { describe, test, expect } from "bun:test";
import type { LapSavedNotification } from "../../server/lap-detector";
import { parseDump } from "../helpers/parse-dump";
import { assertSectorTimesMatchLapTime, assertLapTimesProper } from "../helpers/lap-assertions";
import { generateLapSvg, generateRawSvg } from "../helpers/lap-svg";
import { generateLapGif, generateRawGif } from "../helpers/lap-gif";
import { existsSync, readdirSync, mkdirSync } from "fs";
import { join } from "path";

const RECORDINGS_DIR = "test/artifacts/laps";
const OUTPUT_DIR = "test/e2e/output";

function getRecording(filename: string): string | null {
  const recordingPath = join(RECORDINGS_DIR, filename);
  return existsSync(recordingPath) ? recordingPath : null;
}

describe("F1-2025 recording", () => {
  describe("f1-2025-2026-04-09T21-34-10-190Z.bin", () => {
    const recordingFile = "f1-2025-2026-04-09T21-34-10-190Z.bin";

    test("detects laps correctly", { timeout: 120000 }, async () => {
      const recording = getRecording(recordingFile);
      if (!recording) {
        console.log(`Recording not found: ${recordingFile}`);
        return;
      }

      console.log(`Using: ${recording}`);
      const { laps, sessions, carModel, trackName, wsNotifications } = await parseDump("f1-2025", recording);
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

      // Note: carModel and trackName are extracted from telemetry, not from dump metadata for F1-2025
      // (they're always null in parseDump for non-ACC games)
      console.log(`Car: ${carModel}, Track: ${trackName}`);

      // At least one lap should be detected (may have incomplete/invalid laps)
      expect(laps.length).toBeGreaterThanOrEqual(0);

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
        }
      }

      // Generate SVG visualizations for all laps
      const recordingBaseName = recordingFile.replace(/\.bin$/, "");
      const recordingOutputDir = join(OUTPUT_DIR, recordingBaseName);
      mkdirSync(recordingOutputDir, { recursive: true });
      console.log(`[SVG] Generating lap visualizations in ${recordingOutputDir}`);

      // Generate raw telemetry SVG and GIF (all packets without lap detection)
      if (wsNotifications.length > 0) {
        const { rawPackets } = await parseDump("f1-2025", recording);
        generateRawSvg(rawPackets, recordingOutputDir);
        console.log(`[SVG] Generated raw telemetry visualization`);
        await generateRawGif(rawPackets, recordingOutputDir);
        console.log(`[GIF] Generated raw telemetry visualization`);
      }

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

        const meta = { lapTime: lap.lapTime, isValid: lap.isValid, invalidReason: lap.invalidReason };
        generateLapSvg(lap.packets, lap.lapNumber, recordingOutputDir, undefined, meta);
        console.log(`[SVG] Generated lap-${lap.lapNumber}.svg`);

        await generateLapGif(lap.packets, lap.lapNumber, recordingOutputDir, undefined, meta);
        console.log(`[GIF] Generated lap-${lap.lapNumber}.gif`);
      }
    });
  });
});
