import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { computeIRacingSectorTimeline,
computeLapSectors, } from "../server/lap-analysis/sectors"
import { getDiscoveredCarName, listDiscoveredCars } from "../server/db/discovered-cars";
import {
  getDiscoveredTrackName,
  listDiscoveredTracks,
} from "../server/db/discovered-tracks";
import { db } from "../server/db/index";
import { discoveredCars, discoveredTracks } from "../server/db/schema";
import { initServerGameAdapters } from "../server/games/init";
import { registerLiveIRacingIdentity } from "../server/games/iracing/identity";
import {
  createIRacingParserState,
  normalizeIRacingFrame,
} from "../server/games/iracing/normalizer";
import { parseIRacingSessionInfo } from "../server/games/iracing/session-info";
import {
  IRacingSdkReader,
  isValidIRacingMappingRange,
} from "../server/games/iracing/sdk-reader";
import {
  type IRacingFrameReader,
  IRacingTelemetrySource,
} from "../server/games/iracing/source";
import { LAP_DETECTOR_IRACING_ID } from "../server/games/iracing/lap-detector";
import {
  canHandleIRacingSourceFrame,
  createIRacingSourceDecoderState,
  decodeIRacingSourceFrame,
  IRACING_MAX_SOURCE_FRAME_SIZE,
  IRACING_SOURCE_SCHEMA_VERSION,
  IRACING_SOURCE_SCHEMA_VERSION_V3,
  IRacingSourceFrameEncoder,
  isIRacingSessionFrame,
  type IRacingSourceFrameV2,
  type IRacingSourceFrameV3,
} from "../server/games/iracing/source-frame";
import {
  IRacingVariableTable,
  IRSDK_VAR_HEADER_SIZE,
  IRSDKVariableType,
} from "../server/games/iracing/variable-table";
import { LapDetectorIRacing } from "../server/games/iracing/lap-detector";
import { parsePacket } from "../server/games/packet-dispatch";
import { CapturingDbAdapter } from "../server/telemetry/pipeline-ports"
import { SectorTracker } from "../server/live-strategy/sector-tracker";
import { initGameAdapters } from "../shared/games/init";
import {
  injectDiscoveredIRacingIdentity,
  iracingAdapter,
  rememberIRacingIdentity,
} from "../shared/games/iracing";
import type { TelemetryPacket } from "../shared/types";

initGameAdapters();
initServerGameAdapters();

function writeCString(buf: Buffer, offset: number, length: number, value: string): void {
  Buffer.from(value, "utf8").copy(buf, offset, 0, length - 1);
}

function descriptor(
  type: IRSDKVariableType,
  valueOffset: number,
  count: number,
  name: string,
): Buffer {
  const buf = Buffer.alloc(IRSDK_VAR_HEADER_SIZE);
  buf.writeInt32LE(type, 0);
  buf.writeInt32LE(valueOffset, 4);
  buf.writeInt32LE(count, 8);
  writeCString(buf, 16, 32, name);
  writeCString(buf, 48, 64, `${name} description`);
  return buf;
}

function sampleFrame(): IRacingSourceFrameV2 {
  return {
    schemaVersion: 2,
    session: {
      sessionId: 123,
      subSessionId: 456,
      sessionNum: 2,
      driverCarIdx: 7,
      trackId: 99,
      trackName: "Road America",
      trackLengthM: 6515,
      sectorStarts: [0, 0.34, 0.67],
      carId: 42,
      carName: "GT3 Test Car",
      carClassId: 8,
      carClassName: "GT3",
      engineIdleRpm: 900,
      engineRedlineRpm: 8500,
      engineCylinderCount: 8,
    },
    values: {
      SessionTime: 125.5,
      SessionTick: 7530,
      SessionNum: 2,
      IsOnTrack: true,
      OnPitRoad: false,
      PlayerTrackSurface: 3,
      PlayerIncidents: 1,
      PlayerCarPosition: 4,
      Speed: 72.5,
      RPM: 7000,
      Throttle: 0.75,
      Brake: 0.2,
      Clutch: 0,
      Gear: 5,
      SteeringWheelAngle: 0.2,
      SteeringWheelAngleMax: 2,
      FuelLevel: 41.25,
      Lap: 3,
      LapDist: 1200,
      LapDistPct: 0.184,
      LapBestLapTime: 121.2,
      LapLastLapTime: 122.4,
      LapCurrentLapTime: 25.5,
      LatAccel: 4.2,
      LongAccel: 1.1,
      VertAccel: 9.8,
      LFshockDefl: 0.04,
      RFshockDefl: 0.041,
      LRshockDefl: 0.05,
      RRshockDefl: 0.051,
      LFtempCL: 82,
      LFtempCM: 84,
      LFtempCR: 86,
      LFwearL: 0.95,
      LFwearM: 0.94,
      LFwearR: 0.96,
      TrackTemp: 32,
      AirTemp: 23,
      Precipitation: 0,
      TrackWetness: 0,
      CarPath: " gt3 test car ",
      CarIdxOnPitRoad: [true, false, true],
      EngineWarnings: 0xf0000001,
      CarIdxLapDistPct: [0.125, 0.5, 0.875],
      LapDeltaToBestLap: -0.012345678901234,
    },
  };
}

