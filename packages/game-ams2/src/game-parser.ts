import type { TelemetryParser } from "@raceiq/shared/telemetry/parser";
import { AMS2_LAYOUT as L } from "./layout";
import { decodeAMS2Frame } from "./frame";
import { isAMS2StaleSessionTransition } from "./session-transition";
import { normalizeAMS2Frame } from "./normalizer";

export interface AMS2ParserState { sessionState: number | null; epoch: number | null }

const CHECKPOINT_EMPTY = 0;
const CHECKPOINT_SESSION = 1;
const LEGACY_CHECKPOINT_BYTES = 5;
const CHECKPOINT_BYTES = 9;

function eligibleDrivingFrame(buffer: Buffer, state: AMS2ParserState) {
  const frame = decodeAMS2Frame(buffer);
  if (!frame || ![2, 3, 4].includes(frame.memory.readUInt32LE(8))) return null;
  const memory = frame.memory;
  const sessionState = memory.readUInt32LE(L.mSessionState);
  const previousSessionState = state.epoch !== null && state.epoch !== frame.epoch ? null : state.sessionState;
  if (isAMS2StaleSessionTransition(previousSessionState, sessionState, memory.readUInt32LE(L.mRaceState))) return null;
  return { memory, sessionState, epoch: frame.epoch };
}

function parseDrivingFrame(buffer: Buffer, state: AMS2ParserState) {
  const candidate = eligibleDrivingFrame(buffer, state);
  if (!candidate) return null;
  const packet = normalizeAMS2Frame(buffer);
  if (packet) {
    state.sessionState = candidate.sessionState;
    state.epoch = candidate.epoch;
  }
  return packet;
}

function hasTrimmedCString(memory: Buffer, offset: number): boolean {
  let start = offset;
  while (start < offset + 64 && (memory[start] === 0x20 || memory[start] === 0x09 || memory[start] === 0x0a || memory[start] === 0x0d)) start++;
  return start < offset + 64 && memory[start] !== 0;
}

function canNormalize(memory: Buffer): boolean {
  const version = memory.readUInt32LE(L.mVersion);
  const viewed = memory.readInt32LE(L.mViewedParticipantIndex);
  const count = memory.readInt32LE(L.mNumParticipants);
  return version >= 8 && version <= 14 && count >= 1 && count <= 64 && viewed >= 0 && viewed < count &&
    hasTrimmedCString(memory, L.mCarName) &&
    (hasTrimmedCString(memory, L.mTrackLocation) || hasTrimmedCString(memory, L.mTrackVariation)) &&
    Number.isFinite(memory.readFloatLE(L.mTrackLength)) && memory.readFloatLE(L.mTrackLength) > 0;
}

function primeParserState(buffer: Buffer, state: AMS2ParserState): void {
  const candidate = eligibleDrivingFrame(buffer, state);
  if (candidate && canNormalize(candidate.memory)) {
    state.sessionState = candidate.sessionState;
    state.epoch = candidate.epoch;
  }
}

function captureParserCheckpoint(state: unknown): Uint8Array | null {
  if (!isAMS2ParserState(state)) return null;
  const payload = new Uint8Array(state.epoch === null ? LEGACY_CHECKPOINT_BYTES : CHECKPOINT_BYTES);
  payload[0] = state.sessionState === null ? CHECKPOINT_EMPTY : CHECKPOINT_SESSION;
  const view = new DataView(payload.buffer);
  if (state.sessionState !== null) view.setUint32(1, state.sessionState, true);
  if (state.epoch !== null) view.setUint32(5, state.epoch, true);
  return payload;
}

function restoreParserCheckpoint(_state: unknown, payload: Uint8Array): AMS2ParserState | null {
  // Preserve frame-local and session-only checkpoints from existing recordings.
  if (payload.length === 0) return { sessionState: null, epoch: null };
  if ((payload.length !== LEGACY_CHECKPOINT_BYTES && payload.length !== CHECKPOINT_BYTES) ||
      (payload[0] !== CHECKPOINT_EMPTY && payload[0] !== CHECKPOINT_SESSION)) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const value = view.getUint32(1, true);
  if (payload[0] === CHECKPOINT_EMPTY) return value === 0 && payload.length === LEGACY_CHECKPOINT_BYTES
    ? { sessionState: null, epoch: null } : null;
  return { sessionState: value, epoch: payload.length === CHECKPOINT_BYTES ? view.getUint32(5, true) : null };
}

function isNullableUint32(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff);
}

function isAMS2ParserState(state: unknown): state is AMS2ParserState {
  return typeof state === "object" && state !== null &&
    isNullableUint32((state as AMS2ParserState).sessionState) &&
    isNullableUint32((state as AMS2ParserState).epoch) &&
    ((state as AMS2ParserState).sessionState !== null || (state as AMS2ParserState).epoch === null);
}

export const ams2Parser: TelemetryParser<AMS2ParserState> & {
  captureParserCheckpoint: typeof captureParserCheckpoint;
  restoreParserCheckpoint: typeof restoreParserCheckpoint;
} = {
  canHandle: buffer => decodeAMS2Frame(buffer) !== null,
  tryParse: parseDrivingFrame,
  tryParseLapIndex: parseDrivingFrame,
  primeParserState,
  createParserState: () => ({ sessionState: null, epoch: null }),
  captureParserCheckpoint,
  restoreParserCheckpoint,
};

