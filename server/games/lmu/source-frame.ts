import {
  LMU_GAME_VERSION_OFFSET,
  LMU_MAX_VEHICLES,
  LMU_SCORING_INFO,
  LMU_SCORING_INFO_OFFSET,
  LMU_SCORING_INFO_SIZE,
  LMU_SCORING_VEHICLE,
  LMU_SCORING_VEHICLE_SIZE,
  LMU_SCORING_VEHICLES_OFFSET,
  LMU_SESSION_EVENT_OFFSET,
  LMU_SHARED_MEMORY_SIZE,
  LMU_TELEMETRY,
  LMU_TELEMETRY_HEADER_OFFSET,
  LMU_TELEMETRY_INFO_OFFSET,
  LMU_TELEMETRY_INFO_SIZE,
} from "./layout";

export const LMU_SOURCE_FRAME_MAGIC = Buffer.from("RQLMUSF\0", "ascii");
export const LMU_SOURCE_SCHEMA_VERSION = 1;
export const LMU_SOURCE_FRAME_HEADER_SIZE = 28;
export const LMU_SOURCE_FRAME_SIZE =
  LMU_SOURCE_FRAME_HEADER_SIZE +
  LMU_TELEMETRY_INFO_SIZE +
  LMU_SCORING_INFO_SIZE +
  LMU_SCORING_VEHICLE_SIZE;
export const LMU_MAX_SOURCE_FRAME_SIZE = LMU_SOURCE_FRAME_SIZE;

const FLAG_HAS_SCORING = 1;
const TELEMETRY_PAYLOAD_OFFSET = LMU_SOURCE_FRAME_HEADER_SIZE;
const SCORING_INFO_PAYLOAD_OFFSET =
  TELEMETRY_PAYLOAD_OFFSET + LMU_TELEMETRY_INFO_SIZE;
const SCORING_VEHICLE_PAYLOAD_OFFSET =
  SCORING_INFO_PAYLOAD_OFFSET + LMU_SCORING_INFO_SIZE;

export interface LMUSourceFrameV1 {
  schemaVersion: 1;
  gameVersion: number;
  sessionEvent: number;
  captureTimestampMs: number;
  telemetry: Buffer;
  scoringInfo: Buffer;
  playerScoring: Buffer | null;
}

export interface LMUSourcePayload {
  gameVersion: number;
  sessionEvent: number;
  captureTimestampMs: number;
  telemetry: Buffer;
  scoringInfo: Buffer;
  playerScoring?: Buffer | null;
}

export function encodeLMUSourcePayload(payload: LMUSourcePayload): Buffer {
  if (
    payload.telemetry.length !== LMU_TELEMETRY_INFO_SIZE ||
    payload.scoringInfo.length !== LMU_SCORING_INFO_SIZE ||
    (payload.playerScoring &&
      payload.playerScoring.length !== LMU_SCORING_VEHICLE_SIZE)
  ) {
    throw new Error("LMU source payload uses incompatible structure sizes");
  }
  const frame = Buffer.alloc(LMU_SOURCE_FRAME_SIZE);
  LMU_SOURCE_FRAME_MAGIC.copy(frame, 0);
  frame.writeUInt16LE(LMU_SOURCE_SCHEMA_VERSION, 8);
  frame.writeUInt16LE(payload.playerScoring ? FLAG_HAS_SCORING : 0, 10);
  frame.writeInt32LE(payload.gameVersion, 12);
  frame.writeUInt32LE(payload.sessionEvent, 16);
  frame.writeDoubleLE(payload.captureTimestampMs, 20);
  payload.telemetry.copy(frame, TELEMETRY_PAYLOAD_OFFSET);
  payload.scoringInfo.copy(frame, SCORING_INFO_PAYLOAD_OFFSET);
  payload.playerScoring?.copy(frame, SCORING_VEHICLE_PAYLOAD_OFFSET);
  return frame;
}

function validVehicleCount(value: number): number {
  return Number.isInteger(value) && value >= 0 && value <= LMU_MAX_VEHICLES
    ? value
    : 0;
}

function findPlayerScoringOffset(
  sharedMemory: Buffer,
  telemetryVehicleId: number,
): number | null {
  const vehicleCount = validVehicleCount(
    sharedMemory.readInt32LE(
      LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.numberOfVehicles,
    ),
  );
  let playerFlagOffset: number | null = null;
  for (let index = 0; index < vehicleCount; index++) {
    const offset =
      LMU_SCORING_VEHICLES_OFFSET + index * LMU_SCORING_VEHICLE_SIZE;
    if (sharedMemory.readInt32LE(offset + LMU_SCORING_VEHICLE.id) === telemetryVehicleId) {
      return offset;
    }
    if (sharedMemory.readUInt8(offset + LMU_SCORING_VEHICLE.isPlayer) !== 0) {
      playerFlagOffset = offset;
    }
  }
  return playerFlagOffset;
}