function sampleFrameV3(
  sessionInfo = "WeekendInfo:\n  TrackDisplayName: Road America\n",
  sessionInfoUpdate = 7,
): IRacingSourceFrameV3 {
  const frame = sampleFrame();
  return {
    schemaVersion: 3,
    session: frame.session,
    values: frame.values,
    sessionInfo,
    sessionInfoUpdate,
  };
}

describe("native iRacing SDK decoding", () => {
  test("declares native timing and replay capabilities", () => {
    expect(iracingAdapter.nativeSectors).toBe(true);
    expect(iracingAdapter.authoritativeTrackLength).toBe(true);
    expect(iracingAdapter.appendsDelayedFinishFrame).toBe(false);
    expect(LAP_DETECTOR_IRACING_ID).toBe("iracing_lapdetector_v3");
  });

  test("bounds native reads to the VirtualQuery region", () => {
    expect(isValidIRacingMappingRange(0, 112, 112)).toBe(true);
    expect(isValidIRacingMappingRange(112, 1, 112)).toBe(false);
    expect(isValidIRacingMappingRange(96, 17, 112)).toBe(false);
    expect(isValidIRacingMappingRange(-1, 1, 112)).toBe(false);
    expect(
      isValidIRacingMappingRange(
        Number.MAX_SAFE_INTEGER,
        2,
        Number.MAX_SAFE_INTEGER,
      ),
    ).toBe(false);
  });

  test("rejects an out-of-region copy before calling RtlCopyMemory", () => {
    let nativeCopyCalled = false;
    const reader = new IRacingSdkReader() as unknown as {
      _mappingView: bigint;
      _mappingSize: number;
      _ffiPtr: (buffer: Buffer) => number;
      _kernel32: {
        symbols: {
          RtlCopyMemory: () => void;
        };
      };
      _copy: (offset: number, length: number) => Buffer;
    };
    reader._mappingView = 4096n;
    reader._mappingSize = 112;
    reader._ffiPtr = () => 8192;
    reader._kernel32 = {
      symbols: {
        RtlCopyMemory: () => {
          nativeCopyCalled = true;
        },
      },
    };

    expect(() => reader._copy(96, 17)).toThrow(/exceeds mapped region/);
    expect(nativeCopyCalled).toBe(false);
  });

  test("keeps native source-pointer arithmetic in u64 space", () => {
    let sourceAddress: bigint | null = null;
    let byteLength: bigint | null = null;
    const reader = new IRacingSdkReader() as unknown as {
      _mappingView: bigint;
      _mappingSize: number;
      _ffiPtr: (buffer: Buffer) => number;
      _kernel32: {
        symbols: {
          RtlCopyMemory: (
            destination: number,
            source: bigint,
            length: bigint,
          ) => void;
        };
      };
      _copy: (offset: number, length: number) => Buffer;
    };
    reader._mappingView = 0x1_0000_0000n;
    reader._mappingSize = 112;
    reader._ffiPtr = () => 8192;
    reader._kernel32 = {
      symbols: {
        RtlCopyMemory: (_destination, source, length) => {
          sourceAddress = source;
          byteLength = length;
        },
      },
    };

    expect(reader._copy(96, 16)).toHaveLength(16);
    expect(sourceAddress).toBe(0x1_0000_0060n);
    expect(byteLength).toBe(16n);
  });

  test("reads official descriptor types from one telemetry row", () => {
    const headers = Buffer.concat([
      descriptor(IRSDKVariableType.Float, 0, 1, "Speed"),
      descriptor(IRSDKVariableType.Int, 4, 1, "Gear"),
      descriptor(IRSDKVariableType.Bool, 8, 1, "IsOnTrack"),
      descriptor(IRSDKVariableType.Float, 12, 3, "WheelTemps"),
    ]);
    const row = Buffer.alloc(32);
    row.writeFloatLE(55.5, 0);
    row.writeInt32LE(4, 4);
    row.writeUInt8(1, 8);
    row.writeFloatLE(80, 12);
    row.writeFloatLE(82, 16);
    row.writeFloatLE(84, 20);

    const table = new IRacingVariableTable(headers, row.length);
    expect(table.read(row, "Speed")).toBeCloseTo(55.5);
    expect(table.read(row, "Gear")).toBe(4);
    expect(table.read(row, "IsOnTrack")).toBe(true);
    expect(table.read(row, "WheelTemps")).toEqual([80, 82, 84]);
    expect(table.read(row, "Missing")).toBeUndefined();
  });

  test("reads every validated descriptor with exact native value shapes", () => {
    const headers = Buffer.concat([
      descriptor(IRSDKVariableType.Char, 0, 16, "CarPath"),
      descriptor(IRSDKVariableType.Bool, 16, 3, "CarIdxOnPitRoad"),
      descriptor(IRSDKVariableType.BitField, 20, 1, "EngineWarnings"),
      descriptor(IRSDKVariableType.Float, 24, 3, "CarIdxLapDistPct"),
      descriptor(IRSDKVariableType.Double, 40, 1, "LapDeltaToBestLap"),
    ]);
    const row = Buffer.alloc(48);
    writeCString(row, 0, 16, " gt3 test car ");
    row.writeUInt8(1, 16);
    row.writeUInt8(0, 17);
    row.writeUInt8(1, 18);
    row.writeUInt32LE(0xf0000001, 20);
    row.writeFloatLE(0.125, 24);
    row.writeFloatLE(0.5, 28);
    row.writeFloatLE(0.875, 32);
    row.writeDoubleLE(-0.012345678901234, 40);

    const table = new IRacingVariableTable(headers, row.length);
    expect(table.names).toEqual([
      "CarPath",
      "CarIdxOnPitRoad",
      "EngineWarnings",
      "CarIdxLapDistPct",
      "LapDeltaToBestLap",
    ]);
    expect(table.readAll(row)).toEqual({
      CarPath: " gt3 test car ",
      CarIdxOnPitRoad: [true, false, true],
      EngineWarnings: 0xf0000001,
      CarIdxLapDistPct: [0.125, 0.5, 0.875],
      LapDeltaToBestLap: -0.012345678901234,
    });
  });

  test("live SDK snapshots retain channels outside the normalization list", () => {
    const headers = Buffer.concat([
      descriptor(IRSDKVariableType.Float, 0, 1, "Speed"),
      descriptor(IRSDKVariableType.Float, 4, 1, "LFbrakeLinePress"),
    ]);
    const row = Buffer.alloc(8);
    row.writeFloatLE(55.5, 0);
    row.writeFloatLE(1200.25, 4);
    const variableTable = new IRacingVariableTable(headers, row.length);
    const header = {
      version: 2,
      status: 1,
      sessionInfoUpdate: 1,
      sessionInfoLength: 16,
      sessionInfoOffset: 400,
      variableCount: 2,
      variableHeaderOffset: 112,
      bufferCount: 1,
      bufferLength: row.length,
      buffers: [{ tickCount: 42, offset: 416 }],
    };
    const reader = new IRacingSdkReader();
    const internals = reader as unknown as {
      _running: boolean;
      _connected: boolean;
      _mappingSize: number;
      _variableTable: IRacingVariableTable;
      _sessionInfo: string;
      _readHeader: () => typeof header;
      _refreshMetadata: (value: typeof header) => void;
      _copy: (offset: number, length: number) => Buffer;
    };
    internals._running = true;
    internals._connected = true;
    internals._mappingSize = 424;
    internals._variableTable = variableTable;
    internals._sessionInfo = "WeekendInfo: {}";
    internals._readHeader = () => header;
    internals._refreshMetadata = () => {};
    internals._copy = () => row;

    expect(reader.readLatest()).toMatchObject({
      tick: 42,
      values: {
        Speed: 55.5,
        LFbrakeLinePress: 1200.25,
      },
    });
  });

  test("ignores descriptors that point outside the SDK row", () => {
    const headers = descriptor(IRSDKVariableType.Double, 28, 1, "OutOfBounds");
    const table = new IRacingVariableTable(headers, 32);
    expect(table.has("OutOfBounds")).toBe(false);
    expect(table.names).toEqual([]);
    expect(table.readAll(Buffer.alloc(32))).toEqual({});
  });

  test("extracts the driver, car, track, and engine from session YAML", () => {
    const session = parseIRacingSessionInfo(`
WeekendInfo:
  TrackName: roadamerica full
  TrackID: 99
  TrackLength: 6.515 km
  TrackDisplayName: "Road America"
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
  - CarIdx: 2
    CarID: 10
    CarScreenName: Other Car
  - CarIdx: 7
    CarID: 42
    CarScreenName: "GT3 Test Car"
    CarClassID: 8
    CarClassShortName: GT3
`, 2);

    expect(session.trackName).toBe("Road America");
    expect(session.trackLengthM).toBeCloseTo(6515);
    expect(session.sectorStarts).toEqual([0, 0.34, 0.67]);
    expect(session.carId).toBe(42);
    expect(session.carName).toBe("GT3 Test Car");
    expect(session.carClassName).toBe("GT3");
    expect(session.sessionNum).toBe(2);
  });
});

