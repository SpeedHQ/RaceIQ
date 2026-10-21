import {
  LMU_GAME_VERSION_OFFSET, LMU_MAX_VEHICLES, LMU_SCORING_INFO, LMU_SCORING_INFO_OFFSET,
  LMU_SCORING_INFO_SIZE, LMU_SCORING_VEHICLE, LMU_SCORING_VEHICLE_SIZE, LMU_SCORING_VEHICLES_OFFSET,
  LMU_SESSION_EVENT_OFFSET, LMU_SHARED_MEMORY_SIZE, LMU_TELEMETRY, LMU_TELEMETRY_HEADER_OFFSET,
  LMU_TELEMETRY_INFO_OFFSET, LMU_TELEMETRY_INFO_SIZE,
} from "./layout";
import type { LmuLiveContext } from "@raceiq/shared/telemetry/lmu";
import { decodeLmuContext, encodeLmuContext } from "@raceiq/shared/telemetry/lmu-context";

export const LMU_SOURCE_FRAME_MAGIC = Buffer.from("RQLMUSF\0", "ascii");
export const LMU_SOURCE_SCHEMA_VERSION_V2 = 2;
export const LMU_SOURCE_SCHEMA_VERSION = 3;
export const LMU_SOURCE_SCHEMA_VERSION_SYNTHETIC = 4;
export const LMU_SOURCE_FRAME_HEADER_SIZE = 28;
export const LMU_SOURCE_FRAME_SIZE = LMU_SOURCE_FRAME_HEADER_SIZE + LMU_TELEMETRY_INFO_SIZE + LMU_SCORING_INFO_SIZE + LMU_SCORING_VEHICLE_SIZE;
export const LMU_SOURCE_FRAME_V2_SIZE = LMU_SOURCE_FRAME_HEADER_SIZE + LMU_SHARED_MEMORY_SIZE;
export const LMU_MAX_SOURCE_FRAME_SIZE = 16 * 1024 * 1024;
const FLAG_HAS_SCORING = 1;
const CONTEXT_LENGTH_SIZE = 4;
const LMU_SYNTHETIC_METADATA_MAX_BYTES = 4_096;
const LMU_SYNTHETIC_FRAME_MAX_SIZE = Math.min(
  LMU_SOURCE_FRAME_SIZE + LMU_SYNTHETIC_METADATA_MAX_BYTES,
  LMU_SOURCE_FRAME_V2_SIZE - 1,
);
const TELEMETRY_PAYLOAD_OFFSET = LMU_SOURCE_FRAME_HEADER_SIZE;
const SCORING_INFO_PAYLOAD_OFFSET = TELEMETRY_PAYLOAD_OFFSET + LMU_TELEMETRY_INFO_SIZE;
const SCORING_VEHICLE_PAYLOAD_OFFSET = SCORING_INFO_PAYLOAD_OFFSET + LMU_SCORING_INFO_SIZE;

export interface LMUSourceFrame {
  schemaVersion: 1 | 2 | 3 | 4;
  gameVersion: number;
  sessionEvent: number;
  captureTimestampMs: number;
  telemetry: Buffer;
  scoringInfo: Buffer;
  playerScoring: Buffer | null;
  rawSharedMemory?: Buffer;
  lmuContext?: LmuLiveContext;
  syntheticChannels?: readonly string[];
}
export interface LMUSourceFrameV2 extends LMUSourceFrame { schemaVersion: 2; rawSharedMemory: Buffer; }
export interface LMUSourceFrameV3 extends LMUSourceFrame { schemaVersion: 3; rawSharedMemory: Buffer; lmuContext: LmuLiveContext; }
export interface LMUSourceFrameV4 extends LMUSourceFrame { schemaVersion: 4; syntheticChannels: readonly string[]; }
export interface LMUSourcePayload {
  gameVersion: number;
  sessionEvent: number;
  captureTimestampMs: number;
  telemetry: Buffer;
  scoringInfo: Buffer;
  playerScoring?: Buffer | null;
}
export function encodeLMUSourcePayload(payload: LMUSourcePayload): Buffer {
  return encodeLMUFramePayload(payload, 1);
}

