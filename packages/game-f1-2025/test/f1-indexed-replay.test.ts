import { f1ServerAdapter } from "../src/index";
import { registerGame } from "@raceiq/shared/games/registry";
import { registerServerGame } from "@raceiq/backend-core/games/registry";
import { afterAll, describe, expect, test } from "bun:test";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { getServerGame } from "@raceiq/backend-core/games/registry";
import { normalizeTelemetryPacket } from "@raceiq/backend-core/telemetry/normalization";
import { stopMaintenanceTasks } from "@raceiq/backend-core/telemetry/live-pipeline";
import { parseRawLapFramesFromBuffer } from "@raceiq/backend-core/db/telemetry-replay-storage";
import { loadSessionCapture } from "@raceiq/backend-core/session-capture/source-loader";
import { iterateSessionFrameRecords, readFrameStreamStart } from "@raceiq/backend-core/session-capture/framing";
import { readSessionPackets } from "@raceiq/backend-core/test-support/recordings/session-frames";
import { getRecordingFixture } from "@raceiq/backend-core/test-support/recordings/fixtures";

function readLegacyPackets(recording: string): TelemetryPacket[] {
  const packets = readSessionPackets(recording, f1ServerAdapter);
  const game = getServerGame("f1-2025");
  for (const packet of packets) {
    normalizeTelemetryPacket(packet, game.coordSystem === "standard-xyz", game.runtime.normSuspensionTravelMm);
  }
  return packets;
}
registerGame(f1ServerAdapter);
registerServerGame(f1ServerAdapter);
afterAll(() => stopMaintenanceTasks());

const FIXTURES = [
  "f1-2025-2026-04-09T21-34-10-190Z.bin.gz",
  "f1-2025-2026-04-22T11-42-43-029Z.bin.gz",
];

describe("F1 indexed replay parity", () => {
  for (const fixtureName of FIXTURES) {
    test(`${fixtureName} preserves every enumerable packet field`, async () => {
      const recording = getRecordingFixture(fixtureName);
      if (!recording) throw new Error(`Required recording fixture missing: ${fixtureName}`);
      const originalNow = Date.now;
      Date.now = () => 1_000_000_000;
      try {
        const legacyPackets = readLegacyPackets(recording);
        expect(legacyPackets.length).toBeGreaterThan(0);
        const capture = await loadSessionCapture({
          rawFile: recording,
          source: null,
          gameId: "f1-2025",
          carOrdinal: 0,
          trackOrdinal: 0,
        });
        const records = [...iterateSessionFrameRecords(
          capture,
          readFrameStreamStart(capture),
          { skipMetaFrames: true },
        )];
        expect(records.length).toBeGreaterThan(0);
        const replayed = parseRawLapFramesFromBuffer(
          capture,
          records[0].offset,
          records.length,
          "f1-2025",
          recording,
        );
        expect(replayed).toEqual(legacyPackets);
      } finally {
        Date.now = originalNow;
      }
    }, { timeout: 180_000 });
  }
});
