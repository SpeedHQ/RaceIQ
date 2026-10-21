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

/** Packet kinds consumed by the telemetry accumulator, not the transport allowlist. */
export const F1_PACKET_IDS = {
  MOTION: 0,
  SESSION: 1,
  LAP_DATA: 2,
  EVENT: 3,
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

/** All native packet kinds in EA's F1 25 UDP specification, including opaque ancillary data. */
export const F1_NATIVE_PACKET_IDS = {
  ...F1_PACKET_IDS,
  EVENT: 3,
  LOBBY_INFO: 9,
  TYRE_SETS: 12,
  TIME_TRIAL: 14,
  LAP_POSITIONS: 15,
} as const;

// EA, Data Output from F1 25 v3: packed version-1 sizes, including the 29-byte header.
const F1_NATIVE_PACKET_SIZES: Readonly<Record<number, number>> = {
  [F1_NATIVE_PACKET_IDS.MOTION]: 1349,
  [F1_NATIVE_PACKET_IDS.SESSION]: 753,
  [F1_NATIVE_PACKET_IDS.LAP_DATA]: 1285,
  [F1_NATIVE_PACKET_IDS.EVENT]: 45,
  [F1_NATIVE_PACKET_IDS.PARTICIPANTS]: 1284,
  [F1_NATIVE_PACKET_IDS.CAR_SETUP]: 1133,
  [F1_NATIVE_PACKET_IDS.CAR_TELEMETRY]: 1352,
  [F1_NATIVE_PACKET_IDS.CAR_STATUS]: 1239,
  [F1_NATIVE_PACKET_IDS.FINAL_CLASSIFICATION]: 1042,
  [F1_NATIVE_PACKET_IDS.LOBBY_INFO]: 954,
  [F1_NATIVE_PACKET_IDS.CAR_DAMAGE]: 1041,
  [F1_NATIVE_PACKET_IDS.SESSION_HISTORY]: 1460,
  [F1_NATIVE_PACKET_IDS.TYRE_SETS]: 231,
  [F1_NATIVE_PACKET_IDS.MOTION_EX]: 273,
  [F1_NATIVE_PACKET_IDS.TIME_TRIAL]: 101,
  [F1_NATIVE_PACKET_IDS.LAP_POSITIONS]: 1131,
};

const F1_EVENT_CODES: ReadonlySet<number> = new Set([
  "SSTA", "SEND", "FTLP", "RTMT", "DRSE", "DRSD",
  "TMPT", "CHQF", "RCWN", "PENA", "SPTP", "STLG",
  "LGOT", "DTSV", "SGSV", "FLBK", "BUTN", "RDFL",
  "OVTK", "SCAR", "COLL",
].map(code => code.charCodeAt(0) * 0x1000000 + code.charCodeAt(1) * 0x10000 + code.charCodeAt(2) * 0x100 + code.charCodeAt(3)));

/** Validate native transport layout without decoding or changing ancillary packet bytes. */
export function isF1NativePacket(buf: Buffer): boolean {
  if (buf.length < F1_HEADER_SIZE || buf.readUInt16LE(0) !== 2025 ||
      buf[2] !== 25 || buf[5] !== 1 || buf[27]! >= 22 ||
      (buf[28] !== 255 && buf[28]! >= 22)) return false;
  const sessionTime = buf.readFloatLE(15);
  if (!Number.isFinite(sessionTime) || sessionTime < 0) return false;
  const packetId = buf[6]!;
  if (buf.length !== F1_NATIVE_PACKET_SIZES[packetId]) return false;
  switch (packetId) {
    case F1_NATIVE_PACKET_IDS.EVENT:
      return F1_EVENT_CODES.has(buf.readUInt32BE(F1_HEADER_SIZE));
    case F1_NATIVE_PACKET_IDS.PARTICIPANTS:
    case F1_NATIVE_PACKET_IDS.FINAL_CLASSIFICATION:
    case F1_NATIVE_PACKET_IDS.LOBBY_INFO:
      return buf[F1_HEADER_SIZE]! <= 22;
    case F1_NATIVE_PACKET_IDS.SESSION_HISTORY:
      return buf[F1_HEADER_SIZE]! < 22 && buf[F1_HEADER_SIZE + 1]! <= 100 &&
        buf[F1_HEADER_SIZE + 2]! <= 8;
    case F1_NATIVE_PACKET_IDS.TYRE_SETS:
      return buf[F1_HEADER_SIZE]! < 22;
    case F1_NATIVE_PACKET_IDS.LAP_POSITIONS:
      return buf[F1_HEADER_SIZE]! <= 50;
    default:
      return true;
  }
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

/** F1 25 UDP v3, "Session types": docs/reference/external/f1-25/f1-25-udp-specification-v3.pdf. */
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
  10: "sprint-shootout-1",
  11: "sprint-shootout-2",
  12: "sprint-shootout-3",
  13: "short-sprint-shootout",
  14: "one-shot-sprint-shootout",
  15: "race",
  16: "race-2",
  17: "race-3",
  18: "time-trial",
};