const SYNTHETIC_CHANNELS = new Set([
  "Brake Pos Unfiltered", "Throttle Pos Unfiltered", "Clutch Pos Unfiltered",
  "Steering Pos Unfiltered", "Engine RPM", "G Force Lat", "G Force Long",
  "G Force Vert", "Ground Speed", "GPS Latitude", "GPS Longitude", "Fuel Level",
  "Lap Dist", "Total Dist", "Tyres Wear", "TyresPressure", "TyresTempLeft",
  "TyresTempCentre", "TyresTempRight", "TyresCarcassTemp", "Brakes Temp",
  "Wheel Speed", "Susp Pos", "TC", "SoC", "Virtual Energy", "Regen Rate",
  "Ambient Temperature", "Track Temperature", "Engine Max RPM", "Gear", "Lap",
  "Lap Time", "Best LapTime", "In Pits", "Current Sector", "Best Sector 1",
  "Best Sector 2", "Last Sector 1", "Last Sector 2", "Current Sector 1",
  "Current Sector 2", "ABSLevel", "RearFlapActivated", "Speed Limiter",
  "TyresCompound",
]);

export function encodeLMUSyntheticSourcePayload(
  payload: LMUSourcePayload,
  syntheticChannels: readonly string[],
): Buffer {
  const channels = [...new Set(syntheticChannels)];
  if (
    channels.length > SYNTHETIC_CHANNELS.size ||
    channels.some((channel) => !SYNTHETIC_CHANNELS.has(channel))
  ) {
    throw new Error("LMU synthetic source payload contains unsupported channels");
  }
  const metadata = Buffer.from(JSON.stringify(channels), "utf8");
  if (metadata.length > LMU_SYNTHETIC_METADATA_MAX_BYTES) {
    throw new Error("LMU synthetic source payload metadata exceeds size limit");
  }
  return encodeLMUFramePayload(payload, 4, metadata);
}

function encodeLMUFramePayload(
  payload: LMUSourcePayload,
  version: 1 | 4,
  metadata?: Buffer,
): Buffer {
  if (payload.telemetry.length !== LMU_TELEMETRY_INFO_SIZE || payload.scoringInfo.length !== LMU_SCORING_INFO_SIZE || (payload.playerScoring && payload.playerScoring.length !== LMU_SCORING_VEHICLE_SIZE)) throw new Error("LMU source payload uses incompatible structure sizes");
  const frame = Buffer.alloc(LMU_SOURCE_FRAME_SIZE + (metadata?.length ?? 0));
  LMU_SOURCE_FRAME_MAGIC.copy(frame);
  frame.writeUInt16LE(version, 8);
  frame.writeUInt16LE(payload.playerScoring ? FLAG_HAS_SCORING : 0, 10);
  frame.writeInt32LE(payload.gameVersion, 12);
  frame.writeUInt32LE(payload.sessionEvent, 16);
  frame.writeDoubleLE(payload.captureTimestampMs, 20);
  payload.telemetry.copy(frame, TELEMETRY_PAYLOAD_OFFSET);
  payload.scoringInfo.copy(frame, SCORING_INFO_PAYLOAD_OFFSET);
  payload.playerScoring?.copy(frame, SCORING_VEHICLE_PAYLOAD_OFFSET);
  metadata?.copy(frame, LMU_SOURCE_FRAME_SIZE);
  return frame;
}

function findPlayerScoringOffset(memory: Buffer, telemetryId: number): number | null {
  const telemetryCount = memory.readUInt8(LMU_TELEMETRY_HEADER_OFFSET);
  let telemetryMatches = 0;
  for (let index = 0; index < telemetryCount; index++) {
    if (memory.readInt32LE(LMU_TELEMETRY_INFO_OFFSET + index * LMU_TELEMETRY_INFO_SIZE + LMU_TELEMETRY.id) === telemetryId) telemetryMatches++;
  }
  if (telemetryMatches !== 1) return null;
  const count = memory.readInt32LE(LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.numberOfVehicles);
  if (count < 0 || count > LMU_MAX_VEHICLES) return null;
  let player: number | null = null;
  let idMatches = 0;
  for (let index = 0; index < count; index++) {
    const offset = LMU_SCORING_VEHICLES_OFFSET + index * LMU_SCORING_VEHICLE_SIZE;
    if (memory.readInt32LE(offset + LMU_SCORING_VEHICLE.id) === telemetryId) idMatches++;
    if (memory.readUInt8(offset + LMU_SCORING_VEHICLE.isPlayer) === 0) continue;
    if (player !== null) return null;
    player = offset;
  }
  return player !== null && idMatches === 1 && memory.readInt32LE(player + LMU_SCORING_VEHICLE.id) === telemetryId ? player : null;
}

