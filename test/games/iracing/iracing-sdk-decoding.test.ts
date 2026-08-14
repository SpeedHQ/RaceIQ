import { describe, expect, test } from "bun:test";
import { initServerGameAdapters } from "../../../server/games/init";
import { parseIRacingSessionInfo } from "../../../server/games/iracing/session-info";
import {
  IRacingSdkReader,
  isValidIRacingMappingRange,
} from "../../../server/games/iracing/sdk-reader";
import { LAP_DETECTOR_IRACING_ID } from "../../../server/games/iracing/lap-detector";
import {
  IRacingVariableTable,
  IRSDK_VAR_HEADER_SIZE,
  IRSDKVariableType,
} from "../../../server/games/iracing/variable-table";
import { initGameAdapters } from "../../../shared/games/init";
import {
  iracingAdapter,
} from "../../../shared/games/iracing";

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

describe("native iRacing SDK decoding", () => {
  test("declares native timing and replay capabilities", () => {
    expect(iracingAdapter.nativeSectors).toBe(true);
    expect(iracingAdapter.authoritativeTrackLength).toBe(true);
    expect(iracingAdapter.appendsDelayedFinishFrame).toBe(false);
    expect(LAP_DETECTOR_IRACING_ID).toBe("iracing_lapdetector_v5");
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
    const copied = {
      sourceAddress: null as bigint | null,
      byteLength: null as bigint | null,
    };
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
          copied.sourceAddress = source;
          copied.byteLength = length;
        },
      },
    };

    expect(reader._copy(96, 16)).toHaveLength(16);
    expect(copied.sourceAddress).toBe(0x1_0000_0060n);
    expect(copied.byteLength).toBe(16n);
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
