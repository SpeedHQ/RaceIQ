import {
  DuckDBInstance,
  type DuckDBConnection,
} from "@duckdb/node-api";
import { lmuIdentityOrdinal } from "../../../shared/games/lmu";
import type { SessionOwnership } from "../../../shared/racing/sessions/types";
import {
  importSessionFrames,
  type ImportedLap,
} from "../../session-capture/import-pipeline";
import { registerImportedLMUIdentity } from "./identity";
import {
  LMU_SCORING_INFO,
  LMU_SCORING_INFO_SIZE,
  LMU_SCORING_VEHICLE,
  LMU_SCORING_VEHICLE_SIZE,
  LMU_TELEMETRY,
  LMU_TELEMETRY_INFO_SIZE,
  LMU_WHEEL,
  LMU_WHEEL_SIZE,
} from "./layout";
import {
  encodeLMUSourcePayload,
  type LMUIdentity,
} from "./source-frame";

const IMPORT_FRAME_RATE = 50;
const GRAVITY_MPS2 = 9.80665;

const EARTH_RADIUS_M = 6_371_000;
const ESTIMATED_TIRE_RADIUS_M = 0.33;
const DUCKDB_SIGNATURE_OFFSET = 8;
const DUCKDB_SIGNATURE = Buffer.from("DUCK", "ascii");

interface LMUDuckDBMetadata {
  version: number;
  recordingTime: string;
  sessionType: string;
  driverName: string;
  carName: string;
  carClass: string;
  trackName: string;
}

export interface LMUDuckDBPreview extends LMUDuckDBMetadata {
  gameId: "lmu";
  estimatedPacketCount: number;
  completedLapCount: number;
}

interface ContinuousSeries {
  frequency: number;
  columns: number[][];
}

interface EventEntry {
  timestamp: number;
  values: unknown[];
}

interface EventSeries {
  entries: EventEntry[];
}

interface LoadedLMUDuckDB {
  metadata: LMUDuckDBMetadata;
  continuous: Map<string, ContinuousSeries>;
  events: Map<string, EventSeries>;
  startTime: number;
  duration: number;
  trackLengthM: number;
}

function quotedIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function numberValue(value: unknown, fallback = 0): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function writeCString(
  buffer: Buffer,
  offset: number,
  length: number,
  value: string,
): void {
  const source = Buffer.from(value, "utf8");
  source.copy(buffer, offset, 0, Math.min(source.length, length - 1));
}

function recordingEpochMs(recordingTime: string): number {
  const match = recordingTime.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})_(\d{2})_(\d{2})Z$/,
  );
  if (!match) return 0;
  const parsed = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sessionTypeOrdinal(sessionType: string): number {
  const normalized = sessionType.trim().toLowerCase();
  if (normalized.includes("race")) return 10;
  if (normalized.includes("qual")) return 5;
  if (normalized.includes("warm")) return 9;
  return 1;
}

function vehicleClassOrdinal(carClass: string): number {
  const normalized = carClass.trim().toUpperCase();
  if (normalized.includes("HYPERCAR")) return 0;
  if (normalized.includes("LMP2")) return 3;
  if (normalized.includes("LMP3")) return 4;
  if (normalized.includes("GTE")) return 5;
  if (normalized.includes("GT3")) return 6;
  return 0xff;
}

async function queryObjects(
  connection: DuckDBConnection,
  sql: string,
): Promise<Record<string, unknown>[]> {
  const reader = await connection.runAndReadAll(sql);
  return reader.getRowObjects();
}

async function readMetadata(
  connection: DuckDBConnection,
): Promise<LMUDuckDBMetadata> {
  const rows = await queryObjects(
    connection,
    "SELECT key, value FROM metadata",
  );
  const values = new Map(
    rows.map((row) => [textValue(row.key), textValue(row.value)]),
  );
  const trackName = values.get("TrackName")?.trim() ?? "";
  const carName = values.get("CarName")?.trim() ?? "";
  if (!trackName || !carName || !values.has("RecordingTime")) {
    throw new Error("DuckDB file is not an LMU telemetry recording");
  }
  return {
    version: numberValue(values.get("Version"), 1),
    recordingTime: values.get("RecordingTime") ?? "",
    sessionType: values.get("SessionType") ?? "Unknown",
    driverName: values.get("DriverName") ?? "Unknown driver",
    carName,
    carClass: values.get("CarClass") ?? "Unknown",
    trackName,
  };
}

