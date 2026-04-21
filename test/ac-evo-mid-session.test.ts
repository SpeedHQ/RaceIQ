/**
 * Tests for AC Evo session recorded mid-session.
 *
 * Regression fixture: user started recording after the session had already begun,
 * which exposes two behaviours:
 *   1. Compressed (.bin.gz) session files are decodable via the reprocess path.
 *   2. The lap detector initialises lapNumber at 0 regardless of the
 *      game-reported in-progress lap number (documented quirk).
 */
import { describe, test, expect, afterAll } from "bun:test";
import { readFileSync } from "fs";
import { gunzipSync } from "zlib";
import { initGameAdapters } from "../shared/games/init";
import { initServerGameAdapters } from "../server/games/init";
import { getServerGame } from "../server/games/registry";
import { CapturingDbAdapter } from "../server/pipeline-adapters";
import { LapDetectorAc } from "../server/lap-detector-ac";
import { META_FRAME_MAGIC } from "../server/udp-recorder";
import { stopMaintenanceTasks } from "../server/pipeline";
import type { TelemetryPacket } from "../shared/types";

afterAll(() => stopMaintenanceTasks());

const FIXTURE = "test/artifacts/laps/ac-evo-mid-session.bin.gz";

async function replaySessionBin(
  filePath: string,
  gameId: "ac-evo"
): Promise<{ packets: TelemetryPacket[]; laps: { lapNumber: number; lapTime: number; isValid: boolean }[] }> {
  initGameAdapters();
  initServerGameAdapters();

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
  const detector = new LapDetectorAc({ db });
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

  test("lap detector assigns lap numbers starting from 0 (known quirk for mid-session recordings)", async () => {
    const { laps } = await replaySessionBin(FIXTURE, "ac-evo");
    // Even though the recording starts mid-session, the lap detector's first
    // emitted lap is numbered 0 — it does not adopt the game-reported LapNumber.
    // This is the behaviour the user flagged: captured laps start at 0 instead
    // of matching the game's actual lap counter.
    expect(laps.length).toBeGreaterThan(0);
    expect(laps[0].lapNumber).toBe(0);
    // Laps are numbered sequentially from 0
    for (let i = 0; i < laps.length; i++) {
      expect(laps[i].lapNumber).toBe(i);
    }
  }, { timeout: 60_000 });

  test("lap 0 is the partial mid-session start (outlap, short distance)", async () => {
    const { laps } = await replaySessionBin(FIXTURE, "ac-evo");
    // Since recording began ~913m / 28.58s into the first lap, lap 0 only
    // captures the remaining portion of that lap — it should be shorter than
    // a full lap and ideally flagged invalid (partial outlap).
    expect(laps.length).toBeGreaterThanOrEqual(2);
    const firstFullLapTime = laps[1]?.lapTime ?? Infinity;
    expect(laps[0].lapTime).toBeLessThan(firstFullLapTime);
  }, { timeout: 60_000 });
});
