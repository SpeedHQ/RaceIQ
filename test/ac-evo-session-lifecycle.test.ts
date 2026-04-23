/**
 * AC Evo session lifecycle tests.
 *
 * Regression: sessions used to linger forever after the user exited to the main
 * menu, because LapDetectorAcEvo never nulled `currentSession` while the game
 * process was still running. The fix has two parts:
 *
 *   1. Parser returns null for status=AC_OFF and AC_REPLAY (packets dry up
 *      while in menu / replay viewer).
 *   2. LapDetectorAcEvo.flushStaleLap finalises the session after 10s of
 *      silence — which implies `finalizeCurrentSession` now nulls state.
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
import { parseAcEvoBuffers, createAcEvoParserCache } from "../server/games/ac-evo/parser";
import { ACEVO_STATUS, GRAPHICS_EVO } from "../server/games/ac-evo/structs";
import { unpackTriplet } from "../server/games/shared/pack-triplet";

initGameAdapters();
initServerGameAdapters();

afterAll(() => stopMaintenanceTasks());

const FIXTURE = "test/artifacts/sessions/session-ac-evo-mid-2026-04-21T20-24-34-810Z.bin.gz";

function readFirstTriplet(): { physics: Buffer; graphics: Buffer; staticData: Buffer } {
  const raw = Buffer.from(gunzipSync(readFileSync(FIXTURE)));
  const startOffset = 8 + raw.readUInt32LE(4);
  const frameLen = raw.readUInt32LE(startOffset);
  const frame = raw.subarray(startOffset + 4, startOffset + 4 + frameLen);
  const triplet = unpackTriplet(frame);
  if (!triplet) throw new Error("failed to unpack fixture triplet");
  // clone so overwriting status on one copy doesn't affect the next test
  return {
    physics: Buffer.from(triplet.physics),
    graphics: Buffer.from(triplet.graphics),
    staticData: Buffer.from(triplet.staticData),
  };
}

function setStatus(graphics: Buffer, status: number): Buffer {
  const copy = Buffer.from(graphics);
  copy.writeInt32LE(status, GRAPHICS_EVO.status.offset);
  return copy;
}

describe("AC Evo parser — status gating", () => {
  test("AC_LIVE packet is parsed", () => {
    const t = readFirstTriplet();
    const graphics = setStatus(t.graphics, ACEVO_STATUS.AC_LIVE);
    const packet = parseAcEvoBuffers(t.physics, graphics, t.staticData, createAcEvoParserCache());
    expect(packet).not.toBeNull();
    expect(packet!.IsRaceOn).toBe(1);
  });

  test("AC_PAUSE packet is still parsed (session must survive pause)", () => {
    const t = readFirstTriplet();
    const graphics = setStatus(t.graphics, ACEVO_STATUS.AC_PAUSE);
    const packet = parseAcEvoBuffers(t.physics, graphics, t.staticData, createAcEvoParserCache());
    expect(packet).not.toBeNull();
    expect(packet!.IsRaceOn).toBe(0);
  });

  test("AC_OFF packet returns null (user exited to main menu)", () => {
    const t = readFirstTriplet();
    const graphics = setStatus(t.graphics, ACEVO_STATUS.AC_OFF);
    const packet = parseAcEvoBuffers(t.physics, graphics, t.staticData, createAcEvoParserCache());
    expect(packet).toBeNull();
  });

  test("AC_REPLAY packet returns null (user in replay viewer)", () => {
    const t = readFirstTriplet();
    const graphics = setStatus(t.graphics, ACEVO_STATUS.AC_REPLAY);
    const packet = parseAcEvoBuffers(t.physics, graphics, t.staticData, createAcEvoParserCache());
    expect(packet).toBeNull();
  });
});

describe("AC Evo lap detector — session lifecycle", () => {
  test("flushStaleLap finalises session after 10s silence", async () => {
    const serverGame = getServerGame("ac-evo");
    const parserState = serverGame.createParserState?.() ?? null;

    const raw = Buffer.from(gunzipSync(readFileSync(FIXTURE)));
    const startOffset = 8 + raw.readUInt32LE(4);
    const frameLen = raw.readUInt32LE(startOffset);
    const frame = raw.subarray(startOffset + 4, startOffset + 4 + frameLen);
    const packet = serverGame.tryParse(frame, parserState);
    expect(packet).not.toBeNull();

    const db = new CapturingDbAdapter();
    const detector = new LapDetectorAcEvo({ db });

    await detector.feed(packet!);
    expect(detector.session).not.toBeNull();

    // Under 10s → session must still be alive
    (detector as any)._lastActivePacketTime = Date.now() - 5_000;
    await detector.flushStaleLap();
    expect(detector.session).not.toBeNull();

    // Over 10s → finalised
    (detector as any)._lastActivePacketTime = Date.now() - 11_000;
    await detector.flushStaleLap();
    expect(detector.session).toBeNull();

    // Re-feeding after finalise starts a fresh session (new sessionId)
    const firstId = 1;
    await detector.feed(packet!);
    expect(detector.session).not.toBeNull();
    expect(detector.session!.sessionId).not.toBe(firstId);
    // Also ensure db got a second insertSession
    expect(db.sessions.length).toBeGreaterThanOrEqual(2);

    // Silent finalize via finalizeCurrentSession directly
    await detector.finalizeCurrentSession();
    expect(detector.session).toBeNull();
  }, { timeout: 30_000 });
});

/**
 * End-to-end replay of a real recording covering:
 *   LIVE (in race) → PAUSE (pause menu) → OFF (exit to main menu)
 *
 * Captured frames:
 *   - status=2 (LIVE):   3203 frames
 *   - status=3 (PAUSE):  274  frames
 *   - status=0 (OFF):    8124 frames (user in main menu)
 *
 * Expected behaviour:
 *   - Parser gates out all 8124 OFF frames (returns null).
 *   - LIVE + PAUSE frames are parsed as normal.
 *   - Lap detector creates a session and later finalises it when packets stop
 *     arriving (menu exit → parser null → stale timer finalises).
 */
