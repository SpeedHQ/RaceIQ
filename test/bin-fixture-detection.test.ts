/**
 * Regression coverage: every .bin.gz fixture in test/artifacts/sessions/
 * resolves to a real, non-sentinel game/track/car through its game's
 * production tryParse path (the same path import/reprocessing uses).
 *
 * Two on-disk formats exist and are auto-detected per fixture, not assumed:
 *   - "session capture": [meta frame][uint32 LE len][frame]... — for ACC/AC Evo
 *     the frame is a packed shared-memory triplet (pack-triplet.ts); for
 *     FM/F1 it's a raw UDP packet. This is what real session storage /
 *     import-capture.ts uses, and what the car/track re-derivation fix
 *     (server/games/acc/index.ts tryParse) targets.
 *   - "dump mode": ACCTEST-framed physics/graphics/static frames written by
 *     DumpToBinProcessor, read via readKunosFrames. Dev-only capture format,
 *     never fed through importSessionBin in production.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { readFileSync } from "fs";
import { gunzipSync } from "zlib";
import { initGameAdapters } from "../shared/games/init";
import { initServerGameAdapters } from "../server/games/init";
import { getServerGame } from "../server/games/registry";
import { getGame } from "../shared/games/registry";
import { stopMaintenanceTasks } from "../server/telemetry/live-pipeline"
import { META_FRAME_MAGIC } from "../server/session-capture/framing"
import { detectGameIdFromBuffer } from "../server/session-capture/import-capture"
import { getAccTrackName } from "../shared/racing/tracks/catalogs/acc"
import { getAccCarName } from "../shared/racing/cars/acc"
import { getAcEvoTrackName } from "../shared/racing/tracks/catalogs/ac-evo"
import { getAcEvoCarName } from "../shared/racing/cars/ac-evo"
import { readAccPackets, readAcEvoPackets } from "./helpers/parse-dump";
import { readUdpDump } from "./helpers/recording";
import { readIRacingFrames } from "../server/games/iracing/recorder";
import type { GameId } from "../shared/games/ids";
import type { TelemetryPacket } from "../shared/telemetry/types";

initGameAdapters();
initServerGameAdapters();

afterAll(() => stopMaintenanceTasks());

const DIR = "test/artifacts/sessions";

function gunzip(path: string): Buffer {
  return Buffer.from(gunzipSync(readFileSync(path)));
}

/** Session-capture framing: 12-byte meta frame, then repeated [len][frame]. */
function metaFrameStart(buf: Buffer): number {
  if (buf.length < 12 || buf.readUInt32LE(0) !== META_FRAME_MAGIC) return 0;
  return 8 + buf.readUInt32LE(4);
}

function hasMetaFrame(buf: Buffer): boolean {
  return buf.length >= 8 && buf.readUInt32LE(0) === META_FRAME_MAGIC;
}

/** Replays every frame of a session-capture .bin.gz through the game's real tryParse, exactly as import-capture.ts does. */
function parseSessionCapture(path: string, gameId: GameId): TelemetryPacket[] {
  const raw = gunzip(path);
  const serverGame = getServerGame(gameId);
  const state = serverGame.createParserState?.() ?? null;
  const packets: TelemetryPacket[] = [];
  let off = metaFrameStart(raw);
  while (off + 4 <= raw.length) {
    const frameLen = raw.readUInt32LE(off);
    off += 4;
    if (frameLen === META_FRAME_MAGIC) {
      off += 4 + raw.readUInt32LE(off);
      continue;
    }
    if (off + frameLen > raw.length) break;
    const pkt = serverGame.tryParse(raw.subarray(off, off + frameLen), state);
    off += frameLen;
    if (pkt) packets.push(pkt);
  }
  return packets;
}

/** Replays a raw-UDP-dump .bin.gz (FM/F1, no meta frame) through the game's real tryParse. */
function parseRawUdpDump(path: string, gameId: GameId): TelemetryPacket[] {
  const serverGame = getServerGame(gameId);
  const state = serverGame.createParserState?.() ?? null;
  const packets: TelemetryPacket[] = [];
  for (const buf of readUdpDump(path)) {
    const pkt = serverGame.tryParse(buf, state);
    if (pkt) packets.push(pkt);
  }
  return packets;
}

