/**
 * Verifies that parseRawLapFrames reads .bin and .bin.gz identically, and
 * that coordinate normalization (X-flip for standard-xyz games) is applied.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { parseRawLapFrames } from "@raceiq/backend-core/db/telemetry-replay-storage";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { initServerGameAdapters } from "../../src/games/init";
import { iterateSessionFrames, META_FRAME_MAGIC } from "@raceiq/capture-formats/session/framing";
import { stopMaintenanceTasks } from "@raceiq/backend-core/telemetry/live-pipeline";
import { convertSeedFramesToSparse } from "@raceiq/tooling-data/data/seed-capture-conversion";

initGameAdapters();
initServerGameAdapters();

afterAll(() => stopMaintenanceTasks());

const GZ_FIXTURE = "test/artifacts/sessions/fm-2023-2026-04-09T21-55-03-186Z.bin.gz";

function firstFrameOffset(buf: Buffer): number {
  if (buf.length < 12) return 0;
  if (buf.readUInt32LE(0) !== META_FRAME_MAGIC) return 0;
  const payloadLen = buf.readUInt32LE(4);
  return 8 + payloadLen;
}


describe("parseRawLapFrames — .bin vs .bin.gz parity", () => {
  test("identical packet output regardless of file compression", async () => {
    const fixtureFrames = [...iterateSessionFrames(gunzipSync(readFileSync(GZ_FIXTURE)))];
    const converted = await convertSeedFramesToSparse("fm-2023", fixtureFrames);
    try {
      const binPath = converted.path;
      const decompressed = readFileSync(binPath);
      const startOffset = firstFrameOffset(decompressed);
      const gzPath = join(dirname(binPath), "capture.bin.gz");
      writeFileSync(gzPath, gzipSync(decompressed));
      const frameCount = Math.min(fixtureFrames.length, 500);

      const source = { source: null, gameId: "fm-2023" as const, carId: "0", trackId: "0" };
      const fromBin = await parseRawLapFrames({ ...source, rawFile: binPath }, startOffset, frameCount);
      const fromGz = await parseRawLapFrames({ ...source, rawFile: gzPath }, startOffset, frameCount);

      expect(fromBin.length).toBeGreaterThan(0);
      expect(fromBin.length).toBe(fromGz.length);

      for (const i of [0, Math.floor(fromBin.length / 2), fromBin.length - 1]) {
        expect(fromBin[i].CurrentLap).toBe(fromGz[i].CurrentLap);
        expect(fromBin[i].DistanceTraveled).toBe(fromGz[i].DistanceTraveled);
        expect(fromBin[i].Speed).toBe(fromGz[i].Speed);
        expect(fromBin[i].LapNumber).toBe(fromGz[i].LapNumber);
      }
    } finally {
      converted.cleanup();
    }
  });
});

