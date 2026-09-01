/**
 * Parity test for parseSessionLapsBatched (single-pass multi-lap decode) vs the
 * per-lap parseRawLapFrames path. The batch decoder replaces the O(N²) "re-warm
 * the parser from file start for every lap" loop that made the tuning review
 * page slow to load 8 laps. It must produce byte-identical telemetry.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { initGameAdapters } from "../../../shared/games/init";
import { initServerGameAdapters } from "../../../server/games/init";
import { getServerGame } from "../../../server/games/registry";
import { CapturingDbAdapter } from "../../../server/telemetry/pipeline-ports"
import { LapDetectorAcEvo } from "../../../server/games/ac-evo/lap-detector"
import { META_FRAME_MAGIC } from "../../../server/session-capture/framing"
import { stopMaintenanceTasks } from "../../../server/telemetry/live-pipeline"
import { parseRawLapFrames, parseRawLapFramesFromBuffer, parseSessionLapsBatchedForTest } from "../../../server/db/telemetry-replay-storage";
import { loadSessionCapture } from "../../../server/session-capture/source-loader";

initGameAdapters();
initServerGameAdapters();

afterAll(() => stopMaintenanceTasks());

const FIXTURE = "test/artifacts/sessions/session-ac-evo-mid-2026-04-21T20-24-34-810Z.bin.gz";

/** Replay the fixture through the lap detector to recover real per-lap byte
 *  offsets + frame counts (same values production stores on the laps table). */
async function detectLaps(): Promise<{ rawByteOffset: number; rawFrameCount: number }[]> {
  const buf = Buffer.from(gunzipSync(readFileSync(FIXTURE)));
  const serverGame = getServerGame("ac-evo");
  const parserState = serverGame.createParserState?.() ?? null;
  const db = new CapturingDbAdapter();
  const detector = new LapDetectorAcEvo({ db });

  let offset = 0;
  while (offset + 4 <= buf.length) {
    const frameLen = buf.readUInt32LE(offset);
    if (frameLen === META_FRAME_MAGIC) {
      if (offset + 8 > buf.length) break;
      const payloadLen = buf.readUInt32LE(offset + 4);
      offset += 8 + payloadLen;
      continue;
    }
    const frameStart = offset;
    offset += 4;
    if (offset + frameLen > buf.length) break;
    const sourceFrame = buf.subarray(offset, offset + frameLen);
    offset += frameLen;
    const packet = serverGame.tryParse(sourceFrame, parserState);
    if (packet) await detector.feed(packet, frameStart);
  }
  await detector.flushIncompleteLap?.();

  return db.laps
    .filter((l) => l.rawByteOffset != null && l.rawFrameCount > 0)
    .map((l) => ({ rawByteOffset: l.rawByteOffset as number, rawFrameCount: l.rawFrameCount }));
}

describe("parseSessionLapsBatched — parity with per-lap parseRawLapFrames", () => {
  test("batch decode of a stint matches lap-by-lap decode exactly", async () => {
    const laps = await detectLaps();
    expect(laps.length).toBeGreaterThanOrEqual(3);

    // Take up to the first 6 laps — enough to exercise the O(N²) warm-up path.
    const sample = laps.slice(0, 6);
    const metas = sample.map((l, i) => ({ id: i + 1, rawByteOffset: l.rawByteOffset, rawFrameCount: l.rawFrameCount }));

    const source = { rawFile: FIXTURE, source: null, gameId: "ac-evo" as const, carOrdinal: 0, trackOrdinal: 0 };
    const canonical = await loadSessionCapture(source);
    const batch = await parseSessionLapsBatchedForTest(source, metas);

    for (const meta of metas) {
      const buffered = parseRawLapFramesFromBuffer(canonical, meta.rawByteOffset, meta.rawFrameCount, "ac-evo", FIXTURE);
      const streamed = await parseRawLapFrames(source, meta.rawByteOffset, meta.rawFrameCount);
      const batched = batch.get(meta.id);
      expect(batched).toBeDefined();
      expect(streamed.length).toBe(buffered.length);
      expect(batched!.length).toBe(buffered.length);

      // Sample fields across the lap incl. state-dependent DistanceTraveled.
      const idxs = [0, Math.floor(buffered.length / 2), buffered.length - 1];
      for (const i of idxs) {
        for (const actual of [streamed[i], batched![i]]) {
          expect(actual.PositionX).toBeCloseTo(buffered[i].PositionX, 6);
          expect(actual.PositionZ).toBeCloseTo(buffered[i].PositionZ, 6);
          expect(actual.DistanceTraveled).toBeCloseTo(buffered[i].DistanceTraveled, 6);
          expect(actual.CurrentLap).toBeCloseTo(buffered[i].CurrentLap, 6);
          expect(actual.Speed).toBeCloseTo(buffered[i].Speed, 6);
        }
      }
    }
  }, { timeout: 90_000 });
});