export function encodeLMUSourceFrame(memory: Buffer, captureTimestampMs: number, options: { context?: LmuLiveContext } = {}): Buffer | null {
  if (memory.length < LMU_SHARED_MEMORY_SIZE || !Number.isFinite(captureTimestampMs) || captureTimestampMs < 0) return null;
  const count = memory.readUInt8(LMU_TELEMETRY_HEADER_OFFSET);
  const slot = memory.readUInt8(LMU_TELEMETRY_HEADER_OFFSET + 1);
  if (!memory.readUInt8(LMU_TELEMETRY_HEADER_OFFSET + 2) || count < 1 || count > LMU_MAX_VEHICLES || slot >= count) return null;
  const telemetryId = memory.readInt32LE(LMU_TELEMETRY_INFO_OFFSET + slot * LMU_TELEMETRY_INFO_SIZE + LMU_TELEMETRY.id);
  const player = findPlayerScoringOffset(memory, telemetryId);
  const context = options.context;
  if (context && (context.playerVehicleId !== telemetryId || player === null)) return null;
  const metadata = context ? Buffer.from(JSON.stringify(encodeLmuContext(context)), "utf8") : undefined;
  const size = LMU_SOURCE_FRAME_V2_SIZE + (metadata ? CONTEXT_LENGTH_SIZE + metadata.length : 0);
  if (size > LMU_MAX_SOURCE_FRAME_SIZE) throw new RangeError("LMU context exceeds capture frame limit");
  const frame = Buffer.allocUnsafe(size);
  LMU_SOURCE_FRAME_MAGIC.copy(frame);
  frame.writeUInt16LE(context ? LMU_SOURCE_SCHEMA_VERSION : LMU_SOURCE_SCHEMA_VERSION_V2, 8);
  frame.writeUInt16LE(player === null ? 0 : FLAG_HAS_SCORING, 10);
  frame.writeInt32LE(memory.readInt32LE(LMU_GAME_VERSION_OFFSET), 12);
  frame.writeUInt32LE(memory.readUInt32LE(LMU_SESSION_EVENT_OFFSET), 16);
  frame.writeDoubleLE(captureTimestampMs, 20);
  memory.copy(frame, LMU_SOURCE_FRAME_HEADER_SIZE, 0, LMU_SHARED_MEMORY_SIZE);
  if (metadata) {
    frame.writeUInt32LE(metadata.length, LMU_SOURCE_FRAME_V2_SIZE);
    metadata.copy(frame, LMU_SOURCE_FRAME_V2_SIZE + CONTEXT_LENGTH_SIZE);
  }
  return frame;
}

export function canHandleLMUSourceFrame(buffer: Buffer): boolean {
  if (buffer.length < LMU_SOURCE_FRAME_HEADER_SIZE || buffer.length > LMU_MAX_SOURCE_FRAME_SIZE || !buffer.subarray(0, LMU_SOURCE_FRAME_MAGIC.length).equals(LMU_SOURCE_FRAME_MAGIC)) return false;
  const version = buffer.readUInt16LE(8);
  if (version === 1) return buffer.length === LMU_SOURCE_FRAME_SIZE;
  if (version === 2) return buffer.length === LMU_SOURCE_FRAME_V2_SIZE;
  if (version === 4) {
    return buffer.length > LMU_SOURCE_FRAME_SIZE &&
      buffer.length <= LMU_SYNTHETIC_FRAME_MAX_SIZE;
  }
  return version === 3 && buffer.length >= LMU_SOURCE_FRAME_V2_SIZE + CONTEXT_LENGTH_SIZE && buffer.readUInt32LE(LMU_SOURCE_FRAME_V2_SIZE) === buffer.length - LMU_SOURCE_FRAME_V2_SIZE - CONTEXT_LENGTH_SIZE;
}

