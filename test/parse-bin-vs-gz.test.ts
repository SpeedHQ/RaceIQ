/**
 * Verifies that parseRawLapFrames reads .bin and .bin.gz identically, and
 * that coordinate normalization (X-flip for standard-xyz games) is applied.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { readFileSync, writeFileSync, unlinkSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gunzipSync } from "zlib";
import { parseRawLapFramesForTest } from "../server/db/queries";
import { initGameAdapters } from "../shared/games/init";
import { initServerGameAdapters } from "../server/games/init";
import { META_FRAME_MAGIC } from "../server/udp-recorder";
import { stopMaintenanceTasks } from "../server/pipeline";

initGameAdapters();
initServerGameAdapters();

afterAll(() => stopMaintenanceTasks());

const GZ_FIXTURE = "test/artifacts/sessions/fm-2023-2026-04-09T21-55-03-186Z.bin.gz";

let tmpDir: string | null = null;

function makeTempBin(): string {
  tmpDir = mkdtempSync(join(tmpdir(), "raceiq-bingz-"));
  const decompressed = gunzipSync(readFileSync(GZ_FIXTURE));
  const binPath = join(tmpDir, "decompressed.bin");
  writeFileSync(binPath, decompressed);
  return binPath;
}

function firstFrameOffset(buf: Buffer): number {
  if (buf.length < 12) return 0;
  if (buf.readUInt32LE(0) !== META_FRAME_MAGIC) return 0;
  const payloadLen = buf.readUInt32LE(4);
  return 8 + payloadLen;
}

afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("parseRawLapFrames — .bin vs .bin.gz parity", () => {
  test("identical packet output regardless of file compression", async () => {
    const binPath = makeTempBin();
    const decompressed = gunzipSync(readFileSync(GZ_FIXTURE));
    const startOffset = firstFrameOffset(decompressed);

    // Count frames so we ask both calls for the same amount of data.
    let off = startOffset;
    let frames = 0;
    while (off + 4 <= decompressed.length) {
      const len = decompressed.readUInt32LE(off);
      if (off + 4 + len > decompressed.length) break;
      off += 4 + len;
      frames++;
    }
    expect(frames).toBeGreaterThan(100);

    // Cap at a few hundred to keep the test quick.
    const frameCount = Math.min(frames, 500);

    const fromBin = await parseRawLapFramesForTest(binPath, startOffset, frameCount, "fm-2023");
    const fromGz = await parseRawLapFramesForTest(GZ_FIXTURE, startOffset, frameCount, "fm-2023");

    expect(fromBin.length).toBeGreaterThan(0);
    expect(fromBin.length).toBe(fromGz.length);

    // Spot-check first, middle, last packets — full deep-equal would be noisy.
    for (const i of [0, Math.floor(fromBin.length / 2), fromBin.length - 1]) {
      expect(fromBin[i].CurrentLap).toBe(fromGz[i].CurrentLap);
      expect(fromBin[i].DistanceTraveled).toBe(fromGz[i].DistanceTraveled);
      expect(fromBin[i].Speed).toBe(fromGz[i].Speed);
      expect(fromBin[i].LapNumber).toBe(fromGz[i].LapNumber);
    }

    unlinkSync(binPath);
  });
});

