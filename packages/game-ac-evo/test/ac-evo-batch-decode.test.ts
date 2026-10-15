import { registerGame } from "@raceiq/shared/games/registry";
import { acEvoServerAdapter } from "../src/index";
import { registerServerGame } from "@raceiq/backend-core/games/registry";
/**
 * Parity test for parseSessionLapsBatched (single-pass multi-lap decode) vs the
 * per-lap parseRawLapFrames path. The batch decoder replaces the O(N²) "re-warm
 * the parser from file start for every lap" loop that made the tuning review
 * page slow to load 8 laps. It must produce byte-identical telemetry.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getServerGame } from "@raceiq/backend-core/games/registry";
import { CapturingDbAdapter } from "@raceiq/backend-core/telemetry/pipeline-ports"
import { LapDetectorAcEvo } from "../src/lap-detector"
import { iterateSessionCaptureRecords, iterateSessionFrames, META_FRAME_MAGIC } from "@raceiq/capture-formats/session/framing"
import { stopMaintenanceTasks } from "@raceiq/backend-core/telemetry/live-pipeline"
import { parseRawLapFrames, parseSessionLapsBatchedForTest } from "@raceiq/backend-core/db/telemetry-replay-storage";
import { parseAcEvoLapIndex } from "../src/lap-index";
import { createAcEvoParserCache, parseAcEvoBuffers } from "../src/parser";
import { unpackTriplet } from "@raceiq/capture-formats/kunos/pack-triplet";
import { loadSessionCapture, setCaptureFileFactoryForTest, clearSessionCaptureCache } from "@raceiq/backend-core/session-capture/source-loader";
import { SparseSessionRecorder } from "@raceiq/capture-formats/session/sparse-recorder";

registerGame(acEvoServerAdapter);
registerServerGame(acEvoServerAdapter);

afterAll(() => stopMaintenanceTasks());

const FIXTURE = "test/artifacts/sessions/session-ac-evo-mid-2026-04-21T20-24-34-810Z.bin.gz";
test("direct AC Evo lap index coordinates match full parser", () => {
  const buf = Buffer.from(gunzipSync(readFileSync(FIXTURE)));
  const fullCache = createAcEvoParserCache();
  const indexCache = createAcEvoParserCache();
  let offset = 0;

  while (offset + 4 <= buf.length) {
    const frameLen = buf.readUInt32LE(offset);
    if (frameLen === META_FRAME_MAGIC) {
      if (offset + 8 > buf.length) break;
      offset += 8 + buf.readUInt32LE(offset + 4);
      continue;
    }
    offset += 4;
    if (offset + frameLen > buf.length) break;
    const triplet = unpackTriplet(buf.subarray(offset, offset + frameLen));
    offset += frameLen;
    if (!triplet) continue;

    const full = parseAcEvoBuffers(triplet.physics, triplet.graphics, triplet.staticData, fullCache);
    const index = parseAcEvoLapIndex(triplet.physics, triplet.graphics, triplet.staticData, indexCache);
    if (full && index && full.PositionX !== 0 && full.PositionZ !== 0) {
      expect(index.PositionX).toBe(full.PositionX);
      expect(index.PositionZ).toBe(full.PositionZ);
      return;
    }
  }
  throw new Error("fixture had no non-zero AC Evo player coordinates");
});

/** Replay canonical capture records through the lap detector to recover real offsets/counts. */
async function detectLaps(path: string): Promise<{ rawByteOffset: number; rawFrameCount: number }[]> {
  const buf = readFileSync(path);
  const serverGame = getServerGame("ac-evo");
  const parserState = serverGame.createParserState?.() ?? null;
  const db = new CapturingDbAdapter();
  const detector = new LapDetectorAcEvo({ db });

  for (const record of iterateSessionCaptureRecords(buf)) {
    if (record.kind !== "frame") continue;
    const packet = serverGame.tryParse(record.frame, parserState);
    if (packet) await detector.feed(packet, record.offset);
  }
  await detector.flushIncompleteLap?.();

  return db.laps
    .filter((l) => l.rawByteOffset != null && l.rawFrameCount > 0)
    .map((l) => ({ rawByteOffset: l.rawByteOffset as number, rawFrameCount: l.rawFrameCount }));
}

async function makeSparseFixture(): Promise<{ path: string; cleanup(): void }> {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-ac-evo-sparse-test-"));
  const path = join(directory, "capture.bin");
  const recorder = new SparseSessionRecorder("ac-evo");
  try {
    recorder.start(path);
    recorder.writeMetaFrame();
    for (const frame of iterateSessionFrames(gunzipSync(readFileSync(FIXTURE)))) recorder.writeRecord(frame);
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

describe("parseSessionLapsBatched — parity with per-lap parseRawLapFrames", () => {
  test("batch decode of a stint matches lap-by-lap decode exactly", async () => {
    const originalNow = Date.now;
    Date.now = () => 1_000_000_000;
    const sparse = await makeSparseFixture();
    try {
      const laps = await detectLaps(sparse.path);
      expect(laps.length).toBeGreaterThanOrEqual(3);
      const sample = laps.slice(0, 6);
      const metas = sample.map((lap, index) => ({ id: index + 1, ...lap }));
      const source = { rawFile: sparse.path, source: null, gameId: "ac-evo" as const, carId: "", trackId: "" };
      const batch = await parseSessionLapsBatchedForTest(source, metas);

      for (const meta of metas) {
        const streamed = await parseRawLapFrames(source, meta.rawByteOffset, meta.rawFrameCount);
        const batched = batch.get(meta.id);
        expect(batched).toBeDefined();
        expect(batched).toEqual(streamed);
      }
    } finally {
      Date.now = originalNow;
      sparse.cleanup();
    }
  }, { timeout: 90_000 });
});

test("batch decode streams capture without materializing full file", async () => {
  const originalNow = Date.now;
  Date.now = () => 1_000_000_000;
  clearSessionCaptureCache();
  const sparse = await makeSparseFixture();
  setCaptureFileFactoryForTest((path) => {
    const file = Bun.file(path);
    return {
      size: file.size,
      lastModified: file.lastModified,
      slice: (start, end) => file.slice(start, end),
      stream: () => file.stream(),
      arrayBuffer: async () => { throw new Error("batch decode materialized entire capture"); },
    };
  });
  try {
    const laps = (await detectLaps(sparse.path)).slice(0, 2);
    const source = { rawFile: sparse.path, source: null, gameId: "ac-evo" as const, carId: "", trackId: "" };
    const metas = laps.map((lap, index) => ({ id: index + 1, ...lap }));
    const batch = await parseSessionLapsBatchedForTest(source, metas);
    for (const meta of metas) {
      expect(batch.get(meta.id)).toEqual(await parseRawLapFrames(source, meta.rawByteOffset, meta.rawFrameCount));
    }
  } finally {
    Date.now = originalNow;
    setCaptureFileFactoryForTest(null);
    clearSessionCaptureCache();
    sparse.cleanup();
  }
}, { timeout: 90_000 });