describe("bin-fixture-detection — every test/artifacts/sessions/*.bin.gz resolves game/track/car", () => {
  test("acc-2026-04-23T16-42-16-158Z.bin.gz — session-capture, ACC — CORROBORATED (test/acc-parser.test.ts)", () => {
    const file = `${DIR}/acc-2026-04-23T16-42-16-158Z.bin.gz`;
    expect(detectGameIdFromBuffer(readFileSync(file))).toBe("acc");
    expect(hasMetaFrame(gunzip(file))).toBe(true);

    const packets = parseSessionCapture(file, "acc");
    expect(packets.length).toBeGreaterThan(0);
    const last = packets[packets.length - 1]!;
    expect(getAccTrackName(last.TrackOrdinal)).toBe("Brands Hatch - GP");
    expect(getAccCarName(last.CarOrdinal)).toBe("McLaren 720S GT3 Evo 2023");
  });

  test("f1-2025-2026-04-22T11-42-43-029Z.bin.gz — session-capture, F1 2025 — REGRESSION-BASELINE ONLY", () => {
    const file = `${DIR}/f1-2025-2026-04-22T11-42-43-029Z.bin.gz`;
    expect(detectGameIdFromBuffer(readFileSync(file))).toBe("f1-2025");
    expect(hasMetaFrame(gunzip(file))).toBe(true);

    const packets = parseSessionCapture(file, "f1-2025");
    expect(packets.length).toBeGreaterThan(0);
    const last = packets[packets.length - 1]!;
    const adapter = getGame("f1-2025");
    expect(adapter.getTrackName(last.TrackOrdinal)).toBe("Autodromo Hermanos Rodriguez");
    expect(adapter.getCarName(last.CarOrdinal)).toBe("F1 World");
  });

  test("session-ac-evo-menu-exit-2026-04-23T18-11-48-959Z.bin.gz — session-capture, AC Evo — REGRESSION-BASELINE ONLY", () => {
    const file = `${DIR}/session-ac-evo-menu-exit-2026-04-23T18-11-48-959Z.bin.gz`;
    // Detected from frame content, not the filename — this fixture doesn't
    // follow the "<gameId>-" naming convention ("session-ac-evo-" prefix),
    // which would previously have made real import reject it outright.
    expect(detectGameIdFromBuffer(readFileSync(file))).toBe("ac-evo");
    expect(hasMetaFrame(gunzip(file))).toBe(true);

    const packets = parseSessionCapture(file, "ac-evo");
    expect(packets.length).toBeGreaterThan(0);
    const last = packets[packets.length - 1]!;
    expect(getAcEvoTrackName(last.TrackOrdinal)).toBe("Brands Hatch - GP");
    expect(getAcEvoCarName(last.CarOrdinal)).toBe("Porsche 992 GT3 R Rennsport");
  }, { timeout: 30000 });

  test("session-ac-evo-mid-2026-04-21T20-24-34-810Z.bin.gz — session-capture, AC Evo — REGRESSION-BASELINE ONLY", () => {
    const file = `${DIR}/session-ac-evo-mid-2026-04-21T20-24-34-810Z.bin.gz`;
    expect(detectGameIdFromBuffer(readFileSync(file))).toBe("ac-evo");
    expect(hasMetaFrame(gunzip(file))).toBe(true);

    const packets = parseSessionCapture(file, "ac-evo");
    expect(packets.length).toBeGreaterThan(0);
    const last = packets[packets.length - 1]!;
    expect(getAcEvoTrackName(last.TrackOrdinal)).toBe("Brands Hatch - GP");
    expect(getAcEvoCarName(last.CarOrdinal)).toBe("Porsche 992 GT3 R Rennsport");
  }, { timeout: 30000 });

  // Regression guard for the unknown-track / discovered-car fix. Before the fix
  // this capture's track re-derived as Unknown Track (ordinal -1); the fix
  // resolves it to Red Bull Ring - GP (ordinal 13) off the session frames.
  // Player car is a known ordinal (Audi R8 LMS GT3 Evo II → 68). The session
  // also contains an unknown car ("Grand Prix 2026 MCL40") which the DB reconcile
  // path registers as a discovered ordinal — that stateful path is covered by the
  // import/reconcile tests; here we assert the pure re-derivation the fix touched.
  test("ac-evo-unknown-track-session17.bin.gz — session-capture, AC Evo — track re-derivation fix (was Unknown Track)", () => {
    const file = `${DIR}/ac-evo-unknown-track-session17.bin.gz`;
    expect(detectGameIdFromBuffer(readFileSync(file))).toBe("ac-evo");
    expect(hasMetaFrame(gunzip(file))).toBe(true);

    const packets = parseSessionCapture(file, "ac-evo");
    expect(packets.length).toBeGreaterThan(0);
    const last = packets[packets.length - 1]!;
    // Track: the fix's core re-derivation. Every frame (incl. the last) now
    // resolves to Red Bull Ring - GP (ordinal 13); before the fix it was -1.
    expect(getAcEvoTrackName(last.TrackOrdinal)).toBe("Red Bull Ring - GP");

    // Car: assert on the dominant (player) car ordinal, not `last`. All but one
    // of the ~22.5k frames carry the player's Audi R8 (ordinal 68); the single
    // trailing frame is an unmapped car (-1) that the DB import path registers as
    // a discovered ordinal — a stateful step this pure-parse replay doesn't run.
    const carCounts = new Map<number, number>();
    for (const p of packets) carCounts.set(p.CarOrdinal, (carCounts.get(p.CarOrdinal) ?? 0) + 1);
    const playerCarOrdinal = [...carCounts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    expect(getAcEvoCarName(playerCarOrdinal)).toBe("Audi R8 LMS GT3 Evo II");
  }, { timeout: 30000 });

  test("f1-2025-2026-04-09T21-34-10-190Z.bin.gz — raw UDP dump, F1 2025 — REGRESSION-BASELINE ONLY", () => {
    const file = `${DIR}/f1-2025-2026-04-09T21-34-10-190Z.bin.gz`;
    expect(detectGameIdFromBuffer(readFileSync(file))).toBe("f1-2025");
    expect(hasMetaFrame(gunzip(file))).toBe(false);

    const packets = parseRawUdpDump(file, "f1-2025");
    expect(packets.length).toBeGreaterThan(0);
    const last = packets[packets.length - 1]!;
    const adapter = getGame("f1-2025");
    expect(adapter.getTrackName(last.TrackOrdinal)).toBe("Lusail International Circuit");
    expect(adapter.getCarName(last.CarOrdinal)).toBe("F1 World");
  }, { timeout: 60000 });

  test("fm-2023-2026-04-09T21-53-00-102Z.bin.gz — raw UDP dump, FM 2023 — REGRESSION-BASELINE ONLY", () => {
    const file = `${DIR}/fm-2023-2026-04-09T21-53-00-102Z.bin.gz`;
    expect(detectGameIdFromBuffer(readFileSync(file))).toBe("fm-2023");
    expect(hasMetaFrame(gunzip(file))).toBe(false);

    const packets = parseRawUdpDump(file, "fm-2023");
    expect(packets.length).toBeGreaterThan(0);
    const last = packets[packets.length - 1]!;
    const adapter = getGame("fm-2023");
    expect(adapter.getTrackName(last.TrackOrdinal)).toBe("Road America - East Route");
    expect(adapter.getCarName(last.CarOrdinal)).toBe("2022 Aston Martin Valkyrie AMR Pro");
  });

  test("fm-2023-2026-04-09T21-55-03-186Z.bin.gz — raw UDP dump, FM 2023 — REGRESSION-BASELINE ONLY (same car/track as 21-53-00 fixture, cross-consistent)", () => {
    const file = `${DIR}/fm-2023-2026-04-09T21-55-03-186Z.bin.gz`;
    expect(detectGameIdFromBuffer(readFileSync(file))).toBe("fm-2023");
    expect(hasMetaFrame(gunzip(file))).toBe(false);

    const packets = parseRawUdpDump(file, "fm-2023");
    expect(packets.length).toBeGreaterThan(0);
    const last = packets[packets.length - 1]!;
    const adapter = getGame("fm-2023");
    expect(adapter.getTrackName(last.TrackOrdinal)).toBe("Road America - East Route");
    expect(adapter.getCarName(last.CarOrdinal)).toBe("2022 Aston Martin Valkyrie AMR Pro");
  });

  test("ac-evo-2026-04-15T17-12-25-825Z.bin.gz — dump-mode, AC Evo — REGRESSION-BASELINE ONLY", () => {
    const file = `${DIR}/ac-evo-2026-04-15T17-12-25-825Z.bin.gz`;
    // Dump-mode frames aren't packed triplets, so frame-content detection
    // correctly finds no match — this format is dev-only and never goes
    // through the real "Import .bin" path (importSessionBin/canHandle).
    expect(detectGameIdFromBuffer(readFileSync(file))).toBeNull();
    expect(hasMetaFrame(gunzip(file))).toBe(false);

    const { packets } = readAcEvoPackets(file);
    expect(packets.length).toBeGreaterThan(0);
    const last = packets[packets.length - 1]!;
    // This recording's STATIC track field is empty in all 20k+ frames (the
    // game never populated it). It previously asserted "Monza - GP", but that
    // only passed because unidentified tracks defaulted to ordinal 0, which
    // happens to be Monza — the exact production bug where every unnamed
    // session imported as Monza. Unidentified must stay unidentified (-1).
    expect(last.TrackOrdinal).toBe(-1);
    expect(getAcEvoTrackName(last.TrackOrdinal)).toBe("Unknown Track");
    expect(getAcEvoCarName(last.CarOrdinal)).toBe("Porsche 992 GT3 R Rennsport");
  }, { timeout: 60000 });

  test("iracing-road-america-gt3.bin.gz — iRacing recorder fixture", () => {
    const file = `${DIR}/iracing-road-america-gt3.bin.gz`;
    // Dump containers intentionally remain separate from the production
    // length-prefixed session-import format.
    expect(detectGameIdFromBuffer(readFileSync(file))).toBeNull();
    expect(hasMetaFrame(gunzip(file))).toBe(false);

    const frames = readIRacingFrames(file);
    expect(frames).toHaveLength(138);
    const adapter = getServerGame("iracing");
    const state = adapter.createParserState?.() ?? null;
    const first = adapter.tryParse(frames[0], state);
    expect(first).toMatchObject({
      gameId: "iracing",
      CarOrdinal: 42,
      TrackOrdinal: 99,
    });
    expect(first?.iracing).toMatchObject({
      carName: "GT3 Test Car",
      trackName: "Road America",
    });
  });

  test("acc-2026-04-10T02-55-22-777Z.bin.gz — dump-mode, ACC — REGRESSION-BASELINE ONLY", () => {
    const file = `${DIR}/acc-2026-04-10T02-55-22-777Z.bin.gz`;
    expect(detectGameIdFromBuffer(readFileSync(file))).toBeNull();
    expect(hasMetaFrame(gunzip(file))).toBe(false);

    const { packets } = readAccPackets(file);
    expect(packets.length).toBeGreaterThan(0);
    const last = packets[packets.length - 1]!;
    expect(getAccTrackName(last.TrackOrdinal)).toBe("Brands Hatch - GP");
    expect(getAccCarName(last.CarOrdinal)).toBe("McLaren 720S GT3 Evo 2023");
  });

  test("acc-2026-04-10T02-59-28-972Z.bin.gz — dump-mode, ACC — CORROBORATED (test/e2e/acc/acc-2026-04-10T02-59-28-972Z.test.ts sector timing)", () => {
    const file = `${DIR}/acc-2026-04-10T02-59-28-972Z.bin.gz`;
    expect(detectGameIdFromBuffer(readFileSync(file))).toBeNull();
    expect(hasMetaFrame(gunzip(file))).toBe(false);

    const { packets } = readAccPackets(file);
    expect(packets.length).toBeGreaterThan(0);
    const last = packets[packets.length - 1]!;
    expect(getAccTrackName(last.TrackOrdinal)).toBe("Brands Hatch - GP");
    expect(getAccCarName(last.CarOrdinal)).toBe("McLaren 720S GT3 Evo 2023");
  }, { timeout: 30000 });

  test("acc-2026-04-12T21-16-07-841Z.bin.gz — dump-mode, ACC — REGRESSION-BASELINE ONLY (existing e2e test covers lap detection, not sectors)", () => {
    const file = `${DIR}/acc-2026-04-12T21-16-07-841Z.bin.gz`;
    expect(detectGameIdFromBuffer(readFileSync(file))).toBeNull();
    expect(hasMetaFrame(gunzip(file))).toBe(false);

    const { packets } = readAccPackets(file);
    expect(packets.length).toBeGreaterThan(0);
    const last = packets[packets.length - 1]!;
    expect(getAccTrackName(last.TrackOrdinal)).toBe("Brands Hatch - GP");
    expect(getAccCarName(last.CarOrdinal)).toBe("McLaren 720S GT3 Evo 2023");
  }, { timeout: 30000 });

  test("acc-2026-04-12T21-44-38-899Z.bin.gz — dump-mode, ACC — CORROBORATED (test/e2e/acc/acc-2026-04-12T21-44-38-899Z.test.ts sector timing)", () => {
    const file = `${DIR}/acc-2026-04-12T21-44-38-899Z.bin.gz`;
    expect(detectGameIdFromBuffer(readFileSync(file))).toBeNull();
    expect(hasMetaFrame(gunzip(file))).toBe(false);

    const { packets } = readAccPackets(file);
    expect(packets.length).toBeGreaterThan(0);
    const last = packets[packets.length - 1]!;
    expect(getAccTrackName(last.TrackOrdinal)).toBe("Brands Hatch - GP");
    expect(getAccCarName(last.CarOrdinal)).toBe("McLaren 720S GT3 Evo 2023");
  }, { timeout: 30000 });

  // Dump-mode ACCTEST v2 header, but the frame stream is corrupt: readKunosFrames
  // scans past two zero-length placeholder physics frames straight into
  // non-frame garbage (frame type byte 176) a handful of bytes later, aborts
  // its frameCount scan, and never emits a single physics+graphics+static
  // triplet. No other test in the suite references this fixture either —
  // it appears to be an incomplete/corrupted capture, not a fixture worth
  // asserting a fake baseline against.
  test.skip("acc-2026-04-10T02-28-56-651Z.bin.gz — SKIPPED: dump-mode ACCTEST v2 frame stream is corrupt, readKunosFrames yields 0 triplets", () => {});
});
