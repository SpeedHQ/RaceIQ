import type { TelemetryParser } from "@raceiq/shared/telemetry/parser";
import type { LapIndexPacket } from "@raceiq/shared/telemetry/lap-index";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { identifyGT7Track } from "@raceiq/game-gt7-metadata/tracks";

const KEY = Buffer.from("Simulator Interface Packet GT7 ver 0.0", "ascii").subarray(0, 32);
const PACKET_MASKS = new Map([[296, 0xdeadbeaf], [316, 0xdeadbeef], [344, 0x55fabb4f], [368, 0xdeadbeef]]);
const PACKET_MAGIC = 0x47375330;
const G = Buffer.from("expand 32-byte k", "ascii");

function rotl(value: number, bits: number): number {
  return (value << bits) | (value >>> (32 - bits));
}

function salsa20Block(nonce: Buffer, counter: bigint): Buffer {
  const state = new Uint32Array(16);
  state[0] = G.readUInt32LE(0); state[5] = G.readUInt32LE(4);
  state[10] = G.readUInt32LE(8); state[15] = G.readUInt32LE(12);
  state[1] = KEY.readUInt32LE(0); state[2] = KEY.readUInt32LE(4);
  state[3] = KEY.readUInt32LE(8); state[4] = KEY.readUInt32LE(12);
  state[11] = KEY.readUInt32LE(16); state[12] = KEY.readUInt32LE(20);
  state[13] = KEY.readUInt32LE(24); state[14] = KEY.readUInt32LE(28);
  state[6] = nonce.readUInt32LE(0); state[7] = nonce.readUInt32LE(4);
  state[8] = Number(counter & 0xffff_ffffn); state[9] = Number(counter >> 32n);
  const x = new Uint32Array(state);
  for (let i = 0; i < 10; i++) {
    x[4] ^= rotl((x[0] + x[12]) >>> 0, 7); x[8] ^= rotl((x[4] + x[0]) >>> 0, 9);
    x[12] ^= rotl((x[8] + x[4]) >>> 0, 13); x[0] ^= rotl((x[12] + x[8]) >>> 0, 18);
    x[9] ^= rotl((x[5] + x[1]) >>> 0, 7); x[13] ^= rotl((x[9] + x[5]) >>> 0, 9);
    x[1] ^= rotl((x[13] + x[9]) >>> 0, 13); x[5] ^= rotl((x[1] + x[13]) >>> 0, 18);
    x[14] ^= rotl((x[10] + x[6]) >>> 0, 7); x[2] ^= rotl((x[14] + x[10]) >>> 0, 9);
    x[6] ^= rotl((x[2] + x[14]) >>> 0, 13); x[10] ^= rotl((x[6] + x[2]) >>> 0, 18);
    x[3] ^= rotl((x[15] + x[11]) >>> 0, 7); x[7] ^= rotl((x[3] + x[15]) >>> 0, 9);
    x[11] ^= rotl((x[7] + x[3]) >>> 0, 13); x[15] ^= rotl((x[11] + x[7]) >>> 0, 18);
    x[1] ^= rotl((x[0] + x[3]) >>> 0, 7); x[2] ^= rotl((x[1] + x[0]) >>> 0, 9);
    x[3] ^= rotl((x[2] + x[1]) >>> 0, 13); x[0] ^= rotl((x[3] + x[2]) >>> 0, 18);
    x[6] ^= rotl((x[5] + x[4]) >>> 0, 7); x[7] ^= rotl((x[6] + x[5]) >>> 0, 9);
    x[4] ^= rotl((x[7] + x[6]) >>> 0, 13); x[5] ^= rotl((x[4] + x[7]) >>> 0, 18);
    x[11] ^= rotl((x[10] + x[9]) >>> 0, 7); x[8] ^= rotl((x[11] + x[10]) >>> 0, 9);
    x[9] ^= rotl((x[8] + x[11]) >>> 0, 13); x[10] ^= rotl((x[9] + x[8]) >>> 0, 18);
    x[12] ^= rotl((x[15] + x[14]) >>> 0, 7); x[13] ^= rotl((x[12] + x[15]) >>> 0, 9);
    x[14] ^= rotl((x[13] + x[12]) >>> 0, 13); x[15] ^= rotl((x[14] + x[13]) >>> 0, 18);
  }
  const block = Buffer.allocUnsafe(64);
  for (let i = 0; i < 16; i++) block.writeUInt32LE((x[i]! + state[i]!) >>> 0, i * 4);
  return block;
}

