import { getAccCarByModel } from "@raceiq/game-acc-metadata/racing/cars/acc";
import { getAccTrackByName } from "@raceiq/game-acc-metadata/racing/tracks/catalogs/acc";
import { readAccPackets } from "@raceiq/game-acc/test-support/recordings";
import { readAcEvoPackets } from "@raceiq/game-ac-evo/test-support/recordings";
import { accServerAdapter } from "@raceiq/game-acc";
import { f1ServerAdapter } from "@raceiq/game-f1-2025";
import { acEvoServerAdapter } from "@raceiq/game-ac-evo";
import { forzaServerAdapter } from "@raceiq/game-fm-2023";
/**
 * Historical source fixtures remain useful for parser and replay regressions.
 * They are full-frame or simulator dump recordings, not supported upload formats.
 * User imports require sparse RaceIQ session captures.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { initServerGameAdapters } from "../../src/games/init";
import { getServerGame } from "@raceiq/backend-core/games/registry";
import { getGame } from "@raceiq/shared/games/registry";
import { stopMaintenanceTasks } from "@raceiq/backend-core/telemetry/live-pipeline"
import { META_FRAME_MAGIC } from "@raceiq/capture-formats/session/framing"
import { detectGameIdFromBuffer } from "@raceiq/backend-core/session-capture/import-capture"
import { getAccTrackName } from "@raceiq/game-acc-metadata/racing/tracks/catalogs/acc"
import { getAccCarName } from "@raceiq/game-acc-metadata/racing/cars/acc"
import { getAcEvoTrackName } from "@raceiq/game-ac-evo-metadata/racing/tracks/catalogs/ac-evo"
import { getAcEvoCarName } from "@raceiq/game-ac-evo-metadata/racing/cars/ac-evo"
import { readUdpPackets } from "@raceiq/backend-core/test-support/recordings/parse-dump";
import { readSessionPackets } from "@raceiq/backend-core/test-support/recordings/session-frames";
import { readIRacingFrames } from "@raceiq/capture-formats/iracing/dump";

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

describe("legacy session fixtures remain parser-readable but are not upload formats", () => {
  test("acc-2026-04-23T16-42-16-158Z.bin.gz — session-capture, ACC — CORROBORATED (test/acc-parser.test.ts)", () => {
    const file = `${DIR}/acc-2026-04-23T16-42-16-158Z.bin.gz`;
    expect(detectGameIdFromBuffer(readFileSync(file))).toBeNull();
    expect(hasMetaFrame(gunzip(file))).toBe(true);

    const packets = readSessionPackets(file, accServerAdapter);
    expect(packets.length).toBeGreaterThan(0);
    const last = packets[packets.length - 1]!;
    expect(getAccTrackName(Number(last.trackId))).toBe("Brands Hatch - GP");
    expect(getAccCarName(Number(last.carId))).toBe("McLaren 720S GT3 Evo 2023");
  });

  test("f1-2025-2026-04-22T11-42-43-029Z.bin.gz — session-capture, F1 2025 — REGRESSION-BASELINE ONLY", () => {
    const file = `${DIR}/f1-2025-2026-04-22T11-42-43-029Z.bin.gz`;
    expect(detectGameIdFromBuffer(readFileSync(file))).toBeNull();
    expect(hasMetaFrame(gunzip(file))).toBe(true);

    const packets = readSessionPackets(file, f1ServerAdapter);
    expect(packets.length).toBeGreaterThan(0);
    const last = packets[packets.length - 1]!;
    const adapter = getGame("f1-2025");
    expect(adapter.getTrackName(last.trackId)).toBe("Autodromo Hermanos Rodriguez");
    expect(adapter.getCarName(last.carId)).toBe("F1 World");
  });

  test("session-ac-evo-menu-exit-2026-04-23T18-11-48-959Z.bin.gz — session-capture, AC Evo — REGRESSION-BASELINE ONLY", () => {
    const file = `${DIR}/session-ac-evo-menu-exit-2026-04-23T18-11-48-959Z.bin.gz`;
    // The parser still reads this legacy fixture; user imports reject it.
    expect(detectGameIdFromBuffer(readFileSync(file))).toBeNull();
    expect(hasMetaFrame(gunzip(file))).toBe(true);

    const packets = readSessionPackets(file, acEvoServerAdapter);
    expect(packets.length).toBeGreaterThan(0);
    const last = packets[packets.length - 1]!;
    expect(getAcEvoTrackName(last.trackId)).toBe("Brands Hatch - GP");
    expect(getAcEvoCarName(last.carId)).toBe("Porsche 992 GT3 R Rennsport");
  }, { timeout: 30000 });

  test("session-ac-evo-mid-2026-04-21T20-24-34-810Z.bin.gz — session-capture, AC Evo — REGRESSION-BASELINE ONLY", () => {
    const file = `${DIR}/session-ac-evo-mid-2026-04-21T20-24-34-810Z.bin.gz`;
    expect(detectGameIdFromBuffer(readFileSync(file))).toBeNull();
    expect(hasMetaFrame(gunzip(file))).toBe(true);

    const packets = readSessionPackets(file, acEvoServerAdapter);
    expect(packets.length).toBeGreaterThan(0);
    const last = packets[packets.length - 1]!;
    expect(getAcEvoTrackName(last.trackId)).toBe("Brands Hatch - GP");
    expect(getAcEvoCarName(last.carId)).toBe("Porsche 992 GT3 R Rennsport");
  }, { timeout: 30000 });

  // The trailing source frame has no track identity. Parser must not infer a venue alias.
  // These full-frame fixtures remain parser evidence only, not supported upload formats.
  // Source identity for preceding frames is allocated from their actual pairs.
  test("ac-evo-unknown-track-session17.bin.gz — missing source identity stays unresolved", () => {
    const file = `${DIR}/ac-evo-unknown-track-session17.bin.gz`;
    expect(detectGameIdFromBuffer(readFileSync(file))).toBeNull();
    expect(hasMetaFrame(gunzip(file))).toBe(true);

    const packets = readSessionPackets(file, acEvoServerAdapter);
    expect(packets.length).toBeGreaterThan(0);
    const last = packets[packets.length - 1]!;
    expect(last.acEvoIdentity?.trackName).toBe("");
    expect(last.acEvoIdentity?.trackConfiguration).toBe("");
    expect(last.trackId).toBe("");

    // Car: assert dominant player's native string ID, not trailing unresolved packet.
    const carCounts = new Map<string, number>();
    for (const p of packets) carCounts.set(p.carId, (carCounts.get(p.carId) ?? 0) + 1);
    const playerCarId = [...carCounts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    expect(getAcEvoCarName(playerCarId)).toBe("Audi R8 LMS GT3 Evo II");
  }, { timeout: 30000 });

  test("f1-2025-2026-04-09T21-34-10-190Z.bin.gz — raw UDP dump, F1 2025 — REGRESSION-BASELINE ONLY", () => {
    const file = `${DIR}/f1-2025-2026-04-09T21-34-10-190Z.bin.gz`;
    expect(detectGameIdFromBuffer(readFileSync(file))).toBeNull();
    expect(hasMetaFrame(gunzip(file))).toBe(false);

    const packets = readUdpPackets(file, f1ServerAdapter).packets;
    expect(packets.length).toBeGreaterThan(0);
    const last = packets[packets.length - 1]!;
    const adapter = getGame("f1-2025");
    expect(adapter.getTrackName(last.trackId)).toBe("Lusail International Circuit");
    expect(adapter.getCarName(last.carId)).toBe("F1 World");
  }, { timeout: 60000 });

  test("fm-2023-2026-04-09T21-53-00-102Z.bin.gz — raw UDP dump, FM 2023 — REGRESSION-BASELINE ONLY", () => {
    const file = `${DIR}/fm-2023-2026-04-09T21-53-00-102Z.bin.gz`;
    expect(detectGameIdFromBuffer(readFileSync(file))).toBeNull();
    expect(hasMetaFrame(gunzip(file))).toBe(false);

    const packets = readUdpPackets(file, forzaServerAdapter).packets;
    expect(packets.length).toBeGreaterThan(0);
    const last = packets[packets.length - 1]!;
    const adapter = getGame("fm-2023");
    expect(adapter.getTrackName(last.trackId)).toBe("Road America - East Route");
    expect(adapter.getCarName(last.carId)).toBe("2022 Aston Martin Valkyrie AMR Pro");
  });

  test("fm-2023-2026-04-09T21-55-03-186Z.bin.gz — raw UDP dump, FM 2023 — REGRESSION-BASELINE ONLY (same car/track as 21-53-00 fixture, cross-consistent)", () => {
    const file = `${DIR}/fm-2023-2026-04-09T21-55-03-186Z.bin.gz`;
    expect(detectGameIdFromBuffer(readFileSync(file))).toBeNull();
    expect(hasMetaFrame(gunzip(file))).toBe(false);

    const packets = readUdpPackets(file, forzaServerAdapter).packets;
    expect(packets.length).toBeGreaterThan(0);
    const last = packets[packets.length - 1]!;
    const adapter = getGame("fm-2023");
    expect(adapter.getTrackName(last.trackId)).toBe("Road America - East Route");
    expect(adapter.getCarName(last.carId)).toBe("2022 Aston Martin Valkyrie AMR Pro");
  });

  test("ac-evo-2026-04-15T17-12-25-825Z.bin.gz — dump-mode, AC Evo — REGRESSION-BASELINE ONLY", () => {
    const file = `${DIR}/ac-evo-2026-04-15T17-12-25-825Z.bin.gz`;
    // Dump-mode fixtures are parser-only; import detection rejects legacy sources.
    expect(detectGameIdFromBuffer(readFileSync(file))).toBeNull();
    expect(hasMetaFrame(gunzip(file))).toBe(false);

    const { packets } = readAcEvoPackets(file);
    expect(packets.length).toBeGreaterThan(0);
    const last = packets[packets.length - 1]!;
    // This recording's STATIC track field is empty in all 20k+ frames (the
    // game never populated it). It previously asserted "Monza - GP", but that
    // only passed because unidentified tracks defaulted to ordinal 0, which
    // happens to be Monza — the exact production bug where every unnamed
    // session imported as Monza. Unidentified must keep an empty identity.
    expect(last.trackId).toBe("");
    expect(getAcEvoCarName(last.carId)).toBe("Porsche 992 GT3 R Rennsport");
  }, { timeout: 60000 });

  test("iracing-road-america-gt3.bin.gz — iRacing dump source frame parsing", () => {
    const file = `${DIR}/iracing-road-america-gt3.bin.gz`;
    // The parser decodes this dump, but sparse-only import detection rejects it.
    expect(detectGameIdFromBuffer(readFileSync(file))).toBeNull();
    expect(hasMetaFrame(gunzip(file))).toBe(false);

    const frames = readIRacingFrames(file);
    expect(frames).toHaveLength(138);
    const adapter = getServerGame("iracing");
    const state = adapter.createParserState?.() ?? null;
    const first = adapter.tryParse(frames[0], state);
    expect(first).toMatchObject({
      gameId: "iracing",
      carId: "42",
      trackId: "99",
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
    expect(getAccTrackName(Number(last.trackId))).toBe("Brands Hatch - GP");
    expect(getAccCarName(Number(last.carId))).toBe("McLaren 720S GT3 Evo 2023");
  });

  test("acc-2026-04-10T02-59-28-972Z.bin.gz — dump-mode, ACC — CORROBORATED (packages/game-acc/test/e2e/acc-2026-04-10T02-59-28-972Z.test.ts sector timing)", () => {
    const file = `${DIR}/acc-2026-04-10T02-59-28-972Z.bin.gz`;
    expect(detectGameIdFromBuffer(readFileSync(file))).toBeNull();
    expect(hasMetaFrame(gunzip(file))).toBe(false);

    const { packets } = readAccPackets(file);
    expect(packets.length).toBeGreaterThan(0);
    const last = packets[packets.length - 1]!;
    expect(getAccTrackName(Number(last.trackId))).toBe("Brands Hatch - GP");
    expect(getAccCarName(Number(last.carId))).toBe("McLaren 720S GT3 Evo 2023");
  }, { timeout: 30000 });

  test("acc-2026-04-12T21-16-07-841Z.bin.gz — dump-mode, ACC — REGRESSION-BASELINE ONLY (existing e2e test covers lap detection, not sectors)", () => {
    const file = `${DIR}/acc-2026-04-12T21-16-07-841Z.bin.gz`;
    expect(detectGameIdFromBuffer(readFileSync(file))).toBeNull();
    expect(hasMetaFrame(gunzip(file))).toBe(false);

    const { packets } = readAccPackets(file);
    expect(packets.length).toBeGreaterThan(0);
    const last = packets[packets.length - 1]!;
    expect(getAccTrackName(Number(last.trackId))).toBe("Brands Hatch - GP");
    expect(getAccCarName(Number(last.carId))).toBe("McLaren 720S GT3 Evo 2023");
  }, { timeout: 300_000 });

  test("acc-2026-04-12T21-44-38-899Z.bin.gz — dump-mode, ACC — CORROBORATED (packages/game-acc/test/e2e/acc-2026-04-12T21-44-38-899Z.test.ts sector timing)", () => {
    const file = `${DIR}/acc-2026-04-12T21-44-38-899Z.bin.gz`;
    expect(detectGameIdFromBuffer(readFileSync(file))).toBeNull();
    expect(hasMetaFrame(gunzip(file))).toBe(false);

    const { packets } = readAccPackets(file);
    expect(packets.length).toBeGreaterThan(0);
    const last = packets[packets.length - 1]!;
    expect(getAccTrackName(Number(last.trackId))).toBe("Brands Hatch - GP");
    expect(getAccCarName(Number(last.carId))).toBe("McLaren 720S GT3 Evo 2023");
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
