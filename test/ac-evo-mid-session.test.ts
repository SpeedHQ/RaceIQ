/**
 * Tests for AC Evo session recorded mid-session.
 *
 * Regression fixture: user started recording after the session had already begun.
 * Verifies:
 *   1. Compressed (.bin.gz) session files are decodable via the reprocess path.
 *   2. Lap detector adopts the game-reported LapNumber at session start so
 *      mid-race recordings match the game's lap counter.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { readFileSync } from "fs";
import { gunzipSync } from "zlib";
import { initGameAdapters } from "../shared/games/init";
import { initServerGameAdapters } from "../server/games/init";
import { getServerGame } from "../server/games/registry";
import { CapturingDbAdapter } from "../server/pipeline-adapters";
import { LapDetectorAcEvo } from "../server/lap-detector-ac-evo";
import { META_FRAME_MAGIC } from "../server/udp-recorder";
import { stopMaintenanceTasks } from "../server/pipeline";
import { parseRawLapFramesForTest } from "../server/db/queries";
import type { TelemetryPacket } from "../shared/types";

initGameAdapters();
initServerGameAdapters();

afterAll(() => stopMaintenanceTasks());

const FIXTURE = "test/artifacts/sessions/session-ac-evo-mid-2026-04-21T20-24-34-810Z.bin.gz";

async function replaySessionBin(
  filePath: string,
  gameId: "ac-evo"
): Promise<{ packets: TelemetryPacket[]; laps: { lapNumber: number; lapTime: number; isValid: boolean }[] }> {

  const raw = readFileSync(filePath);
  const buf: Buffer = filePath.endsWith(".gz") ? Buffer.from(gunzipSync(raw)) : raw;

  // Skip meta frame at offset 0 if present: [0xFFFFFFFF][payloadLen][payload]
  let offset = 0;
  if (buf.length >= 8 && buf.readUInt32LE(0) === META_FRAME_MAGIC) {
    const payloadLen = buf.readUInt32LE(4);
    offset = 8 + payloadLen;
  }

  const serverGame = getServerGame(gameId);
  const parserState = serverGame.createParserState?.() ?? null;

  const db = new CapturingDbAdapter();
  const detector = new LapDetectorAcEvo({ db });
  const packets: TelemetryPacket[] = [];

  while (offset < buf.length) {
    if (offset + 4 > buf.length) break;
    const frameLen = buf.readUInt32LE(offset);
    if (frameLen === META_FRAME_MAGIC) {
      if (offset + 8 > buf.length) break;
      const payloadLen = buf.readUInt32LE(offset + 4);
      offset += 8 + payloadLen;
      continue;
    }
    offset += 4;
    if (offset + frameLen > buf.length) break;
    const frameBuf = buf.subarray(offset, offset + frameLen);
    const frameStart = offset - 4;
    offset += frameLen;

    const packet = serverGame.tryParse(frameBuf, parserState);
    if (packet) {
      packets.push(packet);
      await detector.feed(packet, frameStart);
    }
  }

  await detector.flushIncompleteLap?.();

  const laps = db.laps.map((l) => ({
    lapNumber: l.lapNumber,
    lapTime: l.lapTime,
    isValid: l.isValid,
  }));

  return { packets, laps };
}

describe("parseRawLapFrames — coordinate normalization (standard-xyz)", () => {
  test("AC Evo PositionX/VelocityX/AccelerationX are X-flipped vs raw tryParse output", async () => {
    const raw = Buffer.from(gunzipSync(readFileSync(FIXTURE)));
    const startOffset = 8 + raw.readUInt32LE(4); // skip meta frame

    const serverGame = getServerGame("ac-evo");
    const rawPackets: ReturnType<typeof serverGame.tryParse>[] = [];
    let off = startOffset;
    const N = 20;
    while (rawPackets.length < N && off + 4 <= raw.length) {
      const frameLen = raw.readUInt32LE(off);
      off += 4;
      if (off + frameLen > raw.length) break;
      const pkt = serverGame.tryParse(raw.subarray(off, off + frameLen), null);
      off += frameLen;
      if (pkt) rawPackets.push(pkt);
    }
    expect(rawPackets.length).toBe(N);

    const normalized = await parseRawLapFramesForTest(FIXTURE, startOffset, N, "ac-evo");
    expect(normalized.length).toBe(N);

    for (let i = 0; i < N; i++) {
      const r = rawPackets[i]!;
      const n = normalized[i];
      expect(n.PositionX).toBeCloseTo(-r.PositionX, 4);
      expect(n.VelocityX).toBeCloseTo(-r.VelocityX, 4);
      expect(n.AccelerationX).toBeCloseTo(-r.AccelerationX, 4);
      expect(n.PositionY).toBeCloseTo(r.PositionY, 4);
      expect(n.PositionZ).toBeCloseTo(r.PositionZ, 4);
    }
  }, { timeout: 60000 });
});

describe("AC Evo mid-session recording", () => {
  test("reads .bin.gz fixture and decodes packets", async () => {
    const { packets } = await replaySessionBin(FIXTURE, "ac-evo");
    expect(packets.length).toBeGreaterThan(0);
  }, { timeout: 60_000 });

  test("recorded packets contain an in-progress lap number from the game", async () => {
    const { packets } = await replaySessionBin(FIXTURE, "ac-evo");
    // The user started recording mid-session; the game should report a non-zero
    // LapNumber (completed laps count) on at least some packets.
    const maxGameLapNumber = Math.max(...packets.map((p) => p.LapNumber ?? 0));
    expect(maxGameLapNumber).toBeGreaterThan(0);
  }, { timeout: 60_000 });

  test("lap detector uses game-reported lap numbers (LapNumber = completedLaps + 1)", async () => {
    const { packets, laps } = await replaySessionBin(FIXTURE, "ac-evo");
    // Recording starts mid-session; game's first-packet LapNumber tells us how
    // many laps were already completed. Detector should adopt that numbering.
    expect(laps.length).toBeGreaterThan(0);
    const firstGameLapNumber = packets[0]?.LapNumber ?? 0;
    // First emitted lap = the lap in progress when recording started.
    // currentLapNumber init = firstGameLapNumber (already 1-indexed via completedLaps+1 in parser)
    expect(laps[0].lapNumber).toBe(firstGameLapNumber);
    // Laps are sequential from there
    for (let i = 1; i < laps.length; i++) {
      expect(laps[i].lapNumber).toBe(laps[i - 1].lapNumber + 1);
    }
  }, { timeout: 60_000 });

  test("first emitted lap is shorter than subsequent laps (partial mid-session start)", async () => {
    const { laps } = await replaySessionBin(FIXTURE, "ac-evo");
    // Recording began mid-lap, so the first captured lap is shorter than a full lap.
    expect(laps.length).toBeGreaterThanOrEqual(2);
    expect(laps[0].lapTime).toBeLessThan(laps[1].lapTime);
  }, { timeout: 90_000 });
});
