/**
 * Replay an F1 2025 fixture through live pipeline and verify completed laps
 * persist sectors resolved from semantic telemetry.
 *
 * Fixture: test/artifacts/sessions/f1-2025-2026-04-22T11-42-43-029Z.bin.gz
 *   Track 19 (Las Vegas), car 41, five laps. Recorded 2026-04-22 11:42:43.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
import { getServerGame } from "../../server/games/registry";
import { CapturingDbAdapter, CapturingWsAdapter, NullSessionRecorderAdapter } from "../../server/telemetry/pipeline-ports";
import { LiveTelemetryPipeline, stopMaintenanceTasks } from "../../server/telemetry/live-pipeline";
import { META_FRAME_MAGIC } from "../../server/session-capture/framing";

initGameAdapters();
initServerGameAdapters();

afterAll(() => stopMaintenanceTasks());

const FIXTURE = "test/artifacts/sessions/f1-2025-2026-04-22T11-42-43-029Z.bin.gz";

interface ReplayedLap {
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
  sectors: number[] | null;
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
  const pipeline = new LiveTelemetryPipeline(db, ws, { bypassPacketRateFilter: true, skipHistorySeeding: true, skipDevState: true, recorder: new NullSessionRecorderAdapter() });

  while (offset + 4 <= buf.length) {
    const len = buf.readUInt32LE(offset);
    if (offset + 4 + len > buf.length) break;
    const sourceFrame = buf.subarray(offset + 4, offset + 4 + len);
    offset += 4 + len;
    const packet = serverGame.tryParse(sourceFrame, parserState);
    if (!packet) continue;
    await pipeline.processPacket(packet);
  }

  await pipeline.flushIncompleteLap();
  await new Promise<void>((r) => setTimeout(r, 0));

  const laps: ReplayedLap[] = [];
  for (const saved of db.laps) {
    laps.push({
      lapNumber: saved.lapNumber,
      lapTime: saved.lapTime,
      isValid: saved.isValid,
      sectors: saved.sectors ?? null,
    });
  }
  cachedReplay = laps;
  return laps;
}

describe("F1 2025 session 2026-04-22 11:42 — lap times and sector splits", () => {
  test(
    "replay produces five completed laps",
    async () => {
      const laps = await replay();
      const completed = laps.filter((l) => l.lapTime > 0 && l.isValid);
      expect(completed.length).toBeGreaterThanOrEqual(5);
    },
    { timeout: 180_000 },
  );

  test(
    "persists semantic sector splits for every valid completed lap",
    async () => {
      const laps = await replay();
      for (const lap of laps) {
        if (!lap.isValid || lap.lapTime <= 0) continue;
        expect(lap.sectors).not.toBeNull();
        if (!lap.sectors) continue;
        const sum = lap.sectors.reduce((total, time) => total + time, 0);
        expect(sum).toBeCloseTo(lap.lapTime, 2);
      }
    },
    { timeout: 180_000 },
  );

  test(
    "semantic sector splits stay positive and plausible",
    async () => {
      const laps = await replay();
      for (const lap of laps) {
        if (!lap.isValid || lap.lapTime <= 0) continue;
        expect(lap.sectors?.every((time) => time > 10)).toBe(true);
      }
    },
    { timeout: 180_000 },
  );
});