describe("iRacing raw source frame parser integration", () => {
  test("persists live source identity once per ordinal for restart hydration", async () => {
    const carOrdinal = 900_042;
    const trackOrdinal = 900_099;

    try {
      await registerLiveIRacingIdentity({
        ...sampleFrame().session,
        carId: carOrdinal,
        carName: "Persisted GT3",
        trackId: trackOrdinal,
        trackName: "Persisted Raceway",
      });
      await registerLiveIRacingIdentity({
        ...sampleFrame().session,
        carId: carOrdinal,
        carName: "Later Rename",
        trackId: trackOrdinal,
        trackName: "Later Track Rename",
      });

      expect(await getDiscoveredCarName("iracing", carOrdinal)).toBe("Persisted GT3");
      expect(await getDiscoveredTrackName("iracing", trackOrdinal)).toBe("Persisted Raceway");
      expect(
        (await listDiscoveredCars("iracing")).filter((row) => row.ordinal === carOrdinal),
      ).toHaveLength(1);
      expect(
        (await listDiscoveredTracks("iracing")).filter((row) => row.ordinal === trackOrdinal),
      ).toHaveLength(1);
      expect(iracingAdapter.getCarName(carOrdinal)).toBe("Persisted GT3");
      expect(iracingAdapter.getTrackName(trackOrdinal)).toBe("Persisted Raceway");

      injectDiscoveredIRacingIdentity(
        await listDiscoveredCars("iracing"),
        await listDiscoveredTracks("iracing"),
      );
      expect(iracingAdapter.getCarName(carOrdinal)).toBe("Persisted GT3");
      expect(iracingAdapter.getTrackName(trackOrdinal)).toBe("Persisted Raceway");
    } finally {
      await db
        .delete(discoveredCars)
        .where(and(
          eq(discoveredCars.gameId, "iracing"),
          eq(discoveredCars.ordinal, carOrdinal),
        ))
        .run();
      await db
        .delete(discoveredTracks)
        .where(and(
          eq(discoveredTracks.gameId, "iracing"),
          eq(discoveredTracks.ordinal, trackOrdinal),
        ))
        .run();
    }
  });

  test("round-trips a self-contained frame through central parsePacket", () => {
    const raw = new IRacingSourceFrameEncoder().encode(sampleFrame());
    expect(canHandleIRacingSourceFrame(raw)).toBe(true);
    expect(isIRacingSessionFrame(raw)).toBe(true);
    expect(decodeIRacingSourceFrame(raw)).toEqual(sampleFrame());

    const packet = parsePacket(raw);
    expect(packet?.gameId).toBe("iracing");
    expect(packet?.sessionUID).toBe("456:123:2");
    expect(packet?.CarOrdinal).toBe(42);
    expect(packet?.TrackOrdinal).toBe(99);
    expect(packet?.LapNumber).toBe(3);
    expect(packet?.DistanceTraveled).toBeCloseTo(20745);
    expect(packet?.Speed).toBeCloseTo(72.5);
    expect(packet?.Accel).toBe(191);
    expect(packet?.Brake).toBe(51);
    expect(packet?.Steer).toBe(13);
    expect(packet?.TireTempFL).toBeCloseTo(84);
    expect(packet?.TireCarcassTempFL).toBeCloseTo(84);
    expect(packet?.TireCarcassTempLeftFL).toBe(82);
    expect(packet?.TireCarcassTempMiddleFL).toBe(84);
    expect(packet?.TireCarcassTempRightFL).toBe(86);
    expect(packet?.TireWearFL).toBeCloseTo(0.06);
    expect(packet?.iracing?.incidents).toBe(1);
  });

  test("keeps historical v2 frames compatible without inventing raw YAML", () => {
    const frame = sampleFrame();
    const raw = new IRacingSourceFrameEncoder().encode(frame);

    expect(raw.readUInt16LE(4)).toBe(IRACING_SOURCE_SCHEMA_VERSION);
    const decoded = decodeIRacingSourceFrame(raw);
    expect(decoded).toEqual(frame);
    expect(decoded).not.toHaveProperty("sessionInfo");
    expect(decoded).not.toHaveProperty("sessionInfoUpdate");
  });

  test("keeps historical v2 wire bytes stable", () => {
    const frame: IRacingSourceFrameV2 = {
      schemaVersion: 2,
      session: {
        sessionId: 1,
        subSessionId: 2,
        sessionNum: 3,
        driverCarIdx: 4,
        trackId: 5,
        trackName: "T",
        trackLengthM: 6,
        sectorStarts: [0, 0.5],
        carId: 7,
        carName: "C",
        carClassId: 8,
        carClassName: "K",
        engineIdleRpm: 9,
        engineRedlineRpm: 10,
        engineCylinderCount: 11,
      },
      values: { SessionTick: 12 },
    };

    expect(
      new IRacingSourceFrameEncoder().encode(frame).toString("base64"),
    ).toBe(
      "SVJJUQIAAQCLAAAAAAAAAAAA8D8AAAAAAAAAQAAAAAAAAAhAAAAAAAAAEEAAAAAAAAAUQAEAVAAAAAAAABhAAgAAAAAAAAAAAAAAAAAAAOA/AAAAAAAAHEABAEMAAAAAAAAgQAEASwAAAAAAACJAAAAAAAAAJEAAAAAAAAAmQAEACwBTZXNzaW9uVGljawIAAAAAAAAoQA==",
    );
  });

  test("round-trips v3 YAML larger than a u16 with exact UTF-8 bytes", () => {
    const sessionInfo =
      `WeekendInfo:\n  TrackDisplayName: Road America 🏁\n  Notes: ` +
      "é".repeat(40_000) +
      "\n";
    expect(Buffer.byteLength(sessionInfo, "utf8")).toBeGreaterThan(0xffff);
    const frame = sampleFrameV3(sessionInfo, 0x1020_3040);

    const raw = new IRacingSourceFrameEncoder().encode(frame);

    expect(raw.readUInt16LE(4)).toBe(IRACING_SOURCE_SCHEMA_VERSION_V3);
    expect(raw.length).toBeLessThanOrEqual(IRACING_MAX_SOURCE_FRAME_SIZE);
    expect(IRACING_MAX_SOURCE_FRAME_SIZE).toBeGreaterThan(4 * 1024 * 1024);
    expect(decodeIRacingSourceFrame(raw)).toEqual(frame);
  });

  test("round-trips signed native SessionInfo revisions", () => {
    const frame = sampleFrameV3("WeekendInfo: {}\n", -1);
    const raw = new IRacingSourceFrameEncoder().encode(frame);

    expect(decodeIRacingSourceFrame(raw)).toEqual(frame);
  });

  test("forces v3 session frames when raw YAML content or revision changes", () => {
    const encoder = new IRacingSourceFrameEncoder();
    const decoder = createIRacingSourceDecoderState();
    const first = sampleFrameV3("WeekendInfo:\n  TrackName: roadamerica\n", 12);
    const contentOnly = sampleFrameV3(
      "WeekendInfo:\n  TrackName: roadamerica full\n",
      12,
    );
    const revisionOnly = sampleFrameV3(contentOnly.sessionInfo, 13);

    const firstRaw = encoder.encode(first);
    const contentRaw = encoder.encode(contentOnly);
    const revisionRaw = encoder.encode(revisionOnly);

    expect(isIRacingSessionFrame(firstRaw)).toBe(true);
    expect(isIRacingSessionFrame(contentRaw)).toBe(true);
    expect(isIRacingSessionFrame(revisionRaw)).toBe(true);
    expect(decodeIRacingSourceFrame(firstRaw, decoder)).toEqual(first);
    expect(decodeIRacingSourceFrame(contentRaw, decoder)).toEqual(contentOnly);
    expect(decodeIRacingSourceFrame(revisionRaw, decoder)).toEqual(revisionOnly);
  });

  test("keeps unchanged v3 ticks compact while retaining YAML decoder state", () => {
    const encoder = new IRacingSourceFrameEncoder();
    const decoder = createIRacingSourceDecoderState();
    const first = sampleFrameV3();
    const next = sampleFrameV3();
    next.values = {
      ...next.values,
      SessionTime: 125.5 + 1 / 60,
      SessionTick: 7531,
    };

    const sessionRaw = encoder.encode(first);
    const deltaRaw = encoder.encode(next);
    const unchangedRaw = encoder.encode(next);

    expect(isIRacingSessionFrame(sessionRaw)).toBe(true);
    expect(isIRacingSessionFrame(deltaRaw)).toBe(false);
    expect(deltaRaw.length).toBeLessThan(sessionRaw.length / 10);
    expect(unchangedRaw.length).toBe(14);
    expect(decodeIRacingSourceFrame(deltaRaw)).toBeNull();
    expect(decodeIRacingSourceFrame(sessionRaw, decoder)).toEqual(first);
    expect(decodeIRacingSourceFrame(deltaRaw, decoder)).toEqual(next);
    expect(decodeIRacingSourceFrame(unchangedRaw, decoder)).toEqual(next);
  });

  test("rejects malformed v3 YAML payload lengths and truncated frames", () => {
    const frame = sampleFrameV3("WeekendInfo:\n  TrackName: roadamerica\n", 5);
    const raw = new IRacingSourceFrameEncoder().encode(frame);
    const yamlLength = Buffer.byteLength(frame.sessionInfo, "utf8");
    const yamlLengthOffset = raw.length - yamlLength - 4;

    expect(decodeIRacingSourceFrame(raw.subarray(0, raw.length - 1))).toBeNull();
    const invalidYamlLength = Buffer.from(raw);
    invalidYamlLength.writeUInt32LE(yamlLength + 1, yamlLengthOffset);
    expect(decodeIRacingSourceFrame(invalidYamlLength)).toBeNull();
    const invalidUtf8 = Buffer.from(raw);
    invalidUtf8[yamlLengthOffset + 4] = 0xff;
    expect(decodeIRacingSourceFrame(invalidUtf8)).toBeNull();
    const oversizedPayload = Buffer.from(raw);
    oversizedPayload.writeUInt32LE(IRACING_MAX_SOURCE_FRAME_SIZE, 8);
    const unsupportedVersion = Buffer.from(raw);
    unsupportedVersion.writeUInt16LE(4, 4);
    expect(decodeIRacingSourceFrame(unsupportedVersion)).toBeNull();
    expect(decodeIRacingSourceFrame(oversizedPayload)).toBeNull();
    const oversizedYaml = sampleFrameV3(
      "x".repeat(4 * 1024 * 1024 + 1),
      5,
    );
    expect(() =>
      new IRacingSourceFrameEncoder().encode(oversizedYaml),
    ).toThrow(/too large/);
    expect(() =>
      new IRacingSourceFrameEncoder().encode(
        sampleFrameV3(frame.sessionInfo, 0x8000_0000),
      ),
    ).toThrow(/Invalid iRacing SessionInfo revision/);
  });

  test("invalidates decoder state after a malformed session refresh", () => {
    const encoder = new IRacingSourceFrameEncoder();
    const decoder = createIRacingSourceDecoderState();
    const initial = sampleFrameV3("WeekendInfo:\n  TrackName: roadamerica\n", 1);
    const refreshed = sampleFrameV3("WeekendInfo:\n  TrackName: spa\n", 2);
    const next = sampleFrameV3(refreshed.sessionInfo, refreshed.sessionInfoUpdate);
    next.values = { ...next.values, SessionTick: 7531 };

    expect(
      decodeIRacingSourceFrame(encoder.encode(initial), decoder),
    ).toEqual(initial);
    const refreshRaw = encoder.encode(refreshed);
    const deltaRaw = encoder.encode(next);
    const invalidRefresh = Buffer.from(refreshRaw);
    invalidRefresh[refreshRaw.length - Buffer.byteLength(refreshed.sessionInfo)] =
      0xff;

    expect(decodeIRacingSourceFrame(invalidRefresh, decoder)).toBeNull();
    expect(decoder.session).toBeNull();
    expect(decodeIRacingSourceFrame(deltaRaw, decoder)).toBeNull();
  });

  test("normalization never exposes raw v3 YAML on telemetry packets", () => {
    const frame = sampleFrameV3();
    const packet = normalizeIRacingFrame(frame);

    expect(packet).not.toHaveProperty("sessionInfo");
    expect(packet).not.toHaveProperty("sessionInfoUpdate");
    expect(packet.iracing).not.toHaveProperty("sessionInfo");
    expect(packet.iracing).not.toHaveProperty("sessionInfoUpdate");
  });

  test("maps lateral, vertical, and braking acceleration onto canonical axes", () => {
    const frame = sampleFrame();
    frame.values = {
      ...frame.values,
      LatAccel: 4.2,
      VertAccel: 9.8,
      LongAccel: -3.5,
    };

    const packet = normalizeIRacingFrame(frame);

    expect(packet.AccelerationX).toBeCloseTo(4.2);
    expect(packet.AccelerationY).toBeCloseTo(9.8);
    expect(packet.AccelerationZ).toBeCloseTo(-3.5);
  });

  test("packs normal ticks as value-only deltas", () => {
    const encoder = new IRacingSourceFrameEncoder();
    const decoder = createIRacingSourceDecoderState();
    const first = sampleFrame();
    const next = sampleFrame();
    next.values = {
      ...next.values,
      SessionTime: 125.5 + 1 / 60,
      SessionTick: 7531,
    };

    const sessionFrame = encoder.encode(first);
    const deltaFrame = encoder.encode(next);
    const unchangedDeltaFrame = encoder.encode(next);
    expect(isIRacingSessionFrame(sessionFrame)).toBe(true);
    expect(isIRacingSessionFrame(deltaFrame)).toBe(false);
    expect(deltaFrame.length).toBeLessThan(64);
    expect(deltaFrame.length).toBeLessThan(sessionFrame.length / 10);
    expect(unchangedDeltaFrame.length).toBe(14);
    expect(decodeIRacingSourceFrame(deltaFrame)).toBeNull();
    expect(decodeIRacingSourceFrame(sessionFrame, decoder)).toEqual(first);
    expect(decodeIRacingSourceFrame(deltaFrame, decoder)).toEqual(next);
    expect(decodeIRacingSourceFrame(unchangedDeltaFrame, decoder)).toEqual(next);
  });

  test("delta frames preserve detailed native channel names and value shapes", () => {
    const encoder = new IRacingSourceFrameEncoder();
    const decoder = createIRacingSourceDecoderState();
    const first = sampleFrame();
    const next = sampleFrame();
    next.values = {
      ...next.values,
      CarPath: " gt3 evo car ",
      CarIdxOnPitRoad: [false, true, false],
      EngineWarnings: 0x80000002,
      CarIdxLapDistPct: [0.25, 0.625, 0.9375],
      LapDeltaToBestLap: 0.001234567890123,
    };

    expect(decodeIRacingSourceFrame(encoder.encode(first), decoder)).toEqual(
      first,
    );
    expect(decodeIRacingSourceFrame(encoder.encode(next), decoder)).toEqual(
      next,
    );
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

describe("iRacing lap timing and native sectors", () => {
  test("resets normalized elapsed time at the physical Lap transition", () => {
    const state = createIRacingParserState();
    const before = sampleFrame();
    before.values = {
      ...before.values,
      SessionTime: 100,
      Lap: 28,
      LapCurrentLapTime: 31.7,
      LapLastLapTime: 32.1,
    };
    const atLine = sampleFrame();
    atLine.values = {
      ...atLine.values,
      SessionTime: 100.02,
      Lap: 29,
      LapCurrentLapTime: 31.72,
      LapLastLapTime: 32.1,
    };
    const afterSdkRollover = sampleFrame();
    afterSdkRollover.values = {
      ...afterSdkRollover.values,
      SessionTime: 101.82,
      Lap: 29,
      LapCurrentLapTime: 1.8,
      LapLastLapTime: 31.7559,
    };

    expect(normalizeIRacingFrame(before, state).CurrentLap).toBeCloseTo(31.7);
    const linePacket = normalizeIRacingFrame(atLine, state);
    const rolloverPacket = normalizeIRacingFrame(afterSdkRollover, state);

    expect(linePacket.LapNumber).toBe(29);
    expect(linePacket.CurrentLap).toBeCloseTo(0);
    expect(linePacket.iracing?.sdkCurrentLapTime).toBeCloseTo(31.72);
    expect(rolloverPacket.CurrentLap).toBeCloseTo(1.8);
    expect(rolloverPacket.LastLap).toBeCloseTo(31.7559);
  });

  test("supports an explicitly two-sector native layout", async () => {
    const twoSectorTrackOrdinal = 1_000_099;
    const packets = Array.from({ length: 101 }, (_, index) => {
      const fraction = index / 100;
      return {
        gameId: "iracing",
        CurrentLap: fraction * 32,
        DistanceTraveled: fraction * 2350,
        iracing: {
          trackLengthM: 2350,
          lapDistancePct: fraction,
          sectorStarts: [0, 0.5],
        },
      } as TelemetryPacket;
    });

    const timeline = computeIRacingSectorTimeline(packets, 32);
    expect(timeline?.sectorCount).toBe(2);
    expect(timeline?.times).toEqual([16, 16]);
    expect(timeline?.boundaryIndices).toHaveLength(1);
    expect(
      await computeLapSectors(
        twoSectorTrackOrdinal,
        "iracing",
        packets,
        32,
      ),
    ).toEqual([16, 16]);

    const liveTracker = new SectorTracker();
    await liveTracker.reset(twoSectorTrackOrdinal, "iracing", 42);
    let live: ReturnType<SectorTracker["feed"]> = null;
    for (const packet of packets) live = liveTracker.feed(packet);
    expect(live?.sectorCount).toBe(2);
    expect(live?.currentSector).toBe(1);
  });

  test("does not invent iRacing sectors when native metadata is absent", async () => {
    const packets = Array.from({ length: 60 }, (_, index) => {
      const fraction = index / 59;
      return {
        gameId: "iracing",
        CurrentLap: fraction * 32,
        DistanceTraveled: fraction * 2350,
        iracing: { lapDistancePct: fraction },
      } as TelemetryPacket;
    });

    expect(computeIRacingSectorTimeline(packets, 32)).toBeNull();
    expect(await computeLapSectors(99, "iracing", packets, 32)).toBeNull();
  });

  test("keeps native sector fractions when the source attaches mid-lap", async () => {
    const tracker = new SectorTracker();
    await tracker.reset(99, "iracing", 42);

    const packet = (
      lapNumber: number,
      distance: number,
      fraction: number,
      currentLap: number,
    ): TelemetryPacket =>
      ({
        gameId: "iracing",
        LapNumber: lapNumber,
        LastLap: 40,
        CurrentLap: currentLap,
        DistanceTraveled: distance,
        iracing: {
          trackLengthM: 1000,
          lapDistancePct: fraction,
          sectorStarts: [0, 0.34, 0.67],
        },
      }) as TelemetryPacket;

    tracker.feed(packet(5, 5750, 0.75, 30));
    tracker.feed(packet(6, 6000, 0, 0));
    const live = tracker.feed(packet(6, 6300, 0.3, 10));

    expect(tracker.getTrackLength()).toBe(1000);
    expect(live?.currentSector).toBe(0);
  });

  test("attaches delayed LastLap to the physical lap and native lap number", async () => {
    const db = new CapturingDbAdapter();
    const detector = new LapDetectorIRacing({
      db,
      bypassPacketRateFilter: true,
    });
    const trackLength = 2350;
    let offset = 0;

    const packet = (
      lapNumber: number,
      currentLap: number,
      sdkCurrentLapTime: number,
      lastLap: number,
      fraction: number,
    ): TelemetryPacket =>
      ({
        gameId: "iracing",
        sessionUID: "456:123:2",
        CarOrdinal: 42,
        TrackOrdinal: 99,
        CarPerformanceIndex: 0,
        CarClass: 8,
        LapNumber: lapNumber,
        CurrentLap: currentLap,
        LastLap: lastLap,
        BestLap: 0,
        CurrentRaceTime: 100 + lapNumber * 40 + currentLap,
        DistanceTraveled:
          lapNumber * trackLength + Math.min(fraction, 0.999) * trackLength,
        PositionX: 0,
        PositionY: 0,
        PositionZ: 0,
        Speed: 70,
        TimestampMS: Math.round(
          (100 + lapNumber * 40 + currentLap) * 1000,
        ),
        Fuel: 40,
        TireWearFL: 0,
        TireWearFR: 0,
        TireWearRL: 0,
        TireWearRR: 0,
        iracing: {
          sdkCurrentLapTime,
          lapDistancePct: fraction,
          sectorStarts: [0, 0.5],
          carName: "GT3 Test Car",
          trackName: "Road America",
        },
      }) as TelemetryPacket;

    const feed = async (value: TelemetryPacket) => {
      await detector.feed(value, offset);
      offset += 100;
    };

    // Initial fragment is deliberately discarded.
    await feed(packet(0, 20, 20, 0, 0.5));
    await feed(packet(1, 0, 20.01, 20, 0));

    for (let i = 1; i <= 64; i++) {
      const elapsed = (31.917 * i) / 64;
      await feed(packet(1, elapsed, elapsed, 20, i / 65));
    }

    // Physical line crossing happens first; SDK timing rolls 1.8s later.
    await feed(packet(2, 0, 31.917, 20, 0));
    await feed(packet(2, 1.8, 1.8, 31.917, 1.8 / 32.045));

    for (let i = 5; i <= 64; i++) {
      const elapsed = (32.045 * i) / 64;
      await feed(packet(2, elapsed, elapsed, 31.917, i / 65));
    }

    await feed(packet(3, 0, 32.045, 31.917, 0));
    await feed(packet(3, 1.8, 1.8, 32.045, 1.8 / 33));

    expect(db.laps).toHaveLength(2);
    expect(db.laps.map((lap) => lap.lapNumber)).toEqual([1, 2]);
    expect(db.laps[0].lapTime).toBeCloseTo(31.917, 3);
    expect(db.laps[1].lapTime).toBeCloseTo(32.045, 3);
    expect(db.laps[0].rawFrameCount).toBe(65);
    expect(db.laps[0].sectors).toHaveLength(2);
    expect(db.sessions[0]).toMatchObject({
      carOrdinal: 42,
      trackOrdinal: 99,
    });
    expect(db.sessions[0]).not.toHaveProperty("carName");
    expect(db.sessions[0]).not.toHaveProperty("trackName");

    // A native timer rollover without a valid LastLap discards that lap and
    // leaves the following valid lap aligned with its own timing.
    await feed(packet(4, 0, 33, 32.045, 0));
    await feed(packet(4, 1.8, 1.8, 0, 1.8 / 33));
    for (let i = 5; i <= 64; i++) {
      const elapsed = (33 * i) / 64;
      await feed(packet(4, elapsed, elapsed, 0, i / 65));
    }
    await feed(packet(5, 0, 33, 0, 0));
    await feed(packet(5, 1.8, 1.8, 33, 1.8 / 33));

    expect(db.laps.map((lap) => lap.lapNumber)).toEqual([1, 2, 4]);

    // iRacing can emit one zeroed SDK frame after a session. It must not turn
    // the following valid lap number into an invalid "0 → N" ghost lap.
    await feed(packet(0, 0, 0, 33, 0));
    await feed(packet(5, 2, 2, 33, 0.05));
    expect(db.laps.map((lap) => lap.lapNumber)).toEqual([1, 2, 4]);

    // A persistent unexpected transition still reaches the shared detector.
    await feed(packet(2, 0, 0, 33, 0));
    expect(detector.getDebugState()).toMatchObject({
      iracingPhysicalLap: 5,
      iracingPendingUnexpectedLap: 2,
    });
    await feed(packet(2, 0.1, 0.1, 33, 0.001));
    expect(detector.getDebugState()).toMatchObject({
      iracingPhysicalLap: 2,
      iracingPendingUnexpectedLap: null,
    });
    expect(db.laps[2].lapTime).toBe(33);
  });
});
