import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IRSDK_VAR_HEADER_SIZE, IRSDKVariableType } from "../../../server/games/iracing/variable-table";

export const DISK_HEADER_SIZE = 144;
export const ROW_LENGTH = 56;

export interface SyntheticRow {
  sessionTime: number;
  sessionTick: number;
  speed: number;
  lapDistancePct: number;
  lap?: number;
  lastLapTime?: number;
  currentLapTime?: number;
  brakeLinePressure?: number;
  latitude?: number;
  longitude?: number;
  altitude?: number;
}

export interface SyntheticIdentity {
  trackId: number;
  trackName: string;
  carId: number;
  carName: string;
}

export const DEFAULT_IDENTITY: SyntheticIdentity = {
  trackId: 99,
  trackName: "Road America",
  carId: 42,
  carName: "GT3 Test Car",
};

export interface SyntheticIbtRecording {
  path: string;
  tempDir: string;
  cleanup: () => void;
}

export function writeCString(buffer: Buffer, offset: number, length: number, value: string): void {
  Buffer.from(value, "utf8").copy(buffer, offset, 0, length - 1);
}

function descriptor(type: IRSDKVariableType, valueOffset: number, name: string): Buffer {
  const buffer = Buffer.alloc(IRSDK_VAR_HEADER_SIZE);
  buffer.writeInt32LE(type, 0);
  buffer.writeInt32LE(valueOffset, 4);
  buffer.writeInt32LE(1, 8);
  writeCString(buffer, 16, 32, name);
  writeCString(buffer, 48, 64, `${name} description`);
  return buffer;
}

function telemetryRow(row: SyntheticRow): Buffer {
  const buffer = Buffer.alloc(ROW_LENGTH);
  buffer.writeDoubleLE(row.sessionTime, 0);
  buffer.writeInt32LE(row.sessionTick, 8);
  buffer.writeInt32LE(2, 12);
  buffer.writeUInt8(1, 16);
  buffer.writeUInt8(0, 17);
  buffer.writeFloatLE(row.speed, 20);
  buffer.writeInt32LE(row.lap ?? 3, 24);
  buffer.writeFloatLE(row.lapDistancePct, 28);
  buffer.writeFloatLE(row.lastLapTime ?? 0, 32);
  buffer.writeFloatLE(row.currentLapTime ?? row.sessionTime, 36);
  buffer.writeFloatLE(row.brakeLinePressure ?? 1200.25, 40);
  buffer.writeFloatLE(row.latitude ?? 0, 44);
  buffer.writeFloatLE(row.longitude ?? 0, 48);
  buffer.writeFloatLE(row.altitude ?? 0, 52);
  return buffer;
}

export function syntheticSessionInfo(identity: SyntheticIdentity): string {
  return `
WeekendInfo:
  TrackID: ${identity.trackId}
  TrackLength: 6.515 km
  TrackDisplayName: ${identity.trackName}
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
    CarID: ${identity.carId}
    CarScreenName: ${identity.carName}
    CarClassID: 8
    CarClassShortName: GT3
`;
}

