import { afterAll, describe, expect, test } from "bun:test";
import type { TelemetryPacket } from "../../../shared/telemetry/types";
import { initGameAdapters } from "../../../shared/games/init";
import { initServerGameAdapters } from "../../../server/games/init";
import { getServerGame } from "../../../server/games/registry";
import { normalizeTelemetryPacket } from "../../../server/telemetry/normalization";
import { stopMaintenanceTasks } from "../../../server/telemetry/live-pipeline";
import { parseRawLapFramesFromBuffer } from "../../../server/db/telemetry-replay-storage";
import { loadSessionCapture } from "../../../server/session-capture/source-loader";
import { iterateSessionFrameRecords, readFrameStreamStart } from "../../../server/session-capture/framing";
import { readSessionPackets } from "../../support/recordings/session-frames";
import { getRecordingFixture } from "../../support/recordings/fixtures";

function readLegacyPackets(recording: string): TelemetryPacket[] {
  const packets = readSessionPackets(recording, "f1-2025");
  const game = getServerGame("f1-2025");
  for (const packet of packets) {
    normalizeTelemetryPacket(packet, game.coordSystem === "standard-xyz", game.runtime.normSuspensionTravelMm);
  }
  return packets;
}
initGameAdapters();
initServerGameAdapters();
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