/**
 * Convert one lock-consistent LMU_Data snapshot into RaceIQ's compact,
 * replayable source frame. Opponent arrays and the 64 KiB steward stream stay
 * outside player telemetry recordings.
 */
export function encodeLMUSourceFrame(
  sharedMemory: Buffer,
  captureTimestampMs = Date.now(),
): Buffer | null {
  if (sharedMemory.length < LMU_SHARED_MEMORY_SIZE) return null;

  const activeVehicles = validVehicleCount(
    sharedMemory.readUInt8(LMU_TELEMETRY_HEADER_OFFSET),
  );
  const playerVehicleIndex = sharedMemory.readUInt8(
    LMU_TELEMETRY_HEADER_OFFSET + 1,
  );
  const playerHasVehicle =
    sharedMemory.readUInt8(LMU_TELEMETRY_HEADER_OFFSET + 2) !== 0;
  if (
    !playerHasVehicle ||
    activeVehicles === 0 ||
    playerVehicleIndex >= activeVehicles
  ) {
    return null;
  }

  const telemetryOffset =
    LMU_TELEMETRY_INFO_OFFSET +
    playerVehicleIndex * LMU_TELEMETRY_INFO_SIZE;
  const telemetryVehicleId = sharedMemory.readInt32LE(
    telemetryOffset + LMU_TELEMETRY.id,
  );
  const playerScoringOffset = findPlayerScoringOffset(
    sharedMemory,
    telemetryVehicleId,
  );

  return encodeLMUSourcePayload({
    gameVersion: sharedMemory.readInt32LE(LMU_GAME_VERSION_OFFSET),
    sessionEvent: sharedMemory.readUInt32LE(LMU_SESSION_EVENT_OFFSET),
    captureTimestampMs,
    telemetry: sharedMemory.subarray(
      telemetryOffset,
      telemetryOffset + LMU_TELEMETRY_INFO_SIZE,
    ),
    scoringInfo: sharedMemory.subarray(
      LMU_SCORING_INFO_OFFSET,
      LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO_SIZE,
    ),
    playerScoring:
      playerScoringOffset === null
        ? null
        : sharedMemory.subarray(
            playerScoringOffset,
            playerScoringOffset + LMU_SCORING_VEHICLE_SIZE,
          ),
  });
}

export function canHandleLMUSourceFrame(buffer: Buffer): boolean {
  return (
    buffer.length === LMU_SOURCE_FRAME_SIZE &&
    buffer.subarray(0, LMU_SOURCE_FRAME_MAGIC.length).equals(
      LMU_SOURCE_FRAME_MAGIC,
    ) &&
    buffer.readUInt16LE(8) === LMU_SOURCE_SCHEMA_VERSION
  );
}

export function decodeLMUSourceFrame(
  buffer: Buffer,
): LMUSourceFrameV1 | null {
  if (!canHandleLMUSourceFrame(buffer)) return null;
  const captureTimestampMs = buffer.readDoubleLE(20);
  if (!Number.isFinite(captureTimestampMs) || captureTimestampMs < 0) return null;
  const flags = buffer.readUInt16LE(10);
  return {
    schemaVersion: 1,
    gameVersion: buffer.readInt32LE(12),
    sessionEvent: buffer.readUInt32LE(16),
    captureTimestampMs,
    telemetry: buffer.subarray(
      TELEMETRY_PAYLOAD_OFFSET,
      SCORING_INFO_PAYLOAD_OFFSET,
    ),
    scoringInfo: buffer.subarray(
      SCORING_INFO_PAYLOAD_OFFSET,
      SCORING_VEHICLE_PAYLOAD_OFFSET,
    ),
    playerScoring:
      flags & FLAG_HAS_SCORING
        ? buffer.subarray(SCORING_VEHICLE_PAYLOAD_OFFSET)
        : null,
  };
}

export interface LMUIdentity {
  carId: number;
  carName: string;
  trackId: number;
  trackName: string;
}

export function readCString(
  buffer: Buffer,
  offset: number,
  length: number,
): string {
  if (offset < 0 || length <= 0 || offset + length > buffer.length) return "";
  const bytes = buffer.subarray(offset, offset + length);
  const terminator = bytes.indexOf(0);
  return bytes
    .subarray(0, terminator >= 0 ? terminator : length)
    .toString("utf8")
    .trim();
}