export function decodeLMUSourceFrame(buffer: Buffer): LMUSourceFrame | LMUSourceFrameV2 | LMUSourceFrameV3 | LMUSourceFrameV4 | null {
  if (!canHandleLMUSourceFrame(buffer)) return null;
  const captureTimestampMs = buffer.readDoubleLE(20);
  if (!Number.isFinite(captureTimestampMs) || captureTimestampMs < 0) return null;
  const schemaVersion = buffer.readUInt16LE(8) as 1 | 2 | 3 | 4;
  const rawSharedMemory = schemaVersion === 2 || schemaVersion === 3 ? buffer.subarray(LMU_SOURCE_FRAME_HEADER_SIZE, LMU_SOURCE_FRAME_V2_SIZE) : undefined;
  let lmuContext: LmuLiveContext | null = null;
  let syntheticChannels: readonly string[] | undefined;
  if (schemaVersion === 3) {
    try { lmuContext = decodeLmuContext(JSON.parse(buffer.subarray(LMU_SOURCE_FRAME_V2_SIZE + CONTEXT_LENGTH_SIZE).toString("utf8"))); }
    catch { return null; }
    if (!lmuContext) return null;
  } else if (schemaVersion === 4) {
    try {
      const parsed: unknown = JSON.parse(buffer.subarray(LMU_SOURCE_FRAME_SIZE).toString("utf8"));
      if (!Array.isArray(parsed) || parsed.length > SYNTHETIC_CHANNELS.size) return null;
      const seen = new Set<string>();
      const channels: string[] = [];
      for (const channel of parsed) {
        if (
          typeof channel !== "string" ||
          !SYNTHETIC_CHANNELS.has(channel) ||
          seen.has(channel)
        ) return null;
        seen.add(channel);
        channels.push(channel);
      }
      syntheticChannels = channels;
    } catch { return null; }
  }
  let telemetryOffset = TELEMETRY_PAYLOAD_OFFSET;
  if (rawSharedMemory) {
    const count = rawSharedMemory.readUInt8(LMU_TELEMETRY_HEADER_OFFSET);
    const slot = rawSharedMemory.readUInt8(LMU_TELEMETRY_HEADER_OFFSET + 1);
    if (count < 1 || count > LMU_MAX_VEHICLES || slot >= count || !rawSharedMemory.readUInt8(LMU_TELEMETRY_HEADER_OFFSET + 2)) return null;
    telemetryOffset = LMU_TELEMETRY_INFO_OFFSET + slot * LMU_TELEMETRY_INFO_SIZE;
  }
  const native = rawSharedMemory ?? buffer;
  const telemetry = native.subarray(telemetryOffset, telemetryOffset + LMU_TELEMETRY_INFO_SIZE);
  const playerOffset = rawSharedMemory ? findPlayerScoringOffset(rawSharedMemory, telemetry.readInt32LE(LMU_TELEMETRY.id)) : null;
  if (lmuContext && (playerOffset === null || lmuContext.playerVehicleId !== telemetry.readInt32LE(LMU_TELEMETRY.id))) return null;
  return {
    schemaVersion, gameVersion: buffer.readInt32LE(12), sessionEvent: buffer.readUInt32LE(16), captureTimestampMs, telemetry,
    scoringInfo: rawSharedMemory ? rawSharedMemory.subarray(LMU_SCORING_INFO_OFFSET, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO_SIZE) : buffer.subarray(SCORING_INFO_PAYLOAD_OFFSET, SCORING_VEHICLE_PAYLOAD_OFFSET),
    playerScoring: rawSharedMemory ? playerOffset === null ? null : rawSharedMemory.subarray(playerOffset, playerOffset + LMU_SCORING_VEHICLE_SIZE) : buffer.readUInt16LE(10) & FLAG_HAS_SCORING ? buffer.subarray(SCORING_VEHICLE_PAYLOAD_OFFSET, SCORING_VEHICLE_PAYLOAD_OFFSET + LMU_SCORING_VEHICLE_SIZE) : null,
    ...(rawSharedMemory ? { rawSharedMemory } : {}), ...(lmuContext ? { lmuContext } : {}), ...(syntheticChannels ? { syntheticChannels } : {}),
  };
}

export interface LMUIdentity { carId: string; carName: string; carModel: string; trackId: string; trackName: string; }
export function readCString(buffer: Buffer, offset: number, length: number): string {
  if (offset < 0 || length <= 0 || offset + length > buffer.length) return "";
  const bytes = buffer.subarray(offset, offset + length);
  const terminator = bytes.indexOf(0);
  return bytes.subarray(0, terminator >= 0 ? terminator : length).toString("utf8").trim();
}