interface LMUDuckDBSchemaIndex {
  tableNames: Set<string>;
  frequencies: Map<string, number>;
}

async function readSchemaIndex(
  connection: DuckDBConnection,
): Promise<LMUDuckDBSchemaIndex> {
  const tableRows = await queryObjects(
    connection,
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'",
  );
  const tableNames = new Set(
    tableRows.map((row) => textValue(row.table_name)),
  );
  if (!tableNames.has("channelsList") || !tableNames.has("eventsList")) {
    throw new Error("DuckDB file is missing LMU telemetry channel indexes");
  }
  const frequencyRows = await queryObjects(
    connection,
    "SELECT channelName, frequency FROM channelsList",
  );
  const frequencies = new Map(
    frequencyRows.map((row) => [
      textValue(row.channelName),
      numberValue(row.frequency),
    ]),
  );
  return { tableNames, frequencies };
}

async function loadContinuousSeries(
  connection: DuckDBConnection,
  tableNames: ReadonlySet<string>,
  frequencies: ReadonlyMap<string, number>,
  tableName: string,
  columns: readonly string[],
): Promise<ContinuousSeries | null> {
  const frequency = frequencies.get(tableName);
  if (!frequency || !tableNames.has(tableName)) return null;
  const projection = columns.map(quotedIdentifier).join(", ");
  const reader = await connection.runAndReadAll(
    `SELECT ${projection} FROM ${quotedIdentifier(tableName)}`,
  );
  return {
    frequency,
    columns: reader
      .getColumns()
      .map((column) => column.map((value) => numberValue(value))),
  };
}

async function loadEventSeries(
  connection: DuckDBConnection,
  tableNames: ReadonlySet<string>,
  tableName: string,
  columns: readonly string[],
): Promise<EventSeries | null> {
  if (!tableNames.has(tableName)) return null;
  const projection = ["ts", ...columns].map(quotedIdentifier).join(", ");
  const reader = await connection.runAndReadAll(
    `SELECT ${projection} FROM ${quotedIdentifier(tableName)} ORDER BY ts`,
  );
  const rows = reader.getRows();
  return {
    entries: rows.map((row) => ({
      timestamp: numberValue(row[0]),
      values: row.slice(1),
    })),
  };
}

const CONTINUOUS_CHANNELS = {
  "Brake Pos Unfiltered": ["value"],
  "Throttle Pos Unfiltered": ["value"],
  "Clutch Pos Unfiltered": ["value"],
  "Steering Pos Unfiltered": ["value"],
  "Engine RPM": ["value"],
  "G Force Lat": ["value"],
  "G Force Long": ["value"],
  "G Force Vert": ["value"],
  "Ground Speed": ["value"],
  "GPS Latitude": ["value"],
  "GPS Longitude": ["value"],
  "Fuel Level": ["value"],
  "Lap Dist": ["value"],
  "Total Dist": ["value"],
  "Tyres Wear": ["value1", "value2", "value3", "value4"],
  TyresPressure: ["value1", "value2", "value3", "value4"],
  TyresTempLeft: ["value1", "value2", "value3", "value4"],
  TyresTempCentre: ["value1", "value2", "value3", "value4"],
  TyresTempRight: ["value1", "value2", "value3", "value4"],
  TyresCarcassTemp: ["value1", "value2", "value3", "value4"],
  "Brakes Temp": ["value1", "value2", "value3", "value4"],
  "Wheel Speed": ["value1", "value2", "value3", "value4"],
  "Susp Pos": ["value1", "value2", "value3", "value4"],
  TC: ["value"],
  SoC: ["value"],
  "Virtual Energy": ["value"],
  "Regen Rate": ["value"],
  "Ambient Temperature": ["value"],
  "Track Temperature": ["value"],
} as const;

