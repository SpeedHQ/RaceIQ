/**
 * Replay a real F1 2025 session through the full pipeline and assert that
 * the emitted laps match the game's own lap timing and sector splits.
 *
 * Fixture: test/artifacts/sessions/f1-2025-2026-04-22T11-42-43-029Z.bin.gz
 *   Track 19 (Las Vegas), car 41, five laps. Recorded 2026-04-22 11:42:43.
 *
 * Expected values come straight from the F1 SessionHistory packet captured in
 * the recording — they are the game's authoritative per-lap sector splits,
 * not distance-fraction estimates. This test locks in that the replay path
 * reproduces those numbers.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { readFileSync } from "fs";
import { gunzipSync } from "zlib";
import { initGameAdapters } from "../shared/games/init";
import { initServerGameAdapters } from "../server/games/init";
import { getServerGame } from "../server/games/registry";
import { CapturingDbAdapter, CapturingWsAdapter, NullSessionRecorderAdapter } from "../server/pipeline-adapters";
import { Pipeline } from "../server/pipeline";
import { computeLapSectors } from "../server/compute-lap-sectors";
import { META_FRAME_MAGIC } from "../server/udp-recorder";
import { stopMaintenanceTasks } from "../server/pipeline";
import type { TelemetryPacket } from "../shared/types";

initGameAdapters();
initServerGameAdapters();

afterAll(() => stopMaintenanceTasks());

const FIXTURE = "test/artifacts/sessions/f1-2025-2026-04-22T11-42-43-029Z.bin.gz";

interface ReplayedLap {
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
  sectors: { s1: number; s2: number; s3: number } | null;
  packets: TelemetryPacket[];
}

let cachedReplay: ReplayedLap[] | null = null;

async function replay(): Promise<ReplayedLap[]> {
  if (cachedReplay) return cachedReplay;

  const raw = readFileSync(FIXTURE);
  const buf = Buffer.from(gunzipSync(raw));

  let offset = 0;
  if (buf.length >= 8 && buf.readUInt32LE(0) === META_FRAME_MAGIC) {
    offset = 8 + buf.readUInt32LE(4);
  }

  const serverGame = getServerGame("f1-2025");
  const parserState = serverGame.createParserState?.() ?? null;
  const db = new CapturingDbAdapter();
  const ws = new CapturingWsAdapter();
  const pipeline = new Pipeline(db, ws, { bypassPacketRateFilter: true, skipHistorySeeding: true, skipDevState: true, recorder: new NullSessionRecorderAdapter() });

  // Accumulate packets per (detected) lap number so we can rerun sector
  // computation against just the emitted-lap packets.
  const packetsByLap = new Map<number, TelemetryPacket[]>();
  let lastLapNum = -1;

  while (offset + 4 <= buf.length) {
    const len = buf.readUInt32LE(offset);
    if (offset + 4 + len > buf.length) break;
    const frameBuf = buf.subarray(offset + 4, offset + 4 + len);
    offset += 4 + len;
    const packet = serverGame.tryParse(frameBuf, parserState);
    if (!packet) continue;
    await pipeline.processPacket(packet);
    if (packet.LapNumber !== lastLapNum) lastLapNum = packet.LapNumber;
    const bucket = packetsByLap.get(packet.LapNumber) ?? [];
    bucket.push(packet);
    packetsByLap.set(packet.LapNumber, bucket);
  }

  await pipeline.flushIncompleteLap();
  await new Promise<void>((r) => setTimeout(r, 0));

  const laps: ReplayedLap[] = [];
  for (const saved of db.laps) {
    const packets = packetsByLap.get(saved.lapNumber) ?? [];
    laps.push({
      lapNumber: saved.lapNumber,
      lapTime: saved.lapTime,
      isValid: saved.isValid,
      sectors: saved.sectors ?? null,
      packets,
    });
  }
  cachedReplay = laps;
  return laps;
}

describe("F1 2025 session 2026-04-22 11:42 — lap times and sector splits", () => {
  test("replay produces five completed laps", async () => {
    const laps = await replay();
    const completed = laps.filter((l) => l.lapTime > 0 && l.isValid);
    expect(completed.length).toBeGreaterThanOrEqual(5);
  }, { timeout: 180_000 });

  test("every emitted lap's sectors sum to its lap time", async () => {
    const laps = await replay();
    for (const lap of laps) {
      if (!lap.isValid || !lap.sectors || lap.lapTime <= 0) continue;
      const sum = lap.sectors.s1 + lap.sectors.s2 + lap.sectors.s3;
      expect(sum).toBeCloseTo(lap.lapTime, 2);
    }
  }, { timeout: 180_000 });

  test("sanity: no valid lap has a sector under 10 seconds", async () => {
    // A sub-10s sector on a 1:19+ lap can only come from parser drift /
    // residual fields from the next lap (the symptom of the SessionHistory
    // 14-byte layout bug and the lastS1/lastS2 aliasing issue).
    const laps = await replay();
    for (const lap of laps) {
      if (!lap.isValid || !lap.sectors || lap.lapTime <= 0) continue;
      expect(lap.sectors.s1).toBeGreaterThan(10);
      expect(lap.sectors.s2).toBeGreaterThan(10);
      expect(lap.sectors.s3).toBeGreaterThan(10);
    }
  }, { timeout: 180_000 });

  test("sectors come from F1 SessionHistory / LapData (not distance-fraction)", async () => {
    const laps = await replay();
    // computeLapSectors with gameId='f1-2025' must never fall back to the
    // distance-fraction branch. Running it against the emitted-lap packets
    // must produce the exact same sector values as the saved lap row.
    for (const lap of laps) {
      if (!lap.isValid || lap.packets.length < 50 || !lap.sectors) continue;
      const recomputed = await computeLapSectors(19, "f1-2025", lap.packets, lap.lapTime);
      expect(recomputed).not.toBeNull();
      expect(recomputed!.s1).toBeCloseTo(lap.sectors.s1, 2);
      expect(recomputed!.s2).toBeCloseTo(lap.sectors.s2, 2);
      expect(recomputed!.s3).toBeCloseTo(lap.sectors.s3, 2);
    }
  }, { timeout: 180_000 });

  test("per-lap sector times match F1 SessionHistory values from the fixture", async () => {
    const laps = await replay();
    // Expected sector splits pulled from the F1 SessionHistory packets in
    // this recording (i.e. what the game itself reports). Update whenever
    // the fixture changes.
    const expected: Record<number, { lapTime: number; s1: number; s2: number; s3: number }> = {
      1: { lapTime: 81.535, s1: 32.099, s2: 29.003, s3: 20.433 },
      2: { lapTime: 79.328, s1: 29.751, s2: 29.382, s3: 20.195 },
      3: { lapTime: 79.997, s1: 29.836, s2: 29.784, s3: 20.377 },
      4: { lapTime: 80.914, s1: 30.438, s2: 29.601, s3: 20.875 },
      5: { lapTime: 81.000, s1: 30.166, s2: 29.944, s3: 20.890 },
    };
    for (const lap of laps) {
      const want = expected[lap.lapNumber];
      if (!want) continue;
      expect(lap.lapTime).toBeCloseTo(want.lapTime, 2);
      if (lap.sectors) {
        expect(lap.sectors.s1).toBeCloseTo(want.s1, 2);
        expect(lap.sectors.s2).toBeCloseTo(want.s2, 2);
        expect(lap.sectors.s3).toBeCloseTo(want.s3, 2);
      }
    }
  }, { timeout: 180_000 });
});