export function writeSyntheticIbt(path: string, suppliedRows?: SyntheticRow[], identity: SyntheticIdentity = DEFAULT_IDENTITY): void {
  const variableHeaders = Buffer.concat([
    descriptor(IRSDKVariableType.Double, 0, "SessionTime"),
    descriptor(IRSDKVariableType.Int, 8, "SessionTick"),
    descriptor(IRSDKVariableType.Int, 12, "SessionNum"),
    descriptor(IRSDKVariableType.Bool, 16, "IsOnTrack"),
    descriptor(IRSDKVariableType.Bool, 17, "OnPitRoad"),
    descriptor(IRSDKVariableType.Float, 20, "Speed"),
    descriptor(IRSDKVariableType.Int, 24, "Lap"),
    descriptor(IRSDKVariableType.Float, 28, "LapDistPct"),
    descriptor(IRSDKVariableType.Float, 32, "LapLastLapTime"),
    descriptor(IRSDKVariableType.Float, 36, "LapCurrentLapTime"),
    descriptor(IRSDKVariableType.Float, 40, "LFbrakeLinePress"),
    descriptor(IRSDKVariableType.Float, 44, "Lat"),
    descriptor(IRSDKVariableType.Float, 48, "Lon"),
    descriptor(IRSDKVariableType.Float, 52, "Alt"),
  ]);
  const sessionInfo = Buffer.from(`${syntheticSessionInfo(identity)}\0`, "utf8");
  const sourceRows: SyntheticRow[] = suppliedRows ?? [
    {
      sessionTime: 10,
      sessionTick: 600,
      speed: 50.5,
      lapDistancePct: 0.25,
      brakeLinePressure: 1200.25,
      latitude: 43,
      longitude: -88,
      altitude: 200,
    },
    {
      sessionTime: 10 + 1 / 60,
      sessionTick: 601,
      speed: 51.5,
      lapDistancePct: 0.26,
      brakeLinePressure: 1201.5,
      latitude: 43.0001,
      longitude: -87.9999,
      altitude: 201.5,
    },
  ];
  const rows = sourceRows.map(telemetryRow);

  const sessionInfoOffset = DISK_HEADER_SIZE + variableHeaders.length;
  const header = Buffer.alloc(DISK_HEADER_SIZE);
  header.writeInt32LE(2, 0);
  header.writeInt32LE(1, 4);
  header.writeInt32LE(60, 8);
  header.writeInt32LE(sessionInfo.length, 16);
  header.writeInt32LE(sessionInfoOffset, 20);
  header.writeInt32LE(variableHeaders.length / IRSDK_VAR_HEADER_SIZE, 24);
  header.writeInt32LE(DISK_HEADER_SIZE, 28);
  header.writeInt32LE(1, 32);
  header.writeInt32LE(ROW_LENGTH, 36);
  header.writeBigInt64LE(1_757_390_931n, 112);
  header.writeDoubleLE(sourceRows[0]?.sessionTime ?? 0, 120);
  header.writeDoubleLE(sourceRows[sourceRows.length - 1]?.sessionTime ?? 0, 128);
  header.writeInt32LE(1, 136);
  header.writeInt32LE(rows.length, 140);

  writeFileSync(path, Buffer.concat([header, variableHeaders, sessionInfo, ...rows]));
}

export function createRecording(fileName = "sample.ibt", suppliedRows?: SyntheticRow[], identity: SyntheticIdentity = DEFAULT_IDENTITY): SyntheticIbtRecording {
  const tempDir = mkdtempSync(join(tmpdir(), "raceiq-ibt-"));
  const path = join(tempDir, fileName);
  writeSyntheticIbt(path, suppliedRows, identity);
  let cleaned = false;
  return {
    path,
    tempDir,
    cleanup: () => {
      if (!cleaned) {
        rmSync(tempDir, { recursive: true, force: true });
        cleaned = true;
      }
    },
  };
}

export function drivenRows(): SyntheticRow[] {
  return [
    {
      sessionTime: 0,
      sessionTick: 0,
      speed: 45,
      lap: 1,
      lapDistancePct: 0.2,
      currentLapTime: 10,
      latitude: 43,
      longitude: -88,
      altitude: 200,
    },
    {
      sessionTime: 45,
      sessionTick: 2700,
      speed: 48,
      lap: 1,
      lapDistancePct: 0.9,
      currentLapTime: 55,
      latitude: 43.0001,
      longitude: -88.0002,
      altitude: 201,
    },
    {
      sessionTime: 50,
      sessionTick: 3000,
      speed: 44,
      lap: 2,
      lapDistancePct: 0.1,
      lastLapTime: 60,
      currentLapTime: 5,
      latitude: 43.0002,
      longitude: -88,
      altitude: 202,
    },
    {
      sessionTime: 105,
      sessionTick: 6300,
      speed: 47,
      lap: 2,
      lapDistancePct: 0.9,
      lastLapTime: 60,
      currentLapTime: 55,
      latitude: 43.0003,
      longitude: -87.9998,
      altitude: 203,
    },
    {
      sessionTime: 110,
      sessionTick: 6600,
      speed: 46,
      lap: 3,
      lapDistancePct: 0.1,
      lastLapTime: 60,
      currentLapTime: 5,
      latitude: 43.0004,
      longitude: -88,
      altitude: 204,
    },
    {
      sessionTime: 112,
      sessionTick: 6720,
      speed: 46,
      lap: 3,
      lapDistancePct: 0.14,
      lastLapTime: 61,
      currentLapTime: 2,
      latitude: 43.00041,
      longitude: -88.00002,
      altitude: 204.5,
    },
  ];
}