const MENU_EXIT_FIXTURE =
  "test/artifacts/sessions/session-ac-evo-menu-exit-2026-04-23T18-11-48-959Z.bin.gz";

describe("AC Evo menu-exit recording — e2e", () => {
  test("parser gates all AC_OFF frames, keeps LIVE/PAUSE", async () => {
    const raw = Buffer.from(gunzipSync(readFileSync(MENU_EXIT_FIXTURE)));
    let off = 8 + raw.readUInt32LE(4);

    const serverGame = getServerGame("ac-evo");
    const parserState = serverGame.createParserState?.() ?? null;

    const statusCounts: Record<number, { total: number; parsed: number }> = {};
    let totalFrames = 0;
    let totalParsed = 0;

    while (off < raw.length) {
      if (off + 4 > raw.length) break;
      const frameLen = raw.readUInt32LE(off);
      if (frameLen === META_FRAME_MAGIC) {
        off += 8 + raw.readUInt32LE(off + 4);
        continue;
      }
      off += 4;
      if (off + frameLen > raw.length) break;
      const frame = raw.subarray(off, off + frameLen);
      off += frameLen;

      const triplet = unpackTriplet(frame);
      if (!triplet) continue;
      const status = triplet.graphics.readInt32LE(GRAPHICS_EVO.status.offset);
      const packet = serverGame.tryParse(frame, parserState);
      if (!statusCounts[status]) statusCounts[status] = { total: 0, parsed: 0 };
      statusCounts[status].total++;
      if (packet) statusCounts[status].parsed++;
      totalFrames++;
      if (packet) totalParsed++;
    }

    // Fixture should contain all three states
    expect(statusCounts[ACEVO_STATUS.AC_LIVE]?.total).toBeGreaterThan(0);
    expect(statusCounts[ACEVO_STATUS.AC_PAUSE]?.total).toBeGreaterThan(0);
    expect(statusCounts[ACEVO_STATUS.AC_OFF]?.total).toBeGreaterThan(0);

    // LIVE + PAUSE always parse; OFF always returns null
    expect(statusCounts[ACEVO_STATUS.AC_LIVE].parsed)
      .toBe(statusCounts[ACEVO_STATUS.AC_LIVE].total);
    expect(statusCounts[ACEVO_STATUS.AC_PAUSE].parsed)
      .toBe(statusCounts[ACEVO_STATUS.AC_PAUSE].total);
    expect(statusCounts[ACEVO_STATUS.AC_OFF].parsed).toBe(0);

    const offTotal = statusCounts[ACEVO_STATUS.AC_OFF].total;
    expect(totalParsed).toBe(totalFrames - offTotal);
  }, { timeout: 60_000 });

  test("detector creates a session during LIVE and finalises after menu exit", async () => {
    const raw = Buffer.from(gunzipSync(readFileSync(MENU_EXIT_FIXTURE)));
    let off = 8 + raw.readUInt32LE(4);

    const serverGame = getServerGame("ac-evo");
    const parserState = serverGame.createParserState?.() ?? null;

    const db = new CapturingDbAdapter();
    const detector = new LapDetectorAcEvo({ db });

    let liveSeen = false;
    let firstSessionId: number | null = null;
    while (off < raw.length) {
      if (off + 4 > raw.length) break;
      const frameLen = raw.readUInt32LE(off);
      if (frameLen === META_FRAME_MAGIC) {
        off += 8 + raw.readUInt32LE(off + 4);
        continue;
      }
      off += 4;
      if (off + frameLen > raw.length) break;
      const frame = raw.subarray(off, off + frameLen);
      off += frameLen;

      const packet = serverGame.tryParse(frame, parserState);
      if (!packet) continue; // AC_OFF / AC_REPLAY → gated
      liveSeen = true;
      await detector.feed(packet);
      if (firstSessionId === null && detector.session) {
        firstSessionId = detector.session.sessionId;
      }
    }

    // Session opened while live packets flowed
    expect(liveSeen).toBe(true);
    expect(firstSessionId).not.toBeNull();
    expect(detector.session).not.toBeNull();

    // Simulate 11s of silence after menu exit — stale timer finalises session
    (detector as any)._lastActivePacketTime = Date.now() - 11_000;
    await detector.flushStaleLap();
    expect(detector.session).toBeNull();
    expect(db.sessions.length).toBeGreaterThanOrEqual(1);
  }, { timeout: 60_000 });
});
