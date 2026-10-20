export interface F1Header {
  packetFormat: number; // u16 — 2025
  gameYear: number; // u8 — last two digits e.g. 25
  gameMajorVersion: number; // u8
  gameMinorVersion: number; // u8
  packetVersion: number; // u8
  packetId: number; // u8 (0-15)
  sessionUID: bigint; // u64
  sessionTime: number; // f32
  frameIdentifier: number; // u32
  overallFrameIdentifier: number; // u32
  playerCarIndex: number; // u8
  secondaryPlayerCarIndex: number; // u8
}

export const F1_HEADER_SIZE = 29;

export const F1_PACKET_IDS = {
  MOTION: 0,
  SESSION: 1,
  LAP_DATA: 2,
  PARTICIPANTS: 4,
  CAR_SETUP: 5,
  CAR_TELEMETRY: 6,
  CAR_STATUS: 7,
  FINAL_CLASSIFICATION: 8,
  CAR_DAMAGE: 10,
  SESSION_HISTORY: 11,
  MOTION_EX: 13,
} as const;

export type F1PacketId = (typeof F1_PACKET_IDS)[keyof typeof F1_PACKET_IDS];

const F1_CAPTURE_MAGIC = Buffer.from("F1CX", "ascii");
const F1_CAPTURE_VERSION = 1;
const F1_CAPTURE_HEADER_BYTES = 9;
const F1_MOTION_EX_PACKET_ID = F1_PACKET_IDS.MOTION_EX;
const F1_OMITTED_BODY_RANGES = [[16, 48], [132, 144], [156, 168]] as const;

export function isF1CaptureFrame(payload: Buffer): boolean {
  return payload.length >= 4 && payload.subarray(0, 4).equals(F1_CAPTURE_MAGIC);
}

/** Compact only the platform-only MOTION_EX body channels. Invalid inputs stay byte-identical. */
export function encodeF1CaptureFrame(frame: Buffer): Buffer {
  if (frame.length < F1_HEADER_SIZE || frame.readUInt16LE(0) !== 2025 ||
      frame.readUInt8(2) !== 25 || frame.readUInt8(5) !== 1 ||
      frame.readUInt8(6) !== F1_MOTION_EX_PACKET_ID) return frame;
  const bodyLength = frame.length - F1_HEADER_SIZE;
  if (bodyLength < 224 || bodyLength > 16 * 1024 * 1024) return frame;
  const compactLength = bodyLength - 56;
  const result = Buffer.allocUnsafe(F1_CAPTURE_HEADER_BYTES + F1_HEADER_SIZE + compactLength);
  F1_CAPTURE_MAGIC.copy(result);
  result[4] = F1_CAPTURE_VERSION;
  result.writeUInt32LE(bodyLength, 5);
  frame.copy(result, F1_CAPTURE_HEADER_BYTES, 0, F1_HEADER_SIZE);
  let source = F1_HEADER_SIZE;
  let target = F1_CAPTURE_HEADER_BYTES + F1_HEADER_SIZE;
  for (const [start, end] of F1_OMITTED_BODY_RANGES) {
    const keep = start - (source - F1_HEADER_SIZE);
    frame.copy(result, target, source, source + keep);
    source += keep + end - start;
    target += keep;
  }
  frame.copy(result, target, source);
  return result;
}
/** Compact without changing native bytes, for lossless splitting/downsampling. */
export function encodeLosslessF1CaptureFrame(frame: Buffer): Buffer {
  if (frame.length < F1_HEADER_SIZE + 224 || frame.readUInt16LE(0) !== 2025 ||
      frame[6] !== F1_MOTION_EX_PACKET_ID) return frame;
  for (const [start, end] of F1_OMITTED_BODY_RANGES) {
    for (let offset = F1_HEADER_SIZE + start; offset < F1_HEADER_SIZE + end; offset++) {
      if (frame[offset] !== 0) return frame;
    }
  }
  return encodeF1CaptureFrame(frame);
}


/** Restore compact capture envelope to native layout; unrecognized bytes stay unchanged. */
export function decodeF1CaptureFrame(payload: Buffer): Buffer {
  if (!isF1CaptureFrame(payload)) return payload;
  if (payload.length < F1_CAPTURE_HEADER_BYTES + F1_HEADER_SIZE || payload[4] !== F1_CAPTURE_VERSION) {
    throw new Error("Invalid F1 capture frame version or header");
  }
  const bodyLength = payload.readUInt32LE(5);
  if (bodyLength < 224 || bodyLength > 16 * 1024 * 1024 ||
      payload.length !== F1_CAPTURE_HEADER_BYTES + F1_HEADER_SIZE + bodyLength - 56 ||
      payload.readUInt16LE(F1_CAPTURE_HEADER_BYTES) !== 2025 ||
      payload[F1_CAPTURE_HEADER_BYTES + 2] !== 25 ||
      payload[F1_CAPTURE_HEADER_BYTES + 5] !== 1 ||
      payload[F1_CAPTURE_HEADER_BYTES + 6] !== F1_MOTION_EX_PACKET_ID) {
    throw new Error("Invalid F1 capture frame length or packet");
  }
  const frame = Buffer.alloc(payload.length - F1_CAPTURE_HEADER_BYTES + 56);
  payload.copy(frame, 0, F1_CAPTURE_HEADER_BYTES, F1_CAPTURE_HEADER_BYTES + F1_HEADER_SIZE);
  let source = F1_CAPTURE_HEADER_BYTES + F1_HEADER_SIZE;
  let nativeBodyOffset = 0;
  for (const [start, end] of F1_OMITTED_BODY_RANGES) {
    const keep = start - nativeBodyOffset;
    payload.copy(frame, F1_HEADER_SIZE + nativeBodyOffset, source, source + keep);
    source += keep;
    nativeBodyOffset = end;
  }
  payload.copy(frame, F1_HEADER_SIZE + nativeBodyOffset, source);
  return frame;
}

export function parseF1Header(buf: Buffer): F1Header {
  return {
    packetFormat: buf.readUInt16LE(0),
    gameYear: buf.readUInt8(2),
    gameMajorVersion: buf.readUInt8(3),
    gameMinorVersion: buf.readUInt8(4),
    packetVersion: buf.readUInt8(5),
    packetId: buf.readUInt8(6),
    sessionUID: buf.readBigUInt64LE(7),
    sessionTime: buf.readFloatLE(15),
    frameIdentifier: buf.readUInt32LE(19),
    overallFrameIdentifier: buf.readUInt32LE(23),
    playerCarIndex: buf.readUInt8(27),
    secondaryPlayerCarIndex: buf.readUInt8(28),
  };
}

export const F1_SESSION_TYPES: Record<number, string> = {
  0: "unknown",
  1: "practice-1",
  2: "practice-2",
  3: "practice-3",
  4: "short-practice",
  5: "qualifying-1",
  6: "qualifying-2",
  7: "qualifying-3",
  8: "short-qualifying",
  9: "one-shot-qualifying",
  10: "race",
  11: "race-2",
  12: "race-3",
  13: "time-trial",
};