function decryptWithMask(datagram: Buffer, mask: number): Buffer | null {
  const seed = datagram.readUInt32LE(0x40);
  const nonce = Buffer.allocUnsafe(8);
  nonce.writeUInt32LE((seed ^ mask) >>> 0, 0);
  nonce.writeUInt32LE(seed, 4);
  const output = Buffer.allocUnsafe(datagram.length);
  for (let offset = 0, counter = 0n; offset < datagram.length; offset += 64, counter++) {
    const stream = salsa20Block(nonce, counter);
    for (let i = 0; i < Math.min(64, datagram.length - offset); i++) output[offset + i] = datagram[offset + i]! ^ stream[i]!;
  }
  return output.readUInt32LE(0) === PACKET_MAGIC ? output : null;
}

export function decryptGT7Datagram(datagram: Buffer): Buffer | null {
  if (datagram.length < 296 || datagram.length > 368 || datagram.length < 0x44) return null;
  const preferred = PACKET_MASKS.get(datagram.length);
  const masks = [...new Set([preferred, 0xdeadbeaf, 0xdeadbeef, 0x55fabb4f].filter((v): v is number => v !== undefined))];
  for (const mask of masks) {
    const decoded = decryptWithMask(datagram, mask);
    if (decoded) return decoded;
  }
  return null;
}

export interface GT7ParserState {
  previousTimestampMs: number | null;
  lapStartTimestampMs: number | null;
  lapNumber: number | null;
  /** True after GT7's native current-lap timer starts for the current lap. */
  lapTimerActive?: boolean;
  distanceM: number;
  lapDistanceM: number;
  lastLapSampleDistanceM: number;
  lapBounds: [number, number, number, number] | null;
  lapPositions: [number, number][];
  trackId: string | null;
  carId: string | null;
  sessionType: "race" | "time-trial" | null;
}
const CHECKPOINT_MAGIC = 0x37544752;
const MAX_LAP_POSITION_SAMPLES = 1100;
const LAP_POSITION_SAMPLE_METERS = 20;

function captureParserCheckpoint(state: unknown): Uint8Array | null {
  if (!isGT7ParserState(state)) return null;
  const json = Buffer.from(JSON.stringify(state));
  const payload = Buffer.allocUnsafe(4 + json.length);
  payload.writeUInt32LE(CHECKPOINT_MAGIC, 0);
  json.copy(payload, 4);
  return payload;
}

function restoreParserCheckpoint(_state: unknown, payload: Uint8Array): GT7ParserState | null {
  if (payload.byteLength < 8 || payload.byteLength > 64 * 1024) return null;
  const bytes = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  if (bytes.readUInt32LE(0) !== CHECKPOINT_MAGIC) return null;
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8", 4));
    return isGT7ParserState(value) ? value : null;
  } catch {
    return null;
  }
}

function isGT7ParserState(value: unknown): value is GT7ParserState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as GT7ParserState;
  return (state.previousTimestampMs === null || (typeof state.previousTimestampMs === "number" && Number.isFinite(state.previousTimestampMs))) &&
    (state.lapStartTimestampMs === null || (typeof state.lapStartTimestampMs === "number" && Number.isFinite(state.lapStartTimestampMs))) &&
    (state.lapNumber === null || (Number.isInteger(state.lapNumber) && state.lapNumber > 0)) &&
    (state.lapTimerActive === undefined || typeof state.lapTimerActive === "boolean") &&
    Number.isFinite(state.distanceM) && state.distanceM >= 0 &&
    Number.isFinite(state.lapDistanceM) && state.lapDistanceM >= 0 &&
    Number.isFinite(state.lastLapSampleDistanceM) && state.lastLapSampleDistanceM >= 0 &&
    (state.lapBounds === null || (Array.isArray(state.lapBounds) && state.lapBounds.length === 4 && state.lapBounds.every(Number.isFinite))) &&
    Array.isArray(state.lapPositions) && state.lapPositions.length <= MAX_LAP_POSITION_SAMPLES &&
    state.lapPositions.every((point) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)) &&
    (state.trackId === null || typeof state.trackId === "string") &&
    (state.carId === null || typeof state.carId === "string") &&
    (state.sessionType === null || state.sessionType === "race" || state.sessionType === "time-trial");
}

