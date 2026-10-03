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
