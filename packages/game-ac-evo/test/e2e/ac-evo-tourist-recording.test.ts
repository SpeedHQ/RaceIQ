import { beforeAll, describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { iterateAcEvoRecordingRecords } from "../support/recordings";
import { createAcEvoParserCache, parseAcEvoBuffers } from "../../src/parser";
import { parseAcEvoLapIndex } from "../../src/lap-index";
import { unpackTriplet } from "@raceiq/capture-formats/kunos/pack-triplet";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { CapturedLap } from "@raceiq/backend-core/telemetry/pipeline-ports";
import { KunosDetectorEngine, type KunosLapCapture } from "@raceiq/telemetry-core/processor/kunos-engine";
import { CapturingDbAdapter } from "@raceiq/backend-core/telemetry/pipeline-ports";
import { LapDetectorAcEvo } from "../../src/lap-detector";
import { isAcEvoTouristLayout } from "../../src/layout-policy";
import { getOrCreateDiscoveredTrack } from "@raceiq/backend-core/db/discovered-tracks";
import { getRecordedOutlineByOrdinal } from "@raceiq/game-catalogs/racing/tracks/recording/outlines";
import { combineRecordingParts } from "@raceiq/backend-core/session-capture/combine-recording-parts";

const RECORDING_PARTS = [
  "test/artifacts/sessions/ac-evo-tourist-2026-10-10.bin.gz.part1",
  "test/artifacts/sessions/ac-evo-tourist-2026-10-10.bin.gz.part2",
];

type Finish = { time: number; valid: boolean | null | undefined; segment: number };
let capture: Buffer;
let fullFinishes: Finish[] = [];
let compactFinishes: Finish[] = [];
let detectedLaps: CapturedLap[] = [];
let detectedWindows: { packets: TelemetryPacket[]; lapTime: number; isValid: boolean }[] = [];

function replay(parser: "full" | "compact"): Finish[] {
  const finishes: Finish[] = [];
  let segment = 0;
  let context = false;
  let cache = createAcEvoParserCache();
  let previousLapNumber = -1;
  for (const record of iterateAcEvoRecordingRecords(capture)) {
    if (record.kind === "segment-boundary") {
      segment++;
      cache = createAcEvoParserCache();
      previousLapNumber = -1;
      context = false;
      continue;
    }
    if (record.kind === "segment-context") { context = true; continue; }
    if (record.kind === "segment-context-end") { context = false; continue; }
    if (record.kind !== "frame") continue;
    const triplet = unpackTriplet(record.frame);
    if (!triplet) continue;
    const packet = parser === "full"
      ? parseAcEvoBuffers(triplet.physics, triplet.graphics, triplet.staticData, cache, record.frameTimeMs ?? 0)
      : parseAcEvoLapIndex(triplet.physics, triplet.graphics, triplet.staticData, cache, record.frameTimeMs ?? 0);
    if (!packet || context) continue;
    if (previousLapNumber >= 0 && packet.LapNumber > previousLapNumber && packet.LastLap > 0) {
      finishes.push({ time: packet.LastLap, valid: packet.acc?.isValidLap, segment });
    }
    previousLapNumber = packet.LapNumber;
  }
  return finishes;
}
async function replayFullDetector(): Promise<CapturedLap[]> {
  const laps: CapturedLap[] = [];
  let db = new CapturingDbAdapter();
  let detector = new LapDetectorAcEvo({ db, callbacks: { onLapComplete: (event) => detectedWindows.push(event) } });
  let cache = createAcEvoParserCache();
  let context = false;
  for (const record of iterateAcEvoRecordingRecords(capture)) {
    if (record.kind === "segment-boundary") {
      await detector.finalizeCurrentSession();
      laps.push(...db.laps);
      db = new CapturingDbAdapter();
      detector = new LapDetectorAcEvo({ db, callbacks: { onLapComplete: (event) => detectedWindows.push(event) } });
      cache = createAcEvoParserCache();
      context = false;
      continue;
    }
    if (record.kind === "segment-context") { context = true; continue; }
    if (record.kind === "segment-context-end") { context = false; continue; }
    if (record.kind !== "frame") continue;
    const triplet = unpackTriplet(record.frame);
    if (!triplet) continue;
    const packet = parseAcEvoBuffers(triplet.physics, triplet.graphics, triplet.staticData, cache, record.frameTimeMs ?? 0);
    if (!packet || context) continue;
    if (!isAcEvoTouristLayout(packet)) throw new Error("Capture frame lost AC EVO tourist source identity");
    await detector.feed(packet, record.offset);
  }
  await detector.finalizeCurrentSession();
  laps.push(...db.laps);
  return laps;
}


beforeAll(async () => {
  const recording = await combineRecordingParts(RECORDING_PARTS);
  try {
    capture = gunzipSync(readFileSync(recording.path));
  } finally {
    recording.cleanup();
  }
  fullFinishes = replay("full");
  compactFinishes = replay("compact");
  detectedLaps = await replayFullDetector();
});


function touristPacket(overrides: Partial<TelemetryPacket> = {}): TelemetryPacket {
  return {
    gameId: "ac-evo",
    TimestampMS: 0,
    CurrentLap: 0.5,
    LastLap: 0,
    LapNumber: 1,
    DistanceTraveled: 0,
    IsRaceOn: 1,
    acc: { isValidLap: true },
    ...overrides,
  } as TelemetryPacket;
}

function createTouristEngine(captures: KunosLapCapture[]): KunosDetectorEngine {
  return new KunosDetectorEngine({
    createSession: async () => {},
    backfillSessionIdentifiers: () => {},
    isPitOnly: () => false,
    isOpenRoute: () => true,
    emitLap: async (capture) => { captures.push(capture); },
  });
}

describe("AC EVO tourist timed-attempt lifecycle", () => {
  test("count advance completes with equal source times; post-finish transit never duplicates", async () => {
    const captures: KunosLapCapture[] = [];
    const engine = createTouristEngine(captures);
    for (const packet of [
      touristPacket({ CurrentLap: 0.5, DistanceTraveled: 0 }),
      touristPacket({ CurrentLap: 150, DistanceTraveled: 5000 }),
      touristPacket({ CurrentLap: 400, DistanceTraveled: 18000 }),
      touristPacket({ CurrentLap: 0.5, LastLap: 401.277, LapNumber: 2, DistanceTraveled: 18800 }),
      touristPacket({ CurrentLap: 30, LastLap: 401.277, LapNumber: 2, DistanceTraveled: 19500 }),
      touristPacket({ CurrentLap: 0.4, LastLap: 401.277, LapNumber: 2, DistanceTraveled: 20000 }),
      touristPacket({ CurrentLap: 400, LastLap: 401.277, LapNumber: 2, DistanceTraveled: 38000 }),
      touristPacket({ CurrentLap: 0.5, LastLap: 401.277, LapNumber: 3, DistanceTraveled: 38800 }),
    ]) await engine.feed(packet);
    await engine.finalize();
    expect(captures.map(({ lapTime }) => lapTime)).toEqual([401.277, 401.277]);
    expect(captures.every(({ invalidReason }) => invalidReason === undefined)).toBe(true);
    expect(captures[0].packets.every(({ DistanceTraveled }) => DistanceTraveled < 19500)).toBe(true);
  });

  test("delayed finish metadata retains boundary; reset saves invalid attempt without teleport", async () => {
    const captures: KunosLapCapture[] = [];
    const engine = createTouristEngine(captures);
    for (const packet of [
      touristPacket({ CurrentLap: 0.5, DistanceTraveled: 0 }),
      touristPacket({ CurrentLap: 150, DistanceTraveled: 5000 }),
      touristPacket({ CurrentLap: 400, DistanceTraveled: 18000 }),
      touristPacket({ CurrentLap: 0.5, LastLap: 0, LapNumber: 2, DistanceTraveled: 18800 }),
      touristPacket({ CurrentLap: 20, LastLap: 0, LapNumber: 2, DistanceTraveled: 19200 }),
      touristPacket({ CurrentLap: 20.1, LastLap: 401.277, LapNumber: 2, DistanceTraveled: 19210 }),
      touristPacket({ CurrentLap: 0.5, LastLap: 401.277, DistanceTraveled: 19220, LapNumber: 2 }),
      touristPacket({ CurrentLap: 400, DistanceTraveled: 21000, LapNumber: 2 }),
      touristPacket({ CurrentLap: 400.1, DistanceTraveled: 300, LapNumber: 2 }),
      touristPacket({ CurrentLap: 0.5, DistanceTraveled: 100, LapNumber: 2 }),
      touristPacket({ CurrentLap: 200, DistanceTraveled: 10000, LapNumber: 2 }),
      touristPacket({ CurrentLap: 0.5, LastLap: 300, LapNumber: 3, DistanceTraveled: 19000 }),
    ]) await engine.feed(packet);
    await engine.finalize();
    expect(captures.map(({ lapTime, invalidReason }) => [lapTime, invalidReason])).toEqual([
      [401.277, undefined],
      [400, "car reset"],
      [300, undefined],
    ]);
    expect(captures[1].packets.some(({ DistanceTraveled }) => DistanceTraveled === 300)).toBe(false);
    expect(captures[1].lapNumber).toBe(2);
    expect(captures[2].lapNumber).toBe(3);
  });
  test("distance reset on timer boundary ends attempt and arms next valid start", async () => {
    const captures: KunosLapCapture[] = [];
    const engine = createTouristEngine(captures);
    for (const packet of [
      touristPacket({ CurrentLap: 0.5, DistanceTraveled: 0 }),
      touristPacket({ CurrentLap: 150, DistanceTraveled: 5000 }),
      touristPacket({ CurrentLap: 400, DistanceTraveled: 18000 }),
      touristPacket({ CurrentLap: 0.5, DistanceTraveled: 100, LapNumber: 2 }),
      touristPacket({ CurrentLap: 0.5, DistanceTraveled: 200, LapNumber: 2 }),
      touristPacket({ CurrentLap: 200, DistanceTraveled: 10000, LapNumber: 2 }),
      touristPacket({ CurrentLap: 0.5, DistanceTraveled: 19000, LapNumber: 3, LastLap: 300 }),
    ]) await engine.feed(packet);
    await engine.finalize();
    expect(captures.map(({ lapNumber, invalidReason }) => [lapNumber, invalidReason])).toEqual([
      [1, "car reset"],
      [2, undefined],
    ]);
    expect(captures[0].packets.some(({ DistanceTraveled }) => DistanceTraveled === 100)).toBe(false);
    expect(captures[1].packets[0].DistanceTraveled).toBe(200);
  });


  test("mid-attempt attachment does not fabricate timed attempts", async () => {
    const captures: KunosLapCapture[] = [];
    const engine = createTouristEngine(captures);
    for (let index = 0; index < 12; index++) {
      await engine.feed(touristPacket({ CurrentLap: 12 + index, DistanceTraveled: index * 1000 }));
    }
    await engine.finalize();
    expect(captures).toHaveLength(0);
  });
});

describe("AC EVO tourist source finish metadata", () => {
  test("full parser preserves both completed source times and valid flags", () => {
    const expected = [401.277, 398.781];
    for (const time of expected) {
      expect(fullFinishes.some((finish) => finish.time === time && finish.valid === true)).toBe(true);
    }
    expect(fullFinishes.some((finish) => finish.time === 448.243 || finish.time === 1184.841)).toBe(false);
  });

  test("compact parser preserves identical source finish times and valid flags", () => {
    for (const time of [401.277, 398.781]) {
      expect(compactFinishes.some((finish) => finish.time === time && finish.valid === true)).toBe(true);
    }
    expect(compactFinishes.filter((finish) => finish.time === 401.277 || finish.time === 398.781).length).toBeGreaterThanOrEqual(2);
  });
  test("real detector persists only the two valid timed tourist finishes and their open geometry", async () => {
    const finished = detectedLaps.filter((lap) => lap.isValid && lap.invalidReason === null);
    expect(finished.map((lap) => lap.lapTime).sort((a, b) => a - b)).toEqual([398.781, 401.277]);
    expect(detectedLaps.some((lap) => lap.lapTime === 448.243 || lap.lapTime === 1184.841)).toBe(false);

    const windows = detectedWindows.filter((window) => window.isValid);
    expect(windows.map((window) => window.lapTime).sort((a, b) => a - b)).toEqual([398.781, 401.277]);
    for (const window of windows) {
      const first = window.packets[0];
      const last = window.packets[window.packets.length - 1];
      const distance = last.DistanceTraveled - first.DistanceTraveled;
      const endpointDistance = Math.hypot(last.PositionX - first.PositionX, last.PositionZ - first.PositionZ);
      expect(distance).toBeGreaterThan(17_000);
      expect(distance).toBeLessThan(22_000);
      expect(endpointDistance).toBeGreaterThan(1_000);
    }
    const trackOrdinal = await getOrCreateDiscoveredTrack("ac-evo", "Nurburgring", "Touristenfahrten");
    const outline = getRecordedOutlineByOrdinal(trackOrdinal, "ac-evo");
    expect(outline).not.toBeNull();
    expect(outline!.length).toBeGreaterThan(50);
    expect(Math.hypot(outline![0].x - outline!.at(-1)!.x, outline![0].z - outline!.at(-1)!.z)).toBeGreaterThan(1_000);
  });
});