const EVENT_CHANNELS = {
  "Engine Max RPM": ["value"],
  Gear: ["value"],
  Lap: ["value"],
  "Lap Time": ["value"],
  "Best LapTime": ["value"],
  "In Pits": ["value"],
  "Current Sector": ["value"],
  TCCut: ["value"],
  ABSLevel: ["value"],
  RearFlapActivated: ["value"],
  "Speed Limiter": ["value"],
  TyresCompound: ["value1", "value2", "value3", "value4"],
} as const;

async function loadLMUDuckDB(path: string): Promise<LoadedLMUDuckDB> {
  const instance = await DuckDBInstance.create(path, {
    access_mode: "READ_ONLY",
    threads: "1",
    memory_limit: "512MB",
  });
  const connection = await instance.connect();
  try {
    const metadata = await readMetadata(connection);
    const { tableNames, frequencies } = await readSchemaIndex(connection);
    const continuous = new Map<string, ContinuousSeries>();
    for (const [name, columns] of Object.entries(CONTINUOUS_CHANNELS)) {
      const series = await loadContinuousSeries(
        connection,
        tableNames,
        frequencies,
        name,
        columns,
      );
      if (series) continuous.set(name, series);
    }
    const events = new Map<string, EventSeries>();
    for (const [name, columns] of Object.entries(EVENT_CHANNELS)) {
      const series = await loadEventSeries(
        connection,
        tableNames,
        name,
        columns,
      );
      if (series) events.set(name, series);
    }
    const eventTimestamps = [...events.values()].flatMap((series) =>
      series.entries.map((entry) => entry.timestamp),
    );
    const startTime = eventTimestamps.length > 0
      ? Math.min(...eventTimestamps)
      : 0;
    let duration = 0;
    for (const series of continuous.values()) {
      duration = Math.max(
        duration,
        Math.max(0, (series.columns[0]?.length ?? 0) - 1) / series.frequency,
      );
    }
    const lapDistances = continuous.get("Lap Dist")?.columns[0] ?? [];
    const trackLengthM = lapDistances.reduce(
      (maximum, value) => Math.max(maximum, value),
      0,
    );
    if (duration <= 0 || trackLengthM <= 0) {
      throw new Error("LMU telemetry recording contains no drivable samples");
    }
    return {
      metadata,
      continuous,
      events,
      startTime,
      duration,
      trackLengthM,
    };
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

function continuousValue(
  loaded: LoadedLMUDuckDB,
  name: string,
  time: number,
  column = 0,
  fallback = 0,
): number {
  const series = loaded.continuous.get(name);
  const values = series?.columns[column];
  if (!series || !values?.length) return fallback;
  const index = Math.min(
    values.length - 1,
    Math.max(0, Math.floor((time - loaded.startTime) * series.frequency)),
  );
  return values[index] ?? fallback;
}

function eventEntry(
  loaded: LoadedLMUDuckDB,
  name: string,
  time: number,
): EventEntry | null {
  const entries = loaded.events.get(name)?.entries;
  if (!entries?.length) return null;
  let low = 0;
  let high = entries.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (entries[middle]!.timestamp <= time) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found >= 0 ? entries[found]! : null;
}

function eventValue(
  loaded: LoadedLMUDuckDB,
  name: string,
  time: number,
  column = 0,
  fallback = 0,
): number {
  return numberValue(eventEntry(loaded, name, time)?.values[column], fallback);
}

function writeOrientation(
  telemetry: Buffer,
  forwardX: number,
  forwardZ: number,
): void {
  const magnitude = Math.hypot(forwardX, forwardZ);
  const normalizedX = magnitude > 0 ? forwardX / magnitude : 0;
  const normalizedZ = magnitude > 0 ? forwardZ / magnitude : 1;
  const offset = LMU_TELEMETRY.orientation;
  telemetry.writeDoubleLE(normalizedZ, offset);
  telemetry.writeDoubleLE(-normalizedX, offset + 16);
  telemetry.writeDoubleLE(1, offset + 24 + 8);
  telemetry.writeDoubleLE(-normalizedX, offset + 48);
  telemetry.writeDoubleLE(-normalizedZ, offset + 48 + 16);
}

function identityFromMetadata(metadata: LMUDuckDBMetadata): LMUIdentity {
  return {
    carId: lmuIdentityOrdinal("car", metadata.carName),
    carName: metadata.carName,
    trackId: lmuIdentityOrdinal("track", metadata.trackName),
    trackName: metadata.trackName,
  };
}

function sessionEventId(recordingTime: string): number {
  return lmuIdentityOrdinal("track", `session:${recordingTime}`) >>> 0;
}

function buildSyntheticFrame(
  loaded: LoadedLMUDuckDB,
  time: number,
  epochMs: number,
): Buffer {
  const telemetry = Buffer.alloc(LMU_TELEMETRY_INFO_SIZE);
  const scoringInfo = Buffer.alloc(LMU_SCORING_INFO_SIZE);
  const scoring = Buffer.alloc(LMU_SCORING_VEHICLE_SIZE);
  const lapEntry = eventEntry(loaded, "Lap", time);
  const lapNumber = numberValue(lapEntry?.values[0]);
  const lapStartTime = lapEntry?.timestamp ?? loaded.startTime;
  const speedMps = continuousValue(loaded, "Ground Speed", time) / 3.6;
  const latitude = continuousValue(loaded, "GPS Latitude", time);
  const longitude = continuousValue(loaded, "GPS Longitude", time);
  const originLatitude = continuousValue(
    loaded,
    "GPS Latitude",
    loaded.startTime,
  );
  const originLongitude = continuousValue(
    loaded,
    "GPS Longitude",
    loaded.startTime,
  );
  const nextTime = Math.min(
    loaded.startTime + loaded.duration,
    time + 0.1,
  );
  const nextLatitude = continuousValue(loaded, "GPS Latitude", nextTime);
  const nextLongitude = continuousValue(loaded, "GPS Longitude", nextTime);
  const latitudeRadians = (originLatitude * Math.PI) / 180;
  const positionX =
    ((longitude - originLongitude) * Math.PI) / 180 *
    Math.cos(latitudeRadians) *
    EARTH_RADIUS_M;
  const positionZ =
    ((latitude - originLatitude) * Math.PI) / 180 * EARTH_RADIUS_M;
  const nextX =
    ((nextLongitude - originLongitude) * Math.PI) / 180 *
    Math.cos(latitudeRadians) *
    EARTH_RADIUS_M;
  const nextZ =
    ((nextLatitude - originLatitude) * Math.PI) / 180 * EARTH_RADIUS_M;

  telemetry.writeInt32LE(1, LMU_TELEMETRY.id);
  telemetry.writeDoubleLE(1 / IMPORT_FRAME_RATE, LMU_TELEMETRY.deltaTime);
  telemetry.writeDoubleLE(time, LMU_TELEMETRY.elapsedTime);
  telemetry.writeInt32LE(lapNumber, LMU_TELEMETRY.lapNumber);
  telemetry.writeDoubleLE(lapStartTime, LMU_TELEMETRY.lapStartElapsedTime);
  writeCString(telemetry, LMU_TELEMETRY.vehicleName, 64, loaded.metadata.carName);
  writeCString(telemetry, LMU_TELEMETRY.trackName, 64, loaded.metadata.trackName);
  telemetry.writeDoubleLE(positionX, LMU_TELEMETRY.position);
  telemetry.writeDoubleLE(positionZ, LMU_TELEMETRY.position + 16);
  telemetry.writeDoubleLE(-speedMps, LMU_TELEMETRY.localVelocity + 16);
  telemetry.writeDoubleLE(
    continuousValue(loaded, "G Force Lat", time) * GRAVITY_MPS2,
    LMU_TELEMETRY.localAcceleration,
  );
  telemetry.writeDoubleLE(
    continuousValue(loaded, "G Force Vert", time) * GRAVITY_MPS2,
    LMU_TELEMETRY.localAcceleration + 8,
  );
  telemetry.writeDoubleLE(
    -continuousValue(loaded, "G Force Long", time) * GRAVITY_MPS2,
    LMU_TELEMETRY.localAcceleration + 16,
  );
  writeOrientation(telemetry, nextX - positionX, nextZ - positionZ);
  telemetry.writeInt32LE(
    eventValue(loaded, "Gear", time),
    LMU_TELEMETRY.gear,
  );
  telemetry.writeDoubleLE(
    continuousValue(loaded, "Engine RPM", time),
    LMU_TELEMETRY.engineRpm,
  );
  telemetry.writeDoubleLE(
    continuousValue(loaded, "Throttle Pos Unfiltered", time) / 100,
    LMU_TELEMETRY.throttle,
  );
  telemetry.writeDoubleLE(
    continuousValue(loaded, "Brake Pos Unfiltered", time) / 100,
    LMU_TELEMETRY.brake,
  );
  telemetry.writeDoubleLE(
    continuousValue(loaded, "Steering Pos Unfiltered", time) / 100,
    LMU_TELEMETRY.steering,
  );
  telemetry.writeDoubleLE(
    continuousValue(loaded, "Clutch Pos Unfiltered", time) / 100,
    LMU_TELEMETRY.clutch,
  );
  telemetry.writeDoubleLE(
    continuousValue(loaded, "Fuel Level", time),
    LMU_TELEMETRY.fuel,
  );
  telemetry.writeDoubleLE(
    eventValue(loaded, "Engine Max RPM", time),
    LMU_TELEMETRY.engineMaxRpm,
  );
  telemetry.writeInt32LE(
    eventValue(loaded, "Current Sector", time),
    LMU_TELEMETRY.currentSector,
  );
  telemetry.writeUInt8(
    eventValue(loaded, "RearFlapActivated", time),
    LMU_TELEMETRY.rearFlapActivated,
  );
  telemetry.writeUInt8(
    eventValue(loaded, "Speed Limiter", time),
    LMU_TELEMETRY.speedLimiterActive,
  );
  telemetry.writeUInt8(
    continuousValue(loaded, "TC", time),
    LMU_TELEMETRY.tcActive,
  );
  telemetry.writeUInt8(
    eventValue(loaded, "TCCut", time),
    LMU_TELEMETRY.tcCut,
  );
  telemetry.writeUInt8(
    eventValue(loaded, "ABSLevel", time),
    LMU_TELEMETRY.abs,
  );
  telemetry.writeFloatLE(
    continuousValue(loaded, "Regen Rate", time),
    LMU_TELEMETRY.regenKw,
  );
  telemetry.writeFloatLE(
    continuousValue(loaded, "SoC", time),
    LMU_TELEMETRY.stateOfCharge,
  );
  telemetry.writeFloatLE(
    continuousValue(loaded, "Virtual Energy", time),
    LMU_TELEMETRY.virtualEnergy,
  );
  writeCString(telemetry, LMU_TELEMETRY.vehicleModel, 30, loaded.metadata.carName);
  telemetry.writeUInt8(
    vehicleClassOrdinal(loaded.metadata.carClass),
    LMU_TELEMETRY.vehicleClass,
  );

  for (let index = 0; index < 4; index++) {
    const wheelOffset = LMU_TELEMETRY.wheels + index * LMU_WHEEL_SIZE;
    const wheelSpeed = continuousValue(
      loaded,
      "Wheel Speed",
      time,
      index,
      speedMps,
    );
    telemetry.writeDoubleLE(
      continuousValue(loaded, "Susp Pos", time, index),
      wheelOffset + LMU_WHEEL.suspensionDeflection,
    );
    telemetry.writeDoubleLE(
      continuousValue(loaded, "Brakes Temp", time, index),
      wheelOffset + LMU_WHEEL.brakeTemperature,
    );
    telemetry.writeDoubleLE(
      wheelSpeed / ESTIMATED_TIRE_RADIUS_M,
      wheelOffset + LMU_WHEEL.rotation,
    );
    telemetry.writeDoubleLE(
      wheelSpeed,
      wheelOffset + LMU_WHEEL.longitudinalPatchVelocity,
    );
    telemetry.writeDoubleLE(
      speedMps,
      wheelOffset + LMU_WHEEL.longitudinalGroundVelocity,
    );
    telemetry.writeDoubleLE(
      continuousValue(loaded, "TyresPressure", time, index),
      wheelOffset + LMU_WHEEL.pressureKpa,
    );
    telemetry.writeDoubleLE(
      continuousValue(loaded, "TyresTempLeft", time, index) + 273.15,
      wheelOffset + LMU_WHEEL.temperature,
    );
    telemetry.writeDoubleLE(
      continuousValue(loaded, "TyresTempCentre", time, index) + 273.15,
      wheelOffset + LMU_WHEEL.temperature + 8,
    );
    telemetry.writeDoubleLE(
      continuousValue(loaded, "TyresTempRight", time, index) + 273.15,
      wheelOffset + LMU_WHEEL.temperature + 16,
    );
    telemetry.writeDoubleLE(
      1 - continuousValue(loaded, "Tyres Wear", time, index, 100) / 100,
      wheelOffset + LMU_WHEEL.wear,
    );
    telemetry.writeDoubleLE(
      continuousValue(loaded, "TyresCarcassTemp", time, index) + 273.15,
      wheelOffset + LMU_WHEEL.tireCarcassTemperature,
    );
  }

  writeCString(
    scoringInfo,
    LMU_SCORING_INFO.trackName,
    64,
    loaded.metadata.trackName,
  );
  scoringInfo.writeInt32LE(
    sessionTypeOrdinal(loaded.metadata.sessionType),
    LMU_SCORING_INFO.session,
  );
  scoringInfo.writeDoubleLE(time, LMU_SCORING_INFO.currentElapsedTime);
  scoringInfo.writeDoubleLE(
    loaded.startTime + loaded.duration,
    LMU_SCORING_INFO.endElapsedTime,
  );
  scoringInfo.writeDoubleLE(loaded.trackLengthM, LMU_SCORING_INFO.lapDistance);
  scoringInfo.writeInt32LE(1, LMU_SCORING_INFO.numberOfVehicles);
  scoringInfo.writeUInt8(5, LMU_SCORING_INFO.gamePhase);
  scoringInfo.writeUInt8(1, LMU_SCORING_INFO.inRealtime);
  writeCString(
    scoringInfo,
    LMU_SCORING_INFO.playerName,
    32,
    loaded.metadata.driverName,
  );
  scoringInfo.writeDoubleLE(
    continuousValue(loaded, "Ambient Temperature", time),
    LMU_SCORING_INFO.ambientTemperature,
  );
  scoringInfo.writeDoubleLE(
    continuousValue(loaded, "Track Temperature", time),
    LMU_SCORING_INFO.trackTemperature,
  );

  scoring.writeInt32LE(1, LMU_SCORING_VEHICLE.id);
  writeCString(
    scoring,
    LMU_SCORING_VEHICLE.driverName,
    32,
    loaded.metadata.driverName,
  );
  writeCString(
    scoring,
    LMU_SCORING_VEHICLE.vehicleName,
    64,
    loaded.metadata.carName,
  );
  scoring.writeInt16LE(lapNumber, LMU_SCORING_VEHICLE.totalLaps);
  scoring.writeUInt8(
    eventValue(loaded, "Current Sector", time),
    LMU_SCORING_VEHICLE.sector,
  );
  scoring.writeDoubleLE(
    continuousValue(loaded, "Lap Dist", time),
    LMU_SCORING_VEHICLE.lapDistance,
  );
  scoring.writeDoubleLE(
    eventValue(loaded, "Best LapTime", time),
    LMU_SCORING_VEHICLE.bestLapTime,
  );
  scoring.writeDoubleLE(
    eventValue(loaded, "Lap Time", time),
    LMU_SCORING_VEHICLE.lastLapTime,
  );
  scoring.writeUInt8(1, LMU_SCORING_VEHICLE.isPlayer);
  scoring.writeUInt8(
    eventValue(loaded, "In Pits", time),
    LMU_SCORING_VEHICLE.inPits,
  );
  writeCString(
    scoring,
    LMU_SCORING_VEHICLE.vehicleClass,
    32,
    loaded.metadata.carClass,
  );
  scoring.writeDoubleLE(lapStartTime, LMU_SCORING_VEHICLE.lapStartElapsedTime);

  return encodeLMUSourcePayload({
    gameVersion: loaded.metadata.version,
    sessionEvent: sessionEventId(loaded.metadata.recordingTime),
    captureTimestampMs: epochMs + (time - loaded.startTime) * 1_000,
    telemetry,
    scoringInfo,
    playerScoring: scoring,
  });
}

export function isDuckDBFile(bytes: Buffer): boolean {
  return (
    bytes.length >= DUCKDB_SIGNATURE_OFFSET + DUCKDB_SIGNATURE.length &&
    bytes
      .subarray(
        DUCKDB_SIGNATURE_OFFSET,
        DUCKDB_SIGNATURE_OFFSET + DUCKDB_SIGNATURE.length,
      )
      .equals(DUCKDB_SIGNATURE)
  );
}

export async function previewLMUDuckDB(path: string): Promise<LMUDuckDBPreview> {
  const instance = await DuckDBInstance.create(path, {
    access_mode: "READ_ONLY",
    threads: "1",
    memory_limit: "256MB",
  });
  const connection = await instance.connect();
  try {
    const metadata = await readMetadata(connection);
    const { tableNames, frequencies } = await readSchemaIndex(connection);
    let duration = 0;
    for (const name of Object.keys(CONTINUOUS_CHANNELS)) {
      const frequency = frequencies.get(name);
      if (!frequency || !tableNames.has(name)) continue;
      const rows = await queryObjects(
        connection,
        `SELECT count(*) AS sampleCount FROM ${quotedIdentifier(name)}`,
      );
      const sampleCount = numberValue(rows[0]?.sampleCount);
      duration = Math.max(
        duration,
        Math.max(0, sampleCount - 1) / frequency,
      );
    }
    const lapRows = tableNames.has("Lap")
      ? await queryObjects(connection, 'SELECT count(*) AS eventCount FROM "Lap"')
      : [];
    const lapEventCount = numberValue(lapRows[0]?.eventCount);
    if (duration <= 0 || lapEventCount === 0) {
      throw new Error("LMU telemetry recording contains no drivable samples");
    }
    return {
      gameId: "lmu",
      ...metadata,
      estimatedPacketCount: Math.floor(duration * IMPORT_FRAME_RATE),
      completedLapCount: Math.max(0, lapEventCount - 1),
    };
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

export async function* readLMUDuckDBFrames(path: string): AsyncGenerator<Buffer> {
  const loaded = await loadLMUDuckDB(path);
  const epochMs = recordingEpochMs(loaded.metadata.recordingTime);
  const packetCount = Math.floor(loaded.duration * IMPORT_FRAME_RATE);
  for (let index = 0; index < packetCount; index++) {
    const time = loaded.startTime + index / IMPORT_FRAME_RATE;
    yield buildSyntheticFrame(loaded, time, epochMs);
  }
}

export async function importLMUDuckDB(
  path: string,
  ownership: SessionOwnership,
): Promise<{
  packetCount: number;
  laps: ImportedLap[];
}> {
  const loaded = await loadLMUDuckDB(path);
  const identity = identityFromMetadata(loaded.metadata);
  await registerImportedLMUIdentity(identity);
  const epochMs = recordingEpochMs(loaded.metadata.recordingTime);
  const packetCount = Math.floor(loaded.duration * IMPORT_FRAME_RATE);
  async function* frames(): AsyncGenerator<Buffer> {
    for (let index = 0; index < packetCount; index++) {
      const time = loaded.startTime + index / IMPORT_FRAME_RATE;
      yield buildSyntheticFrame(loaded, time, epochMs);
    }
  }
  const result = await importSessionFrames(frames(), "lmu", {
    requireLaps: true,
    ownership,
  });
  return { packetCount: result.packetCount, laps: result.laps };
}