function resetLapTrackSamples(state: GT7ParserState, positionX: number, positionZ: number): void {
  state.lapDistanceM = 0;
  state.lastLapSampleDistanceM = 0;
  state.lapBounds = [positionX, positionX, positionZ, positionZ];
  state.lapPositions = [[positionX, positionZ]];
}

function finiteFloat(packet: Buffer, offset: number): number {
  const value = packet.readFloatLE(offset);
  return Number.isFinite(value) ? value : 0;
}

function normalizeWheelGear(value: number): number {
  return value === 0 ? -1 : value === 15 ? 0 : value;
}

function parseGT7(buffer: Buffer, state: GT7ParserState, timestampMs = Date.now()): TelemetryPacket | null {
  const raw = decryptGT7Datagram(buffer);
  if (!raw) return null;
  const f = (offset: number) => finiteFloat(raw, offset);
  const speed = f(0x4c);
  const flags = raw.readUInt16LE(0x8e);
  const packetLapNumber = raw.readUInt16LE(0x74);
  const lapNumber = packetLapNumber === 0xffff ? 0 : Math.max(1, packetLapNumber);
  const packetLapTimeMs = raw.length >= 368 ? raw.readInt32LE(0x15c) : null;
  const carId = String(raw.readUInt32LE(0x124));
  const sessionType = raw.readUInt16LE(0x76) === 0 ? "time-trial" : "race";
  const positionX = f(0x04);
  const positionZ = f(0x0c);
  const active = (flags & 1) !== 0 && (flags & 6) === 0;
  const lapChanged = state.lapNumber !== null && state.lapNumber !== lapNumber;
  const sessionReset = (state.carId !== null && state.carId !== carId) ||
    (state.sessionType !== null && state.sessionType !== sessionType) ||
    (state.lapNumber !== null && lapNumber < state.lapNumber) || (flags & 4) !== 0;
  if (sessionReset) state.trackId = null;
  if (lapChanged && !sessionReset && state.lapBounds && state.lapPositions.length >= 20) {
    const [minX, maxX, minZ, maxZ] = state.lapBounds;
    const first = state.lapPositions[0]!;
    const last = state.lapPositions.at(-1)!;
    const closeEnough = Math.hypot(first[0] - last[0], first[1] - last[1]) <= Math.max(60, state.lapDistanceM * 0.05);
    if (!state.trackId && closeEnough) {
      state.trackId = identifyGT7Track({
        lengthM: state.lapDistanceM, minX, maxX, minZ, maxZ, points: state.lapPositions,
      });
    }
  }
  if (state.lapNumber !== lapNumber || state.lapStartTimestampMs === null) state.lapStartTimestampMs = timestampMs;
  if (lapChanged || sessionReset) state.lapTimerActive = false;
  const lapTimerStarting = !lapChanged && !sessionReset && active && !state.lapTimerActive &&
    packetLapTimeMs !== null && packetLapTimeMs > 0 && packetLapTimeMs <= 2_000;
  if (lapTimerStarting) state.lapTimerActive = true;
  const lapSamplingActive = packetLapTimeMs === null ? active : Boolean(state.lapTimerActive);
  if (lapChanged || sessionReset || lapTimerStarting || !state.lapBounds) resetLapTrackSamples(state, positionX, positionZ);
  if (state.previousTimestampMs !== null && timestampMs >= state.previousTimestampMs && timestampMs - state.previousTimestampMs < 1000) {
    const distanceDelta = Math.max(0, speed) * ((timestampMs - state.previousTimestampMs) / 1000);
    state.distanceM += distanceDelta;
    if (lapSamplingActive && !lapTimerStarting && !sessionReset && !lapChanged) state.lapDistanceM += distanceDelta;
  }
  if (lapSamplingActive && !sessionReset && !lapChanged && !lapTimerStarting && state.lapBounds) {
    state.lapBounds[0] = Math.min(state.lapBounds[0], positionX);
    state.lapBounds[1] = Math.max(state.lapBounds[1], positionX);
    state.lapBounds[2] = Math.min(state.lapBounds[2], positionZ);
    state.lapBounds[3] = Math.max(state.lapBounds[3], positionZ);
    if (state.lapPositions.length < MAX_LAP_POSITION_SAMPLES &&
        state.lapDistanceM - state.lastLapSampleDistanceM >= LAP_POSITION_SAMPLE_METERS) {
      state.lapPositions.push([positionX, positionZ]);
      state.lastLapSampleDistanceM = state.lapDistanceM;
    }
  }
  state.previousTimestampMs = timestampMs;
  state.lapNumber = lapNumber;
  state.carId = carId;
  state.sessionType = sessionType;
  const gearByte = raw[0x90]!;
  const suggestedGear = gearByte >>> 4;
  const gear = normalizeWheelGear(gearByte & 0x0f);
  const qx = f(0x1c), qy = f(0x20), qz = f(0x24), qw = f(0x28);
  const roll = Math.atan2(2 * (qw * qx + qy * qz), 1 - 2 * (qx * qx + qy * qy));
  const pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (qw * qy - qz * qx))));
  const yaw = Math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qy * qy + qz * qz));
  const wheelRotation = [0xa4, 0xa8, 0xac, 0xb0].map(f);
  const wheelRadius = [0xb4, 0xb8, 0xbc, 0xc0].map(f);
  const slip = wheelRotation.map((rotation, index) => speed < 1 ? 1 : Math.abs(rotation * wheelRadius[index]!) / speed);
  const suspension = [0xc4, 0xc8, 0xcc, 0xd0].map(f);
  const tireTemp = [0x60, 0x64, 0x68, 0x6c].map(f);
  const aids = ((flags & (1 << 11)) ? 1 : 0) | ((flags & (1 << 10)) ? 2 : 0) | ((flags & (1 << 6)) ? 4 : 0) | ((flags & (1 << 5)) ? 8 : 0);
  const carCategory = raw.length >= 368
    ? raw.toString("ascii", 0x16c, 0x170).split("\0", 1)[0]?.trim()
    : undefined;
  return {
    gameId: "gt7", carId, trackId: state.trackId ?? "unknown", gt7: {
      sessionType,
      ...(suggestedGear < 15 ? { suggestedGear: normalizeWheelGear(suggestedGear) } : {}), driverAids: aids,
      ...(carCategory ? { carCategory } : {}),
    },
    IsRaceOn: active ? 1 : 0,
    TimestampMS: timestampMs >>> 0,
    EngineMaxRpm: 0, EngineIdleRpm: 0, CurrentEngineRpm: f(0x3c),
    AccelerationX: 0, AccelerationY: 0, AccelerationZ: 0,
    VelocityX: f(0x10), VelocityY: f(0x14), VelocityZ: f(0x18),
    AngularVelocityX: f(0x2c), AngularVelocityY: f(0x30), AngularVelocityZ: f(0x34),
    Yaw: yaw, Pitch: pitch, Roll: roll,
    NormSuspensionTravelFL: 0, NormSuspensionTravelFR: 0, NormSuspensionTravelRL: 0, NormSuspensionTravelRR: 0,
    TireSlipRatioFL: slip[0]!, TireSlipRatioFR: slip[1]!, TireSlipRatioRL: slip[2]!, TireSlipRatioRR: slip[3]!,
    WheelRotationSpeedFL: wheelRotation[0]!, WheelRotationSpeedFR: wheelRotation[1]!, WheelRotationSpeedRL: wheelRotation[2]!, WheelRotationSpeedRR: wheelRotation[3]!,
    WheelOnRumbleStripFL: 0, WheelOnRumbleStripFR: 0, WheelOnRumbleStripRL: 0, WheelOnRumbleStripRR: 0,
    WheelInPuddleDepthFL: 0, WheelInPuddleDepthFR: 0, WheelInPuddleDepthRL: 0, WheelInPuddleDepthRR: 0,
    SurfaceRumbleFL_2: 0, SurfaceRumbleFR_2: 0, SurfaceRumbleRL_2: 0, SurfaceRumbleRR_2: 0, TireSlipCombinedFL_2: 0,
    TireTempFL: tireTemp[0]!, TireTempFR: tireTemp[1]!, TireTempRL: tireTemp[2]!, TireTempRR: tireTemp[3]!,
    Boost: f(0x50) - 1, Fuel: f(0x44), FuelCapacity: f(0x48), DistanceTraveled: state.distanceM,
    BestLap: Math.max(0, raw.readInt32LE(0x78)) / 1000, LastLap: Math.max(0, raw.readInt32LE(0x7c)) / 1000,
    CurrentLap: (() => {
      if (raw.length >= 368) {
        const packetLapMs = raw.readInt32LE(0x15c);
        if (packetLapMs >= 0 && packetLapMs <= 3_600_000) return packetLapMs / 1000;
      }
      return active && state.lapStartTimestampMs !== null
        ? Math.max(0, timestampMs - state.lapStartTimestampMs) / 1000
        : 0;
    })(),
    CurrentRaceTime: 0, LapNumber: lapNumber, RacePosition: raw.readInt16LE(0x84),
    Accel: raw.readUInt8(0x91), Brake: raw.readUInt8(0x92), Clutch: Math.max(0, Math.min(255, Math.round(f(0xf4) * 255))), HandBrake: aids & 4 ? 255 : 0,
    Gear: gear, Steer: 0, NormDrivingLine: 0, NormAIBrakeDiff: 0,
    TireWearFL: 0, TireWearFR: 0, TireWearRL: 0, TireWearRR: 0,
    SurfaceRumbleFL: 0, SurfaceRumbleFR: 0, SurfaceRumbleRL: 0, SurfaceRumbleRR: 0,
    TireSlipAngleFL: 0, TireSlipAngleFR: 0, TireSlipAngleRL: 0, TireSlipAngleRR: 0,
    TireCombinedSlipFL: 0, TireCombinedSlipFR: 0, TireCombinedSlipRL: 0, TireCombinedSlipRR: 0,
    SuspensionTravelMFL: suspension[0]!, SuspensionTravelMFR: suspension[1]!, SuspensionTravelMRL: suspension[2]!, SuspensionTravelMRR: suspension[3]!,
    CarClass: 0, CarPerformanceIndex: 0, DrivetrainType: 0, NumCylinders: 0,
    PositionX: f(0x04), PositionY: f(0x08), PositionZ: f(0x0c), Speed: speed, Power: 0, Torque: 0,
  };
}

export const gt7Parser: TelemetryParser<GT7ParserState> & {
  captureParserCheckpoint: typeof captureParserCheckpoint;
  restoreParserCheckpoint: typeof restoreParserCheckpoint;
} = {
  canHandle: buffer => PACKET_MASKS.has(buffer.length) && decryptGT7Datagram(buffer) !== null,
  tryParse(buffer, state, timestampMs) { return parseGT7(buffer, state, timestampMs); },
  tryParseLapIndex(buffer, state, timestampMs): LapIndexPacket | null { return parseGT7(buffer, state, timestampMs) as LapIndexPacket | null; },
  primeParserState(buffer, state) { if (state) parseGT7(buffer, state); },
  createParserState: () => ({
    previousTimestampMs: null, lapStartTimestampMs: null, lapNumber: null, lapTimerActive: false, distanceM: 0,
    lapDistanceM: 0, lastLapSampleDistanceM: 0, lapBounds: null, lapPositions: [],
    trackId: null, carId: null, sessionType: null,
  }),
  captureParserCheckpoint,
  restoreParserCheckpoint,
};
