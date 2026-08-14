import { describe, expect, test } from "bun:test";
import { initServerGameAdapters } from "../../../server/games/init";
import {
  normalizeIRacingFrame,
} from "../../../server/games/iracing/normalizer";
import {
  type IRacingFrameReader,
  IRacingTelemetrySource,
} from "../../../server/games/iracing/source";
import {
  createIRacingSourceDecoderState,
  decodeIRacingSourceFrame,
  IRacingSourceFrameEncoder,
  type IRacingSourceFrameV3,
} from "../../../server/games/iracing/source-frame";
import { parsePacket } from "../../../server/games/packet-dispatch";
import { timerResolutionRefCount } from "../../../server/games/shared/win-timer-resolution";
import { initGameAdapters } from "../../../shared/games/init";
import {
  iracingAdapter,
  rememberIRacingIdentity,
} from "../../../shared/games/iracing";

initGameAdapters();
initServerGameAdapters();
import { sampleFrame, } from "../../support/games/iracing-sdk";
describe("iRacing source ownership integration", () => {
  test.skipIf(process.platform !== "win32")("holds high-resolution timer while polling iRacing", async () => {
    const initialRefCount = timerResolutionRefCount();
    const reader: IRacingFrameReader = { start() {}, async stop() {}, readLatest: () => null };
    const source = new IRacingTelemetrySource({ reader, pollIntervalMs: 1000 });
    source.start();
    try {
      expect(timerResolutionRefCount()).toBe(initialRefCount + 1);
    } finally {
      await source.stop();
    }
    expect(timerResolutionRefCount()).toBe(initialRefCount);
  });

  test("parsing a historical frame cannot overwrite live identity", () => {
    const carOrdinal = 901_042;
    const trackOrdinal = 901_099;
    rememberIRacingIdentity({
      carId: carOrdinal,
      carName: "Live GT3",
      trackId: trackOrdinal,
      trackName: "Live Raceway",
    });

    const historical = sampleFrame();
    historical.session = {
      ...historical.session,
      carId: carOrdinal,
      carName: "Old Capture GT3",
      trackId: trackOrdinal,
      trackName: "Old Capture Raceway",
    };
    normalizeIRacingFrame(historical);

    expect(iracingAdapter.getCarName(carOrdinal)).toBe("Live GT3");
    expect(iracingAdapter.getTrackName(trackOrdinal)).toBe("Live Raceway");
  });

  test("translates iRacing gear and weather into canonical dashboard fields", () => {
    const reverse = sampleFrame();
    reverse.values = {
      ...reverse.values,
      Gear: -1,
      Precipitation: 0.42,
      TrackWetness: 5,
    };
    const reversePacket = normalizeIRacingFrame(reverse);
    expect(reversePacket.Gear).toBe(0);
    expect(reversePacket.RainPercent).toBe(42);
    expect(reversePacket.iracing?.trackWetness).toBe(5);

    const neutral = sampleFrame();
    neutral.values = {
      ...neutral.values,
      Gear: 0,
      TrackWetness: 1,
    };
    const neutralPacket = normalizeIRacingFrame(neutral);
    expect(neutralPacket.Gear).toBe(11);
    expect(neutralPacket.RainPercent).toBe(0);
  });

  test("rejects truncated and corrupt source frames", () => {
    const raw = new IRacingSourceFrameEncoder().encode(sampleFrame());
    expect(decodeIRacingSourceFrame(raw.subarray(0, raw.length - 1))).toBeNull();
    raw.writeUInt32LE(0xffffffff, 8);
    expect(decodeIRacingSourceFrame(raw)).toBeNull();
  });

  test("source owns the SDK snapshot and emits its raw frame to the parser boundary", async () => {
    let delivered: Buffer | null = null;
    const frame = sampleFrame();
    const sessionInfo = `
WeekendInfo:
  TrackID: 99
  TrackLength: 6.515 km
  TrackDisplayName: Road America
  SessionID: 123
  SubSessionID: 456
SplitTimeInfo:
  Sectors:
  - SectorNum: 0
    SectorStartPct: 0.000000
  - SectorNum: 1
    SectorStartPct: 0.340000
  - SectorNum: 2
    SectorStartPct: 0.670000
DriverInfo:
  DriverCarIdx: 7
  DriverCarIdleRPM: 900
  DriverCarRedLine: 8500
  DriverCarEngCylinderCount: 8
  Drivers:
  - CarIdx: 7
    CarID: 42
    CarScreenName: GT3 Test Car
    CarClassID: 8
    CarClassShortName: GT3
`;
    const reader: IRacingFrameReader = {
      start() {},
      async stop() {},
      readLatest() {
        return {
          tick: 7530,
          sessionInfoUpdate: 1,
          sessionInfo,
          values: frame.values,
        };
      },
    };
    const source = new IRacingTelemetrySource({
      reader,
      dispatchRawFrame: async (raw) => {
        delivered = raw;
      },
    });

    expect(await source.pollOnce()).toBe(true);
    expect(delivered).not.toBeNull();
    const decoded = decodeIRacingSourceFrame(delivered!);
    expect(decoded).toMatchObject({
      schemaVersion: 3,
      sessionInfo,
      sessionInfoUpdate: 1,
    });
    expect((decoded as IRacingSourceFrameV3 | null)?.sessionInfo).toBe(
      sessionInfo,
    );
    expect(parsePacket(delivered!)).toMatchObject({
      gameId: "iracing",
      iracing: { sectorStarts: [0, 0.34, 0.67] },
    });
  });

  test("reparses session YAML when raw content or revision changes", async () => {
    const frame = sampleFrame();
    const sessionInfo = (trackName: string) => `
WeekendInfo:
  TrackID: 99
  TrackLength: 6.515 km
  TrackDisplayName: ${trackName}
  SessionID: 123
  SubSessionID: 456
DriverInfo:
  DriverCarIdx: 7
  Drivers:
  - CarIdx: 7
    CarID: 42
    CarScreenName: GT3 Test Car
`;
    const snapshots = [
      {
        tick: 7530,
        sessionInfoUpdate: 1,
        sessionInfo: sessionInfo("Road America"),
        values: frame.values,
      },
      {
        tick: 7531,
        sessionInfoUpdate: 1,
        sessionInfo: sessionInfo("Content Only Update"),
        values: frame.values,
      },
      {
        tick: 7532,
        sessionInfoUpdate: 2,
        sessionInfo: sessionInfo("Spa"),
        values: frame.values,
      },
    ];
    const reader: IRacingFrameReader = {
      start() {},
      async stop() {},
      readLatest() {
        return snapshots.shift() ?? null;
      },
    };
    const delivered: Buffer[] = [];
    const registeredTrackNames: string[] = [];
    const source = new IRacingTelemetrySource({
      reader,
      dispatchRawFrame: async (raw) => {
        delivered.push(raw);
      },
      registerIdentity: async (session) => {
        registeredTrackNames.push(session.trackName);
      },
    });

    expect(await source.pollOnce()).toBe(true);
    expect(await source.pollOnce()).toBe(true);
    expect(await source.pollOnce()).toBe(true);
    const decoder = createIRacingSourceDecoderState();
    const decoded = delivered.map((raw) =>
      decodeIRacingSourceFrame(raw, decoder),
    ) as Array<IRacingSourceFrameV3 | null>;
    expect(decoded.map((raw) => raw?.session.trackName)).toEqual([
      "Road America",
      "Content Only Update",
      "Spa",
    ]);
    expect(decoded.map((raw) => raw?.sessionInfoUpdate)).toEqual([1, 1, 2]);
    expect(decoded.map((raw) => raw?.sessionInfo)).toEqual([
      sessionInfo("Road America"),
      sessionInfo("Content Only Update"),
      sessionInfo("Spa"),
    ]);
    expect(registeredTrackNames).toEqual([
      "Road America",
      "Content Only Update",
      "Spa",
    ]);
  });
});

