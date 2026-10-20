import { f1ServerAdapter } from "../src/index";
import { registerGame } from "@raceiq/shared/games/registry";
import { registerServerGame } from "@raceiq/backend-core/games/registry";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { getServerGame } from "@raceiq/backend-core/games/registry";
import { normalizeTelemetryPacket } from "@raceiq/telemetry-core/telemetry/normalization";
import { stopMaintenanceTasks } from "@raceiq/backend-core/telemetry/live-pipeline";
import { parseRawLapFrames } from "@raceiq/backend-core/db/telemetry-replay-storage";
import { loadSessionCapture } from "@raceiq/backend-core/session-capture/source-loader";
import { iterateSessionFrameRecords, iterateSessionFrames, readFrameStreamStart } from "@raceiq/capture-formats/session/framing";
import { readSessionPackets } from "@raceiq/backend-core/test-support/recordings/session-frames";
import { getRecordingFixture } from "@raceiq/backend-core/test-support/recordings/fixtures";
import { SparseSessionRecorder } from "@raceiq/capture-formats/session/sparse-recorder";

import { F1StateAccumulator } from "../src/f1-state";
function readLegacyPackets(recording: string): TelemetryPacket[] {
  const packets = readSessionPackets(recording, f1ServerAdapter);
  const game = getServerGame("f1-2025");
  for (const packet of packets) {
    normalizeTelemetryPacket(packet, game.coordSystem === "standard-xyz", game.runtime.normSuspensionTravelMm);
  }
  return packets;
}
async function makeSparseFixture(recording: string): Promise<{ path: string; cleanup(): void }> {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-f1-sparse-test-"));
  const path = join(directory, "capture.bin");
  const recorder = new SparseSessionRecorder("f1-2025");
  try {
    recorder.start(path);
    recorder.writeMetaFrame();
    for (const frame of iterateSessionFrames(gunzipSync(readFileSync(recording)))) recorder.writeRecord(frame);
    await recorder.stop();
    return { path, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) {
    try {
      await recorder.stop();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    throw error;
  }
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
      const legacyPackets = readLegacyPackets(recording);
      expect(legacyPackets.length).toBeGreaterThan(0);
      const sparse = await makeSparseFixture(recording);
      const originalNow = Date.now;
      Date.now = () => 1_000_000_000;
      try {
        const source = {
          rawFile: sparse.path,
          source: null,
          gameId: "f1-2025" as const,
          carId: "",
          trackId: "",
        };
        const capture = await loadSessionCapture(source);
        const records = [...iterateSessionFrameRecords(
          capture,
          readFrameStreamStart(capture),
          { skipMetaFrames: true },
        )];
        expect(records.length).toBeGreaterThan(0);
        const replayed = await parseRawLapFrames(source, records[0].offset, records.length);
        expect(replayed).toEqual(legacyPackets);
        const replayRecords = records.slice(0, 36);
        expect(replayRecords.length).toBeGreaterThan(24);
        const split = 12;
        const continuous = new F1StateAccumulator();
        const uninterrupted = replayRecords.map((record) =>
          f1ServerAdapter.tryParse(record.frame, continuous));
        const prefixState = new F1StateAccumulator();
        for (const record of replayRecords.slice(0, split)) f1ServerAdapter.tryParse(record.frame, prefixState);
        const restoredState = new F1StateAccumulator();
        restoredState.restoreCheckpoint(prefixState.captureCheckpoint());
        const continuousSuffix = replayRecords.slice(split).map((record) =>
          f1ServerAdapter.tryParse(record.frame, prefixState));
        const restoredSuffix = replayRecords.slice(split).map((record) =>
          f1ServerAdapter.tryParse(record.frame, restoredState));
        expect(uninterrupted.slice(split)).toEqual(continuousSuffix);
        expect(restoredSuffix).toEqual(continuousSuffix);
      } finally {
        Date.now = originalNow;
        sparse.cleanup();
      }
    }, { timeout: 180_000 });
  }
});
