import { describe, expect, test } from "bun:test";
import { initServerGameAdapters } from "../server/games/init";
import { parseIRacingSessionInfo } from "../server/games/iracing/session-info";
import {
  type IRacingFrameReader,
  IRacingTelemetrySource,
} from "../server/games/iracing/source";
import {
  canHandleIRacingSourceFrame,
  decodeIRacingSourceFrame,
  encodeIRacingSourceFrame,
  type IRacingSourceFrameV1,
} from "../server/games/iracing/source-frame";
import {
  IRacingVariableTable,
  IRSDK_VAR_HEADER_SIZE,
  IRSDKVariableType,
} from "../server/games/iracing/variable-table";
import { parsePacket } from "../server/parsers";
import { initGameAdapters } from "../shared/games/init";

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

function sampleFrame(): IRacingSourceFrameV1 {
  return {
    schemaVersion: 1,
    session: {
      sessionId: 123,
      subSessionId: 456,
      sessionNum: 2,
      driverCarIdx: 7,
      trackId: 99,
      trackName: "Road America",
      trackLengthM: 6515,
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
      TrackWetness: 0,
    },
  };
}

describe("native iRacing SDK decoding", () => {
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

  test("ignores descriptors that point outside the SDK row", () => {
    const headers = descriptor(IRSDKVariableType.Double, 28, 1, "OutOfBounds");
    const table = new IRacingVariableTable(headers, 32);
    expect(table.has("OutOfBounds")).toBe(false);
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
    expect(session.carId).toBe(42);
    expect(session.carName).toBe("GT3 Test Car");
    expect(session.carClassName).toBe("GT3");
    expect(session.sessionNum).toBe(2);
  });
});

describe("iRacing raw source frame parser integration", () => {
  test("round-trips a self-contained frame through central parsePacket", () => {
    const raw = encodeIRacingSourceFrame(sampleFrame());
    expect(canHandleIRacingSourceFrame(raw)).toBe(true);
    expect(decodeIRacingSourceFrame(raw)).toEqual(sampleFrame());

    const packet = parsePacket(raw);
    expect(packet?.gameId).toBe("iracing");
    expect(packet?.sessionUID).toBe("456:123:2");
    expect(packet?.CarOrdinal).toBe(42);
    expect(packet?.TrackOrdinal).toBe(99);
    expect(packet?.LapNumber).toBe(4);
    expect(packet?.DistanceTraveled).toBeCloseTo(20745);
    expect(packet?.Speed).toBeCloseTo(72.5);
    expect(packet?.Accel).toBe(191);
    expect(packet?.Brake).toBe(51);
    expect(packet?.Steer).toBe(13);
    expect(packet?.TireTempFL).toBeCloseTo(84);
    expect(packet?.TireWearFL).toBeCloseTo(0.06);
    expect(packet?.iracing?.incidents).toBe(1);
  });

  test("rejects truncated and corrupt source frames", () => {
    const raw = encodeIRacingSourceFrame(sampleFrame());
    expect(decodeIRacingSourceFrame(raw.subarray(0, raw.length - 1))).toBeNull();
    raw.writeUInt32LE(0xffffffff, 8);
    expect(decodeIRacingSourceFrame(raw)).toBeNull();
  });

  test("source owns the SDK snapshot and emits its raw frame to the parser boundary", async () => {
    let delivered: Buffer | null = null;
    const frame = sampleFrame();
    const reader: IRacingFrameReader = {
      start() {},
      async stop() {},
      readLatest() {
        return {
          tick: 7530,
          sessionInfo: `
WeekendInfo:
  TrackID: 99
  TrackLength: 6.515 km
  TrackDisplayName: Road America
  SessionID: 123
  SubSessionID: 456
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
`,
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
    expect(parsePacket(delivered!)?.gameId).toBe("iracing");
  });
});
