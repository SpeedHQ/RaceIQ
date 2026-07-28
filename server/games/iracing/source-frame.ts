export const IRACING_SOURCE_MAGIC = 0x51495249; // "IRIQ" in little-endian bytes
export const IRACING_SOURCE_SCHEMA_VERSION = 1;

const HEADER_SIZE = 12;
const MAX_PAYLOAD_SIZE = 256 * 1024;

export type IRacingValue = number | boolean | string | Array<number | boolean>;

export interface IRacingSessionSnapshot {
  sessionId: number;
  subSessionId: number;
  sessionNum: number;
  driverCarIdx: number;
  trackId: number;
  trackName: string;
  trackLengthM: number;
  /** Native sector start fractions, including sector 1 at 0. */
  sectorStarts?: number[];
  carId: number;
  carName: string;
  carClassId: number;
  carClassName: string;
  engineIdleRpm: number;
  engineRedlineRpm: number;
  engineCylinderCount: number;
}

/**
 * RaceIQ's replayable iRacing source frame. Session metadata is repeated on
 * every frame deliberately: a saved lap can be decoded without replaying an
 * earlier session-info update first.
 */
export interface IRacingSourceFrameV1 {
  schemaVersion: 1;
  session: IRacingSessionSnapshot;
  values: Record<string, IRacingValue>;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSessionSnapshot(value: unknown): value is IRacingSessionSnapshot {
  if (!value || typeof value !== "object") return false;
  const session = value as Record<string, unknown>;
  return (
    isFiniteNumber(session.sessionId) &&
    isFiniteNumber(session.subSessionId) &&
    isFiniteNumber(session.sessionNum) &&
    isFiniteNumber(session.driverCarIdx) &&
    isFiniteNumber(session.trackId) &&
    typeof session.trackName === "string" &&
    isFiniteNumber(session.trackLengthM) &&
    (session.sectorStarts === undefined ||
      (Array.isArray(session.sectorStarts) &&
        session.sectorStarts.every(isFiniteNumber))) &&
    isFiniteNumber(session.carId) &&
    typeof session.carName === "string" &&
    isFiniteNumber(session.carClassId) &&
    typeof session.carClassName === "string" &&
    isFiniteNumber(session.engineIdleRpm) &&
    isFiniteNumber(session.engineRedlineRpm) &&
    isFiniteNumber(session.engineCylinderCount)
  );
}

function isIRacingValue(value: unknown): value is IRacingValue {
  if (
    typeof value === "boolean" ||
    typeof value === "string" ||
    isFiniteNumber(value)
  ) {
    return true;
  }
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "boolean" || isFiniteNumber(entry))
  );
}

function isSourceFrame(value: unknown): value is IRacingSourceFrameV1 {
  if (!value || typeof value !== "object") return false;
  const frame = value as Record<string, unknown>;
  if (frame.schemaVersion !== IRACING_SOURCE_SCHEMA_VERSION) return false;
  if (!isSessionSnapshot(frame.session)) return false;
  if (!frame.values || typeof frame.values !== "object" || Array.isArray(frame.values)) {
    return false;
  }
  return Object.values(frame.values as Record<string, unknown>).every(isIRacingValue);
}

export function encodeIRacingSourceFrame(frame: IRacingSourceFrameV1): Buffer {
  const payload = Buffer.from(JSON.stringify(frame), "utf8");
  if (payload.length > MAX_PAYLOAD_SIZE) {
    throw new Error(`iRacing source frame is too large (${payload.length} bytes)`);
  }

  const output = Buffer.allocUnsafe(HEADER_SIZE + payload.length);
  output.writeUInt32LE(IRACING_SOURCE_MAGIC, 0);
  output.writeUInt16LE(IRACING_SOURCE_SCHEMA_VERSION, 4);
  output.writeUInt16LE(0, 6);
  output.writeUInt32LE(payload.length, 8);
  payload.copy(output, HEADER_SIZE);
  return output;
}

export function canHandleIRacingSourceFrame(buf: Buffer): boolean {
  return (
    buf.length >= HEADER_SIZE &&
    buf.readUInt32LE(0) === IRACING_SOURCE_MAGIC &&
    buf.readUInt16LE(4) === IRACING_SOURCE_SCHEMA_VERSION
  );
}

export function decodeIRacingSourceFrame(buf: Buffer): IRacingSourceFrameV1 | null {
  if (!canHandleIRacingSourceFrame(buf)) return null;

  const payloadLength = buf.readUInt32LE(8);
  if (
    payloadLength === 0 ||
    payloadLength > MAX_PAYLOAD_SIZE ||
    buf.length !== HEADER_SIZE + payloadLength
  ) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(buf.toString("utf8", HEADER_SIZE));
    return isSourceFrame(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
