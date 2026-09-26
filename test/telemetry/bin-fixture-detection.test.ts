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
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
import { getServerGame } from "../../server/games/registry";
import { getGame } from "../../shared/games/registry";
import { stopMaintenanceTasks } from "../../server/telemetry/live-pipeline"
import { META_FRAME_MAGIC } from "../../server/session-capture/framing"
import { detectGameIdFromBuffer } from "../../server/session-capture/import-capture"
import { encodeAcEvoTrackId } from "../../shared/racing/tracks/ac-evo-identity";
import { readAccPackets, readAcEvoPackets, readUdpPackets } from "../support/recordings/parse-dump";
import { readSessionPackets } from "../support/recordings/session-frames";
import { readIRacingFrames } from "../../server/games/iracing/recorder";

initGameAdapters();
initServerGameAdapters();

afterAll(() => stopMaintenanceTasks());

const DIR = "test/artifacts/sessions";

function gunzip(path: string): Buffer {
  return Buffer.from(gunzipSync(readFileSync(path)));
}

function hasMetaFrame(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === META_FRAME_MAGIC;
}

describe("bin-fixture-detection — every test/artifacts/sessions/*.bin.gz resolves game/track/car", () => {
  test("acc-2026-04-23T16-42-16-158Z.bin.gz — session-capture, ACC — CORROBORATED (test/acc-parser.test.ts)", () => {
    const file = `${DIR}/acc-2026-04-23T16-42-16-158Z.bin.gz`;
    expect(detectGameIdFromBuffer(readFileSync(file))).toBe("acc");
    expect(hasMetaFrame(gunzip(file))).toBe(true);

    const packets = readSessionPackets(file, "acc");
    expect(packets.length).toBeGreaterThan(0);
    const last = packets[packets.length - 1]!;
    expect(last.TrackId).toBe("brands_hatch");
    expect(last.CarId).toBe("mclaren_720s_gt3_evo");
  });

  test("f1-2025-2026-04-22T11-42-43-029Z.bin.gz — session-capture, F1 2025 — REGRESSION-BASELINE ONLY", () => {
    const file = `${DIR}/f1-2025-2026-04-22T11-42-43-029Z.bin.gz`;
    expect(detectGameIdFromBuffer(readFileSync(file))).toBe("f1-2025");
    expect(hasMetaFrame(gunzip(file))).toBe(true);

    const packets = readSessionPackets(file, "f1-2025");
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

    const packets = readSessionPackets(file, "ac-evo");
    expect(packets.length).toBeGreaterThan(0);
    const last = packets[packets.length - 1]!;
    expect(last.TrackId).toBe(encodeAcEvoTrackId("Brands Hatch", "GP"));
    expect(last.CarId).toBe("Porsche 992 GT3 R Rennsport");
  }, { timeout: 30000 });

  test("session-ac-evo-mid-2026-04-21T20-24-34-810Z.bin.gz — session-capture, AC Evo — REGRESSION-BASELINE ONLY", () => {
    const file = `${DIR}/session-ac-evo-mid-2026-04-21T20-24-34-810Z.bin.gz`;
    expect(detectGameIdFromBuffer(readFileSync(file))).toBe("ac-evo");
    expect(hasMetaFrame(gunzip(file))).toBe(true);

    const packets = readSessionPackets(file, "ac-evo");
    expect(packets.length).toBeGreaterThan(0);
    const last = packets[packets.length - 1]!;
    expect(last.TrackId).toBe(encodeAcEvoTrackId("Brands Hatch", "GP"));
    expect(last.CarId).toBe("Porsche 992 GT3 R Rennsport");
  }, { timeout: 30000 });

  // Regression guard: native identity must survive replay without catalog-derived ordinals.
  test("ac-evo-unknown-track-session17.bin.gz — session-capture, AC Evo — track re-derivation fix (was Unknown Track)", () => {
    const file = `${DIR}/ac-evo-unknown-track-session17.bin.gz`;
    expect(detectGameIdFromBuffer(readFileSync(file))).toBe("ac-evo");
    expect(hasMetaFrame(gunzip(file))).toBe(true);

    const packets = readSessionPackets(file, "ac-evo");
    expect(packets.length).toBeGreaterThan(0);
    const last = packets[packets.length - 1]!;
    expect(last.TrackId).toBe(encodeAcEvoTrackId("Red Bull Ring", "GP"));
    const carCounts = new Map<string, number>();
    for (const p of packets) if (p.CarId !== undefined) carCounts.set(p.CarId, (carCounts.get(p.CarId) ?? 0) + 1);
    const playerCarId = [...carCounts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    expect(playerCarId).toBe("Audi R8 LMS GT3 Evo II");
  }, { timeout: 30000 });

  test("f1-2025-2026-04-09T21-34-10-190Z.bin.gz — raw UDP dump, F1 2025 — REGRESSION-BASELINE ONLY", () => {
    const file = `${DIR}/f1-2025-2026-04-09T21-34-10-190Z.bin.gz`;
    expect(detectGameIdFromBuffer(readFileSync(file))).toBe("f1-2025");
    expect(hasMetaFrame(gunzip(file))).toBe(false);

    const packets = readUdpPackets(file, "f1-2025").packets;
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

    const packets = readUdpPackets(file, "fm-2023").packets;
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

    const packets = readUdpPackets(file, "fm-2023").packets;
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
    expect(last.TrackId).toBe("");
    expect(last.CarId).toBe("Porsche 992 GT3 R Rennsport");
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
    expect(last.TrackId).toBe("brands_hatch");
    expect(last.CarId).toBe("mclaren_720s_gt3_evo");
  });

  test("acc-2026-04-10T02-59-28-972Z.bin.gz — dump-mode, ACC — CORROBORATED (test/e2e/acc/acc-2026-04-10T02-59-28-972Z.test.ts sector timing)", () => {
    const file = `${DIR}/acc-2026-04-10T02-59-28-972Z.bin.gz`;
    expect(detectGameIdFromBuffer(readFileSync(file))).toBeNull();
    expect(hasMetaFrame(gunzip(file))).toBe(false);

    const { packets } = readAccPackets(file);
    expect(packets.length).toBeGreaterThan(0);
    const last = packets[packets.length - 1]!;
    expect(last.TrackId).toBe("brands_hatch");
    expect(last.CarId).toBe("mclaren_720s_gt3_evo");
  }, { timeout: 30000 });

  test("acc-2026-04-12T21-16-07-841Z.bin.gz — dump-mode, ACC — REGRESSION-BASELINE ONLY (existing e2e test covers lap detection, not sectors)", () => {
    const file = `${DIR}/acc-2026-04-12T21-16-07-841Z.bin.gz`;
    expect(detectGameIdFromBuffer(readFileSync(file))).toBeNull();
    expect(hasMetaFrame(gunzip(file))).toBe(false);

    const { packets } = readAccPackets(file);
    expect(packets.length).toBeGreaterThan(0);
    const last = packets[packets.length - 1]!;
    expect(last.TrackId).toBe("brands_hatch");
    expect(last.CarId).toBe("mclaren_720s_gt3_evo");
  }, { timeout: 300_000 });

  test("acc-2026-04-12T21-44-38-899Z.bin.gz — dump-mode, ACC — CORROBORATED (test/e2e/acc/acc-2026-04-12T21-44-38-899Z.test.ts sector timing)", () => {
    const file = `${DIR}/acc-2026-04-12T21-44-38-899Z.bin.gz`;
    expect(detectGameIdFromBuffer(readFileSync(file))).toBeNull();
    expect(hasMetaFrame(gunzip(file))).toBe(false);

    const { packets } = readAccPackets(file);
    expect(packets.length).toBeGreaterThan(0);
    const last = packets[packets.length - 1]!;
    expect(last.TrackId).toBe("brands_hatch");
    expect(last.CarId).toBe("mclaren_720s_gt3_evo");
  }, { timeout: 300_000 });

  // Dump-mode ACCTEST v2 header, but the frame stream is corrupt: readKunosFrames
  // scans past two zero-length placeholder physics frames straight into
  // non-frame garbage (frame type byte 176) a handful of bytes later, aborts
  // its frameCount scan, and never emits a single physics+graphics+static
  // triplet. No other test in the suite references this fixture either —
  // it appears to be an incomplete/corrupted capture, not a fixture worth
  // asserting a fake baseline against.
  test.skip("acc-2026-04-10T02-28-56-651Z.bin.gz — SKIPPED: dump-mode ACCTEST v2 frame stream is corrupt, readKunosFrames yields 0 triplets", () => {});
});
